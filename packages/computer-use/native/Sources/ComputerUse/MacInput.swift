import AppKit
import ApplicationServices
import Carbon

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
    private var heldPointer: (pid: pid_t, point: CGPoint, windowID: CGWindowID, frame: CGRect, flags: CGEventFlags)?
    private struct DispatchFeedback {
        let action: String
        let frame: CGRect
        let send: (InputFeedback) -> Void
        var didDispatch = false
        var uncertain = false
        var point: CGPoint?
        var lastTypedAt: TimeInterval = -.infinity
    }
    private var feedback: DispatchFeedback?

    func releaseAll(interrupted: Bool = true) {
        if let heldPointer { try? mouse(.leftMouseUp, heldPointer.point, heldPointer.pid, 1, heldPointer.windowID, heldPointer.frame, heldPointer.flags) }
        heldPointer = nil
        if interrupted { report(.uncertain) }
    }
    private func report(_ phase: InputFeedback.Phase, point: CGPoint? = nil) {
        guard var context = feedback else { return }
        if phase == .uncertain {
            guard context.didDispatch, !context.uncertain else { return }
            context.uncertain = true
        } else {
            context.didDispatch = true
            context.point = point
        }
        let now = ProcessInfo.processInfo.systemUptime
        // Unicode typing can emit thousands of event pairs. Report real dispatch
        // at most five times/second, without leaking characters or key values.
        if context.action == "type" && phase != .uncertain {
            guard now - context.lastTypedAt >= 0.2 else { feedback = context; return }
            context.lastTypedAt = now
        }
        feedback = context
        context.send(InputFeedback(action: context.action, phase: phase, screenPoint: context.point, frame: context.frame))
    }
    func execute(_ action: Action, app: AppIdentity, target: WindowTarget, lease: ObservationLease,
                 access: MacAccessibility, records: [ElementRecord], focus: ElementRecord?, pointerTarget: AXUIElement?,
                 check: () throws -> Void, checkWindow: () throws -> Void,
                 feedback send: @escaping (InputFeedback) -> Void = { _ in }) async throws -> String {
        feedback = DispatchFeedback(action: action.name, frame: lease.frame, send: send)
        var finished = false
        defer {
            if !finished { releaseAll() }
            feedback = nil
        }
        do {
            try check(); try checkWindow(); try check()
            var path = "targeted_input"
            switch action {
            case .press(let ref), .setValue(let ref, _):
                guard let record = records.first(where: { $0.ref == ref }) else { throw UseError("unknown_ref", "Use an element ref from the current observation.", next: "observe") }
                try access.validateRecord(record, target: target)
                let result: AXError
                if case .setValue(_, let text) = action {
                    guard record.settable, try access.valueSettable(record.element) else {
                        throw UseError("unsupported_action", "This control does not support setting a value.", next: "observe")
                    }
                    try check()
                    result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, text as CFString)
                } else {
                    guard record.actions.contains(kAXPressAction) else { throw UseError("unsupported_action", "This control has no accessible press action.", next: "observe") }
                    try check()
                    result = AXUIElementPerformAction(record.element, kAXPressAction as CFString)
                }
                feedback?.didDispatch = true; feedback?.point = CGPoint(x: record.frame.midX, y: record.frame.midY)
                guard result == .success else { throw UseError("action_failed", "The app did not confirm the accessible action. Observe before retrying.", next: "observe") }
                report(.dispatched, point: CGPoint(x: record.frame.midX, y: record.frame.midY))
                path = "accessibility"
            case .wait(let ms):
                var remaining = ms
                while remaining > 0 {
                    try check()
                    let slice = min(remaining, 50)
                    try await Task.sleep(nanoseconds: UInt64(slice) * 1_000_000)
                    remaining -= slice
                }
                path = "waited"
            case .move(let point):
                let screen = try lease.screenPoint(point)
                try access.checkHit(screen, target: target, app: app, expected: pointerTarget)
                try mouse(.mouseMoved, screen, app.pid, 0, target.id, lease.frame, check: check)
            case .click(let point, let count, let flags):
                let screen = try lease.screenPoint(point)
                let hit = try access.checkHit(screen, target: target, app: app, expected: pointerTarget)
                for click in 1...count {
                    try check(); try checkWindow()
                    try access.checkHit(screen, target: target, app: app, expected: hit)
                    try mouse(.leftMouseDown, screen, app.pid, click, target.id, lease.frame, flags, check: check)
                    try mouse(.leftMouseUp, screen, app.pid, click, target.id, lease.frame, flags)
                    try check()
                    if click < count { try await Task.sleep(nanoseconds: 70_000_000) }
                }
            case .scroll(let point, let dx, let dy):
                let screen = try lease.screenPoint(point)
                try access.checkHit(screen, target: target, app: app, expected: pointerTarget)
                guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
                    throw UseError("input_failed", "Could not create a scroll event.")
                }
                event.location = screen
                event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.id))
                event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.id))
                try check()
                post(event, app.pid)
                report(.dispatched, point: screen)
            case .key(let key, let flags):
                try access.checkFocus(focus, target: target, app: app, requireField: ["backspace", "delete"].contains(key))
                let code = try keyCode(key, flags: flags)
                try keyboard(code, flags: flags, text: nil, pid: app.pid, check: check)
            case .type(let text):
                try await InputDispatch.type(text, check: check, validate: {
                    try checkWindow()
                    try access.checkFocus(focus, target: target, app: app, requireField: true)
                }, send: { chunk in
                    try self.keyboard(0, flags: [], text: chunk, pid: app.pid, check: check)
                })
            case .drag(let points):
                let points = try points.map(lease.screenPoint)
                for point in points {
                    try check(); try access.checkHit(point, target: target, app: app)
                    await Task.yield()
                }
                guard let first = points.first else { throw UseError("invalid_arguments", "Drag path is empty.") }
                try check(); try checkWindow()
                try access.checkHit(first, target: target, app: app, expected: pointerTarget)
                try mouse(.leftMouseDown, first, app.pid, 1, target.id, lease.frame, check: check)
                defer { releaseAll(interrupted: false) }
                for point in points.dropFirst() {
                    try await Task.sleep(nanoseconds: 20_000_000)
                    try check(); try checkWindow()
                    try access.checkHit(point, target: target, app: app)
                    try mouse(.leftMouseDragged, point, app.pid, 1, target.id, lease.frame, check: check)
                }
            }
            try check()
            finished = true
            return path
        } catch {
            let cause = (error as? UseError) ?? UseError("action_interrupted", "Input was interrupted. Do not repeat it without inspecting the result.", next: "human_takeover")
            throw InputFailure(cause: cause, mayHaveActed: feedback?.didDispatch == true)
        }
    }
    private func post(_ event: CGEvent, _ pid: pid_t) {
        event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(ProcessInfo.processInfo.processIdentifier))
        event.postToPid(pid)
    }
    private func mouse(_ type: CGEventType, _ point: CGPoint, _ pid: pid_t, _ count: Int, _ windowID: CGWindowID, _ frame: CGRect, _ flags: CGEventFlags = [], check: () throws -> Void = {}) throws {
        guard let setWindowLocation = Self.setWindowLocation else {
            throw UseError("unsupported_pointer_input", "This macOS version does not support scoped pointer input. Use accessible app controls instead.", next: "human_takeover")
        }
        let eventType: NSEvent.EventType
        switch type {
        case .mouseMoved: eventType = .mouseMoved
        case .leftMouseDown: eventType = .leftMouseDown
        case .leftMouseUp: eventType = .leftMouseUp
        case .leftMouseDragged: eventType = .leftMouseDragged
        default: throw UseError("input_failed", "Unsupported pointer event.")
        }
        let location = NSPoint(x: point.x - frame.minX, y: frame.maxY - point.y)
        var modifiers = NSEvent.ModifierFlags()
        if flags.contains(.maskCommand) { modifiers.insert(.command) }
        if flags.contains(.maskShift) { modifiers.insert(.shift) }
        if flags.contains(.maskAlternate) { modifiers.insert(.option) }
        if flags.contains(.maskControl) { modifiers.insert(.control) }
        guard let native = NSEvent.mouseEvent(with: eventType, location: location, modifierFlags: modifiers,
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(windowID), context: nil,
                eventNumber: 0, clickCount: count, pressure: type == .leftMouseUp || type == .mouseMoved ? 0 : 1),
              let event = native.cgEvent?.copy() else {
            throw UseError("input_failed", "Could not create a window-targeted mouse event.")
        }
        event.location = point
        event.flags = flags
        setWindowLocation(event, CGPoint(x: point.x - frame.minX, y: point.y - frame.minY))
        event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        if type != .leftMouseUp { try Task.checkCancellation(); try check() }
        post(event, pid)
        if type == .leftMouseDown || type == .leftMouseDragged { heldPointer = (pid, point, windowID, frame, flags) }
        if type == .leftMouseUp { heldPointer = nil }
        report(type == .leftMouseDown ? .down : type == .leftMouseUp ? .up : .move, point: point)
    }
    private func keyCode(_ key: String, flags: CGEventFlags) throws -> CGKeyCode {
        if let code = NativeKey.navigation[key] { return code }
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else {
            throw UseError("unsupported_keyboard_layout", "This keyboard layout cannot safely resolve a named shortcut.", next: "observe")
        }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
        guard CFDataGetLength(data) >= MemoryLayout<UCKeyboardLayout>.size, let bytes = CFDataGetBytePtr(data) else {
            throw UseError("unsupported_keyboard_layout", "The keyboard layout data is unavailable.", next: "observe")
        }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        var modifiers: UInt32 = 0
        if flags.contains(.maskCommand) { modifiers |= UInt32(cmdKey) >> 8 }
        if flags.contains(.maskShift) { modifiers |= UInt32(shiftKey) >> 8 }
        if flags.contains(.maskAlternate) { modifiers |= UInt32(optionKey) >> 8 }
        for code in UInt16(0)..<128 {
            var deadKey: UInt32 = 0
            var count = 0
            var characters = [UniChar](repeating: 0, count: 4)
            let result = characters.withUnsafeMutableBufferPointer { buffer in
                UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), modifiers, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKey, buffer.count, &count, buffer.baseAddress!)
            }
            if result == noErr, count > 0, count <= characters.count,
               String(decoding: characters.prefix(Int(count)), as: UTF16.self).lowercased() == key { return code }
        }
        throw UseError("unsupported_keyboard_layout", "The named shortcut is unavailable in this keyboard layout.", next: "observe")
    }
    private func keyboard(_ code: CGKeyCode, flags: CGEventFlags, text: String?, pid: pid_t, check: () throws -> Void) throws {
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
        try InputDispatch.pair(check: check, down: {
            self.post(down, pid)
            self.feedback?.didDispatch = true
            if text == nil { self.report(.down) }
        }, up: {
            self.post(up, pid)
            self.report(text == nil ? .up : .dispatched)
        })
    }
}
