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
    private typealias GetWindowLocation = @convention(c) (CGEvent) -> CGPoint
    private static let windowLocation: GetWindowLocation? = {
        guard let library = dlopen(nil, RTLD_LAZY) else { return nil }
        defer { dlclose(library) }
        guard let symbol = dlsym(library, "CGEventGetWindowLocation") else { return nil }
        return unsafeBitCast(symbol, to: GetWindowLocation.self)
    }()
    private typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    // SkyLight's post runs WindowServer's activity monitoring, which Chromium,
    // Electron and Catalyst require before they treat input as live. AppKit
    // reads the public post; each event is posted once, by one route.
    private static let skyLightPost: PostToPid? = {
        guard let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
              let symbol = dlsym(library, "SLEventPostToPid") else { return nil }
        return unsafeBitCast(symbol, to: PostToPid.self)
    }()
    // AppKit routes a pointer event to a window by this field. NSEvent's mouse
    // events set it; scroll events have no NSEvent factory, so set it the same
    // way and read every event back before posting it.
    private static let windowNumberField = CGEventField(rawValue: 51)
    private static let gestureField = CGEventField(rawValue: 58)
    private static let modifierKeys: [(flag: CGEventFlags, code: CGKeyCode)] = [
        (.maskCommand, 55), (.maskShift, 56), (.maskAlternate, 58), (.maskControl, 59)]
    private var heldPointer: (pid: pid_t, point: CGPoint, windowID: CGWindowID, frame: CGRect, flags: CGEventFlags)?
    private var heldModifiers: (pid: pid_t, flags: CGEventFlags)?
    private var lastPointer: (pid: pid_t, windowID: CGWindowID, point: CGPoint)?
    private var routes: [pid_t: PointerRoute] = [:]
    /// The current step runs in the background, so keys to Chromium-class apps are signed.
    private var signsKeys = false
    // One gesture's events share a group so the app coalesces them as one.
    private var gesture: Int64 = 0
    private struct DispatchFeedback {
        let action: String
        let frame: CGRect
        let send: (InputFeedback) -> Void
        var didDispatch = false
        var uncertain = false
        var point: CGPoint?
        var lastTypedAt: TimeInterval = -.infinity
        var lastMovedAt: TimeInterval = -.infinity
    }
    private var feedback: DispatchFeedback?
    /// The last menu command pressed, for the on-desktop cursor to replay.
    private(set) var lastMenu: (titleFrame: CGRect?, path: [String], shortcut: String?)?

    func releaseAll(interrupted: Bool = true) {
        if let heldPointer { try? mouse(.leftMouseUp, heldPointer.point, heldPointer.pid, 1, heldPointer.windowID, heldPointer.frame, heldPointer.flags) }
        heldPointer = nil
        releaseModifiers()
        if interrupted { report(.uncertain) }
    }
    private func report(_ phase: InputFeedback.Phase, point: CGPoint? = nil, force: Bool = false) {
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
        // A drag or hover path is many small moves; the cursor needs ~30 a second.
        if phase == .move && !force {
            guard now - context.lastMovedAt >= 0.033 else { feedback = context; return }
            context.lastMovedAt = now
        }
        feedback = context
        context.send(InputFeedback(action: context.action, phase: phase, screenPoint: context.point, frame: context.frame))
    }
    func execute(_ action: Action, app: AppIdentity, target: WindowTarget, lease: ObservationLease,
                 access: MacAccessibility, records: [ElementRecord], focus: ElementRecord?, pointerTarget: AXUIElement?,
                 check: () throws -> Void, checkWindow: () throws -> Void, background: Bool = false,
                 feedback send: @escaping (InputFeedback) -> Void = { _ in }) async throws -> String {
        feedback = DispatchFeedback(action: action.name, frame: lease.frame, send: send)
        gesture = Int64(UInt32.random(in: 1...UInt32.max))
        _ = route(for: app)
        signsKeys = background
        var finished = false
        defer {
            if !finished { releaseAll() }
            feedback = nil
            signsKeys = false
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
                // A press that opens a modal (a close button's save sheet) keeps the app busy
                // past the AX timeout: it was delivered, only its reply is missing.
                var unanswered = false
                if case .press = action { unanswered = result == .cannotComplete }
                guard result == .success || unanswered else { throw UseError("action_failed", "The app did not confirm the accessible action. Observe before retrying.", next: "observe") }
                report(.dispatched, point: CGPoint(x: record.frame.midX, y: record.frame.midY))
                path = unanswered ? "accessibility_unconfirmed" : "accessibility"
            case .menu(let names):
                // Menu commands go to the app's focused window: never to another document.
                guard access.isFocusedWindow(target, app: app) else {
                    throw UseError("menu_needs_focus", "This app's menus act on another of its windows. Bring the selected window forward, then try again.", next: "observe")
                }
                let menu = try access.menuTarget(names, app: app)
                try check()
                let result = AXUIElementPerformAction(menu.item, kAXPressAction as CFString)
                let aim = menu.titleFrame.map { CGPoint(x: $0.midX, y: $0.midY) }
                feedback?.didDispatch = true; feedback?.point = aim
                // A command that opens a modal answers after the AX timeout: it was delivered.
                guard result == .success || result == .cannotComplete else {
                    throw UseError("action_failed", "The app did not accept the menu command. Observe before retrying.", next: "observe")
                }
                report(.dispatched, point: aim)
                lastMenu = (menu.titleFrame, names, menu.shortcut)
                path = result == .success ? "accessibility" : "accessibility_unconfirmed"
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
                try access.checkHit(screen, target: target, app: app, expected: pointerTarget, background: background)
                // Hover menus and tracking areas respond to the pointer arriving, not appearing.
                var steps = [screen]
                if let last = lastPointer, last.pid == app.pid, last.windowID == target.id, lease.frame.contains(last.point) {
                    steps = PointerMotion.path([last.point, screen], maxStep: 24, maxEvents: 8)
                }
                for step in steps {
                    try check(); try checkWindow()
                    try mouse(.mouseMoved, step, app.pid, 0, target.id, lease.frame, check: check)
                    if step != screen { try await Task.sleep(nanoseconds: PointerMotion.step) }
                }
                report(.move, point: screen, force: true)
            case .click(let point, let count, let flags):
                let screen = try lease.screenPoint(point)
                let hit = try access.checkHit(screen, target: target, app: app, expected: pointerTarget, background: background)
                try modifiers(flags, pid: app.pid, check: check)
                try await InputDispatch.press(clicks: count, check: check, validate: {
                    try checkWindow()
                    try access.checkHit(screen, target: target, app: app, expected: hit, background: background)
                }, move: {
                    try self.mouse(.mouseMoved, screen, app.pid, 0, target.id, lease.frame, flags, check: check)
                }, down: { click in
                    if click == 1, background { try self.primeUserActivation(app.pid, target.id, lease.frame, check: check) }
                    try self.mouse(.leftMouseDown, screen, app.pid, click, target.id, lease.frame, flags, check: check)
                }, up: { click in
                    try self.mouse(.leftMouseUp, screen, app.pid, click, target.id, lease.frame, flags)
                })
                releaseModifiers()
            case .scroll(let point, let dx, let dy):
                let screen = try lease.screenPoint(point)
                try access.checkHit(screen, target: target, app: app, expected: pointerTarget, background: background)
                // Views scroll what is under the pointer: put it there, then scroll in steps.
                try mouse(.mouseMoved, screen, app.pid, 0, target.id, lease.frame, check: check)
                for (index, step) in PointerMotion.scrollSteps(dx: dx, dy: dy).enumerated() {
                    if index > 0 { try await Task.sleep(nanoseconds: PointerMotion.scrollStep) }
                    try check(); try checkWindow()
                    try scroll(screen, dx: step.dx, dy: step.dy, pid: app.pid, windowID: target.id, frame: lease.frame)
                }
                report(.dispatched, point: screen)
            case .key(let key, let flags):
                try access.checkFocus(focus, target: target, app: app, requireField: ["backspace", "delete"].contains(key), requireFront: !background)
                let code = try keyCode(key, flags: flags)
                try modifiers(flags, pid: app.pid, check: check)
                try keyboard(code, flags: flags, text: nil, pid: app.pid, check: check)
                releaseModifiers()
            case .type(let text):
                try await InputDispatch.type(text, check: check, validate: {
                    try checkWindow()
                    try access.checkFocus(focus, target: target, app: app, requireField: true, requireFront: !background)
                }, send: { character in
                    // Line breaks and tabs stay text: as real Return or Tab keys they could
                    // submit or move focus mid-text, which only a separate key action may do.
                    try self.keyboard(0, flags: [], text: character, pid: app.pid, check: check)
                })
            case .drag(let points):
                let points = try points.map(lease.screenPoint)
                for point in points {
                    try check(); try access.checkHit(point, target: target, app: app, background: background)
                    await Task.yield()
                }
                guard let first = points.first else { throw UseError("invalid_arguments", "Drag path is empty.") }
                // Apps start a drag only after the pointer travels past a threshold
                // and drop only onto a target they have seen it hover over.
                try await InputDispatch.drag(from: first, through: PointerMotion.path(points), check: check, validate: { point in
                    try checkWindow()
                    if point == first {
                        try access.checkHit(point, target: target, app: app, expected: pointerTarget, background: background)
                    } else if points.contains(point) {
                        try access.checkHit(point, target: target, app: app, background: background)
                    }
                }, move: { point in
                    try self.mouse(.mouseMoved, point, app.pid, 0, target.id, lease.frame, check: check)
                }, down: { point in
                    try self.mouse(.leftMouseDown, point, app.pid, 1, target.id, lease.frame, check: check)
                }, drag: { point in
                    try self.mouse(.leftMouseDragged, point, app.pid, 1, target.id, lease.frame, check: check)
                }, up: { point in
                    try self.mouse(.leftMouseUp, point, app.pid, 1, target.id, lease.frame)
                })
            }
            try check()
            finished = true
            return path
        } catch {
            let cause = (error as? UseError) ?? UseError("action_interrupted", "Input was interrupted. Do not repeat it without inspecting the result.", next: "human_takeover")
            throw InputFailure(cause: cause, mayHaveActed: feedback?.didDispatch == true)
        }
    }
    func route(for app: AppIdentity) -> PointerRoute {
        if let route = routes[app.pid] { return route }
        let route = PointerRoute.classify(bundleID: app.bundleID, info: app.app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:])
        routes[app.pid] = route
        return route
    }
    /// Chromium acts on a background click only after a recent user gesture. A
    /// press outside every window advances that gate and is itself discarded.
    private func primeUserActivation(_ pid: pid_t, _ windowID: CGWindowID, _ frame: CGRect, check: () throws -> Void) throws {
        guard routes[pid] == .skyLight else { return }
        let outside = CGPoint(x: -1, y: -1)
        try mouse(.leftMouseDown, outside, pid, 1, windowID, frame, check: check, quiet: true)
        try mouse(.leftMouseUp, outside, pid, 1, windowID, frame, quiet: true)
    }
    private func post(_ event: CGEvent, _ pid: pid_t, pointer: Bool = false) {
        event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(ProcessInfo.processInfo.processIdentifier))
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        if pointer, routes[pid] == .skyLight, let skyLightPost = Self.skyLightPost {
            skyLightPost(pid, event)
        } else if !pointer, signsKeys, routes[pid] == .skyLight, let skyLightPost = Self.skyLightPost, KeyAuthentication.attach(event, pid: pid) {
            // A background key reaches these apps only signed and through SkyLight.
            skyLightPost(pid, event)
        } else {
            event.postToPid(pid)
        }
    }
    /// `quiet` posts the event without tracking or showing it, for presses no person should see.
    private func mouse(_ type: CGEventType, _ point: CGPoint, _ pid: pid_t, _ count: Int, _ windowID: CGWindowID, _ frame: CGRect, _ flags: CGEventFlags = [], check: () throws -> Void = {}, quiet: Bool = false) throws {
        let event = try Self.pointerEvent(type, point, count: count, windowID: windowID, frame: frame, flags: flags)
        if let gestureField = Self.gestureField { event.setIntegerValueField(gestureField, value: gesture) }
        if type == .mouseMoved || type == .leftMouseDragged, let last = lastPointer, last.pid == pid, last.windowID == windowID {
            // Canvases and games read relative motion from these fields.
            event.setIntegerValueField(.mouseEventDeltaX, value: Int64((point.x - last.point.x).rounded()))
            event.setIntegerValueField(.mouseEventDeltaY, value: Int64((point.y - last.point.y).rounded()))
        }
        try Self.verifyTargeted(event, point, windowID: windowID, frame: frame)
        if type != .leftMouseUp { try Task.checkCancellation(); try check() }
        post(event, pid, pointer: true)
        guard !quiet else { return }
        lastPointer = (pid, windowID, point)
        if type == .leftMouseDown || type == .leftMouseDragged { heldPointer = (pid, point, windowID, frame, flags) }
        if type == .leftMouseUp { heldPointer = nil }
        report(type == .leftMouseDown ? .down : type == .leftMouseUp ? .up : .move, point: point)
    }
    /// A left-button or move event addressed to `windowID` at the screen `point`.
    static func pointerEvent(_ type: CGEventType, _ point: CGPoint, count: Int, windowID: CGWindowID, frame: CGRect, flags: CGEventFlags = []) throws -> CGEvent {
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
        return event
    }
    private func scroll(_ point: CGPoint, dx: Int32, dy: Int32, pid: pid_t, windowID: CGWindowID, frame: CGRect) throws {
        let event = try Self.scrollEvent(point, dx: dx, dy: dy, windowID: windowID, frame: frame)
        if let gestureField = Self.gestureField { event.setIntegerValueField(gestureField, value: gesture) }
        try Self.verifyTargeted(event, point, windowID: windowID, frame: frame)
        post(event, pid, pointer: true)
        feedback?.didDispatch = true
    }
    static func scrollEvent(_ point: CGPoint, dx: Int32, dy: Int32, windowID: CGWindowID, frame: CGRect) throws -> CGEvent {
        guard let setWindowLocation = Self.setWindowLocation, let windowNumberField = Self.windowNumberField else {
            throw UseError("unsupported_pointer_input", "This macOS version does not support scoped pointer input. Use accessible app controls instead.", next: "human_takeover")
        }
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
            throw UseError("input_failed", "Could not create a scroll event.")
        }
        event.location = point
        setWindowLocation(event, CGPoint(x: point.x - frame.minX, y: point.y - frame.minY))
        event.setIntegerValueField(windowNumberField, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        return event
    }
    /// Reads back what the app's AppKit routes the event by, its window number
    /// and window-local point, so input that would reach another window or
    /// point is never posted. `NSEvent(cgEvent:)` here gives only the window
    /// number: for another process's window its location is the flipped screen
    /// point, which matches the window-local one only for a window at the
    /// main screen's bottom-left corner.
    static func verifyTargeted(_ event: CGEvent, _ point: CGPoint, windowID: CGWindowID, frame: CGRect) throws {
        let local = CGPoint(x: point.x - frame.minX, y: point.y - frame.minY)
        guard let windowLocation = Self.windowLocation, let native = NSEvent(cgEvent: event), native.windowNumber == Int(windowID),
              abs(event.location.x - point.x) < 1, abs(event.location.y - point.y) < 1,
              abs(windowLocation(event).x - local.x) < 1, abs(windowLocation(event).y - local.y) < 1 else {
            throw UseError("unsupported_pointer_input", "This macOS version did not address pointer input to the selected window. Use accessible app controls instead.", next: "human_takeover")
        }
    }
    /// Apps that track modifier keys themselves (canvases, games, Electron
    /// shortcuts) need to see them go down before the click or key.
    private func modifiers(_ flags: CGEventFlags, pid: pid_t, check: () throws -> Void) throws {
        var held = CGEventFlags()
        for key in Self.modifierKeys where flags.contains(key.flag) {
            try Task.checkCancellation(); try check()
            held.insert(key.flag)
            try modifier(key.code, flags: held, pid: pid)
            heldModifiers = (pid, held)
        }
    }
    private func releaseModifiers() {
        guard let held = heldModifiers else { return }
        heldModifiers = nil
        var remaining = held.flags
        for key in Self.modifierKeys.reversed() where remaining.contains(key.flag) {
            remaining.remove(key.flag)
            try? modifier(key.code, flags: remaining, pid: held.pid)
        }
    }
    private func modifier(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else {
            throw UseError("input_failed", "Could not create a modifier key event.")
        }
        event.type = .flagsChanged
        event.flags = flags
        post(event, pid)
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
