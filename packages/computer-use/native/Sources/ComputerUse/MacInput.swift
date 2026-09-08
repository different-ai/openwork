import AppKit
import ApplicationServices

@MainActor
final class MacInput {
    private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    // AppKit-targeted events carry a second, window-local point. On recent
    // macOS, setting only the public screen location leaves that point invalid.
    // Keep this compatibility hook isolated and fail before input if unavailable.
    private static let setWindowLocation: SetWindowLocation? = {
        guard let library = dlopen(nil, RTLD_LAZY) else { return nil }
        defer { dlclose(library) }
        guard let symbol = dlsym(library, "CGEventSetWindowLocation") else { return nil }
        return unsafeBitCast(symbol, to: SetWindowLocation.self)
    }()
    private var heldPointer: (pid: pid_t, point: CGPoint, windowID: CGWindowID, frame: CGRect)?
    func releaseAll() {
        if let heldPointer { try? mouse(.leftMouseUp, heldPointer.point, heldPointer.pid, 1, heldPointer.windowID, heldPointer.frame) }
        heldPointer = nil
    }
    // The input backend accepts a pinned process, never a frontmost-app default.
    // Every individual event rechecks the live session, including drag and Unicode typing.
    func execute(_ action: Action, app: AppIdentity, target: WindowTarget, lease: ObservationLease,
                 access: MacAccessibility, records: [ElementRecord], check: () throws -> Void) async throws -> String {
        try check()
        switch action {
        case .press(let ref), .setValue(let ref, _):
            guard let record = records.first(where: { $0.ref == ref }) else { throw UseError("unknown_ref", "Use an element ref from the current observation.", next: "observe") }
            try access.validateRecord(record, target: target)
            if case .setValue(_, let text) = action {
                var settable = DarwinBoolean(false)
                guard record.settable,
                      AXUIElementIsAttributeSettable(record.element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
                    throw UseError("unsupported_action", "This control does not support setting a value. Choose another explicit action.", next: "observe")
                }
                guard AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, text as CFString) == .success else {
                    throw UseError("action_failed", "The app did not accept the value. Observe before retrying.", next: "observe")
                }
            } else {
                guard record.actions.contains(kAXPressAction) else { throw UseError("unsupported_action", "This control has no accessible press action. Use an explicitly approved visual session.", next: "open_session") }
                guard AXUIElementPerformAction(record.element, kAXPressAction as CFString) == .success else {
                    throw UseError("action_failed", "The app did not accept the press. Observe before retrying.", next: "observe")
                }
            }
            return "accessibility"
        case .click(let point, let count):
            let screen = try lease.screenPoint(point)
            try access.checkHit(screen, target: target, app: app)
            for click in 1...count {
                try check()
                try mouse(.leftMouseDown, screen, app.pid, click, target.id, lease.frame)
                // Always release a dispatched press, including cancellation.
                try mouse(.leftMouseUp, screen, app.pid, click, target.id, lease.frame)
                if click < count { try await Task.sleep(nanoseconds: 70_000_000) }
            }
        case .scroll(let point, let dx, let dy):
            let screen = try lease.screenPoint(point)
            try access.checkHit(screen, target: target, app: app)
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
                throw UseError("input_failed", "Could not create a scroll event.")
            }
            event.location = screen
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.id))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.id))
            post(event, app.pid)
        case .key(let key):
            try access.checkFocusedField(target: target, app: app)
            let code: CGKeyCode
            let flags: CGEventFlags
            switch key {
            case "select_all": code = 0; flags = .maskCommand
            case "undo": code = 6; flags = .maskCommand
            case "redo": code = 6; flags = [.maskCommand, .maskShift]
            default:
                guard let mapped = NativeKey.codes[key] else { throw UseError("unsupported_key", "Unknown key.") }
                code = mapped; flags = []
            }
            try keyboard(code, flags: flags, text: nil, pid: app.pid)
        case .type(let text):
            try access.checkFocusedField(target: target, app: app)
            // Chunk by grapheme; never split UTF-16 surrogate pairs or use the shared clipboard.
            for character in text {
                try check()
                try access.checkFocusedField(target: target, app: app)
                try keyboard(0, flags: [], text: String(character), pid: app.pid)
                await Task.yield()
            }
        case .drag(let points):
            let path = try points.map(lease.screenPoint)
            // Validate all waypoints before pressing; recheck hit testing while dragging.
            for point in path { try access.checkHit(point, target: target, app: app) }
            guard let first = path.first else { throw UseError("invalid_arguments", "Drag path is empty.") }
            try mouse(.leftMouseDown, first, app.pid, 1, target.id, lease.frame)
            defer { releaseAll() }
            for point in path.dropFirst() {
                try await Task.sleep(nanoseconds: 20_000_000)
                try check()
                try access.checkHit(point, target: target, app: app)
                try mouse(.leftMouseDragged, point, app.pid, 1, target.id, lease.frame)
            }
        }
        return "targeted_input"
    }
    private func post(_ event: CGEvent, _ pid: pid_t) {
        event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(ProcessInfo.processInfo.processIdentifier))
        event.postToPid(pid)
    }
    private func mouse(_ type: CGEventType, _ point: CGPoint, _ pid: pid_t, _ count: Int, _ windowID: CGWindowID, _ frame: CGRect) throws {
        guard let setWindowLocation = Self.setWindowLocation else {
            throw UseError("unsupported_pointer_input", "This macOS version does not support scoped pointer input. Use accessible app controls instead.", next: "human_takeover")
        }
        let eventType: NSEvent.EventType
        switch type {
        case .leftMouseDown: eventType = .leftMouseDown
        case .leftMouseUp: eventType = .leftMouseUp
        case .leftMouseDragged: eventType = .leftMouseDragged
        default: throw UseError("input_failed", "Unsupported pointer event.")
        }
        let location = NSPoint(x: point.x - frame.minX, y: frame.maxY - point.y)
        guard let native = NSEvent.mouseEvent(with: eventType, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(windowID), context: nil,
                eventNumber: 0, clickCount: count, pressure: type == .leftMouseUp ? 0 : 1),
              let event = native.cgEvent?.copy() else {
            throw UseError("input_failed", "Could not create a window-targeted mouse event.")
        }
        event.location = point
        setWindowLocation(event, CGPoint(x: point.x - frame.minX, y: point.y - frame.minY))
        event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        post(event, pid)
        if type == .leftMouseDown || type == .leftMouseDragged { heldPointer = (pid, point, windowID, frame) }
        if type == .leftMouseUp { heldPointer = nil }
    }
    private func keyboard(_ code: CGKeyCode, flags: CGEventFlags, text: String?, pid: pid_t) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw UseError("input_failed", "Could not create a keyboard event.")
        }
        down.flags = flags; up.flags = flags
        if let text {
            let units = Array(text.utf16)
            units.withUnsafeBufferPointer { buffer in
                if let base = buffer.baseAddress {
                    down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
                    up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
                }
            }
        }
        post(down, pid); post(up, pid)
    }
}
