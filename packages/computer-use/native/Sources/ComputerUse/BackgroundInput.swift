import AppKit
import Darwin

/// How a control session's input reaches its window. Background posts events to
/// the app's process and has the app treat the window as active or key without
/// raising it, so the person's front app, cursor and Space stay as they are and
/// several agents can work at once. Foreground brings the window to the front
/// first, as before.
enum InputDelivery: String {
    case background, foreground

    /// Canvas apps, game engines and games read only HID-tap input that follows
    /// a real pointer move, so routed events silently do nothing there. They get
    /// real input in the foreground (`needsRealInput`).
    static let foregroundBundlePrefixes = ["org.blenderfoundation.", "com.unity3d.unityeditor", "com.epicgames."]
    /// Bundled toolkits whose surfaces take only hardware-origin input (Qt, wxWidgets, Tk).
    static let foregroundFrameworkPrefixes = ["qtcore", "qtgui", "libwx_", "tk.framework", "tcl.framework", "libtk", "_tkinter"]

    /// Set by the trusted host for parallel computer-use sessions.
    static let hostVariable = "OPENWORK_COMPUTER_USE_DELIVERY"

    /// `frameworks` are the names in the app's Contents/Frameworks.
    static func decide(enabled: Bool, available: Bool, mode: AccessMode, bundleID: String,
        info: [String: Any] = [:], frameworks: [String] = []) -> InputDelivery {
        guard enabled, available, mode == .control else { return .foreground }
        return needsRealInput(bundleID: bundleID, info: info, frameworks: frameworks) ? .foreground : .background
    }

    /// Apps whose surfaces act only on hardware-origin input: events addressed to
    /// the app are dropped, in front or not (Blender ignores a process-targeted
    /// double-click, typing and Shift). Their clicks, drags, keys and scrolls go
    /// through the system input stream with the real pointer instead, as a person's do.
    static func needsRealInput(bundleID: String, info: [String: Any] = [:], frameworks: [String] = []) -> Bool {
        let id = bundleID.lowercased()
        if foregroundBundlePrefixes.contains(where: id.hasPrefix) { return true }
        if (info["LSApplicationCategoryType"] as? String)?.lowercased().hasSuffix("games") == true { return true }
        return frameworks.contains(where: { name in foregroundFrameworkPrefixes.contains { name.lowercased().hasPrefix($0) } })
    }

    /// Apps whose single letters pick tools: design, photo, video and music apps, by
    /// the category they declare, and the canvas apps that take only real input
    /// (Blender's G, R, S, Tab and Shift-A declare no category). Elsewhere a bare
    /// letter can act (archive, delete).
    static let toolKeyCategories: Set<String> = ["public.app-category.graphics-design", "public.app-category.photography",
        "public.app-category.video", "public.app-category.music"]
    static func takesToolKeys(info: [String: Any]) -> Bool {
        if let id = (info["CFBundleIdentifier"] as? String)?.lowercased(), foregroundBundlePrefixes.contains(where: id.hasPrefix) { return true }
        return (info["LSApplicationCategoryType"] as? String).map { toolKeyCategories.contains($0.lowercased()) } ?? false
    }


    /// A Command or Control shortcut the key list allows, sent to the app's key window when
    /// no field or control was observed with the keyboard, such as Command-Shift-G on a
    /// canvas. Bare letters are tool keys, and plain or Option keys still need a known field.
    static func sendsToKeyWindow(_ key: String, _ flags: CGEventFlags) -> Bool {
        !flags.isDisjoint(with: [.maskCommand, .maskControl]) && !NativeKey.isBlocked(key, flags) || NativeKey.clipboard.contains(NativeKey.chord(key, flags))
    }

    /// In design, photo, video and music apps an editing key (Return, Tab, Escape, Delete,
    /// arrows, Home/End, Page Up/Down, with Shift, Option or Command) goes to whatever has the
    /// keyboard in the selected window when no observed text field has it: the value fields,
    /// steppers and canvases these apps draw themselves. The key-window check still applies:
    /// never a secure field or secure input, and the focus must be inside that window.
    /// Elsewhere Delete on a focused list can delete a message or file, so it needs a field.
    static func editsInKeyWindow(_ key: String, _ flags: CGEventFlags, designApp: Bool, fieldFocused: Bool) -> Bool {
        designApp && !fieldFocused && NativeKey.isEditingKey(key, flags)
    }

    /// The menu command an app offers for a Command shortcut, run in its place when no
    /// observed field or control has the keyboard. Only commands the catalog lists, so
    /// blocked chords never reach a menu either.
    static func menuForShortcut(_ action: Action, in entries: [MenuEntry]) -> [String]? {
        guard case .key(let key, let flags) = action, flags.contains(.maskCommand) else { return nil }
        let chord = NativeKey.chord(key, flags)
        return entries.first { $0.shortcut == chord }?.path
    }

    /// Steps a background session still takes the front for: menu shortcuts
    /// (background keys never reach an app's menus), modified clicks (apps drop
    /// modifier state from process-targeted clicks), hover and drags (tracking
    /// areas and drag-and-drop follow the real pointer), and keys to Chromium,
    /// Electron and Catalyst apps when this macOS cannot sign them (`signedKeys`).
    static func stepNeedsFront(_ action: Action, route: PointerRoute, signedKeys: Bool = KeyAuthentication.available) -> Bool {
        switch action {
        // A Command shortcut outside the key list runs only as its menu command, which needs no front.
        case .key(let key, let flags) where NativeKey.isMenuShortcut(key, flags): return false
        case .key(_, let flags): return flags.contains(.maskCommand) || route == .skyLight && !signedKeys
        case .type, .enterValue: return route == .skyLight && !signedKeys
        case .focused(.key(_, let flags)): return flags.contains(.maskCommand) || route == .skyLight && !signedKeys
        case .focused: return route == .skyLight && !signedKeys
        case .click(_, _, let flags): return !flags.isEmpty
        case .move, .drag, .rightClick, .hold, .saveAs, .openInPanel: return true
        case .showMenu: return false
        case .saveImage: return false
        case .press, .setValue, .scroll, .wait, .menu, .openFile, .arrange, .focus, .expect: return false
        }
    }
}

/// Input posted through the system input stream for apps that take only real
/// mouse and keyboard input, the way a person's own mouse and keyboard reach them.
enum RealInput {
    /// Hands the pointer back only if it is still where the agent left it;
    /// a pointer the person moved since stays with them.
    static func restore(to person: CGPoint?, current: CGPoint?, agentLast: CGPoint?) -> CGPoint? {
        guard let person, let current, let agentLast, hypot(current.x - agentLast.x, current.y - agentLast.y) < 2 else { return nil }
        return person
    }

    static let targetChanged = UseError("window_not_frontmost", "Another app or window came in front of the selected window, so nothing more was sent. Observe again; the selected window is brought back first.", next: "observe")

    /// The system stream delivers to whatever is in front, so each real press,
    /// move, scroll and key is re-checked just before it is posted: keys only while
    /// the app is frontmost, pointer events only where the selected window itself is
    /// the topmost one under the point, not another window of the app. `windows`
    /// are on-screen, front to back; only windows the pointer passes through
    /// (`passThrough`, the agent's presence overlay) are skipped. The Dock, menu bar
    /// and other system layers above apps span whole displays but let clicks through
    /// where they draw nothing, so app windows (layer 0) decide which is on top, and
    /// `hit`, the process macOS finds at the point, decides whether one of those
    /// layers (the Dock's bar, a menu, another app's floating panel) takes the click.
    /// The helper's own windows (`own`), such as the Take over pill, always count.
    static func reachesTarget(_ pid: pid_t, window target: CGWindowID, front: pid_t?, at point: CGPoint?,
        windows: [(id: CGWindowID, pid: pid_t, bounds: CGRect, layer: Int)], passThrough: Set<CGWindowID>, hit: pid_t? = nil,
        own: pid_t = ProcessInfo.processInfo.processIdentifier) -> Bool {
        guard front == pid else { return false }
        guard let point else { return true }
        guard let top = windows.first(where: { ($0.layer == 0 || $0.pid == own) && !passThrough.contains($0.id) && $0.bounds.contains(point) }) else { return false }
        guard top.id == target, top.pid == pid else { return false }
        return hit.map { $0 == pid } ?? true
    }

    /// Marks the agent's events in `eventSourceUserData`: the step they belong to (its low
    /// 15 bits), which held real event a stand-in carries, and whether the event only
    /// releases a press.
    static func tag(generation: UInt32, sequence: UInt32 = 0, release: Bool) -> Int64 {
        tagMarker << 48 | Int64(generation & generationMask) << 33 | Int64(sequence) << 1 | (release ? 1 : 0)
    }
    static func untag(_ value: Int64) -> (generation: UInt32, sequence: UInt32, release: Bool)? {
        guard value >> 48 == tagMarker else { return nil }
        return (UInt32(truncatingIfNeeded: value >> 33) & generationMask, UInt32(truncatingIfNeeded: value >> 1), value & 1 == 1)
    }
    static let generationMask: UInt32 = 0x7FFF
    private static let tagMarker: Int64 = 0x4F57

    /// What goes into the system input stream in place of a press, move, scroll or key:
    /// a stand-in that does nothing if it is delivered as it is. Only the gate's tap turns
    /// it into the real event, and only once the window server routes it to the selected
    /// window. While the tap is disabled or recovering, the stand-in is all that arrives,
    /// so no agent input can escape the gate. A key becomes a key-up of an unused function
    /// key (F20) with no modifiers; a pointer event becomes a move to the point it lands on,
    /// which the window server routes like the real event.
    static func standIn(for real: CGEvent) -> CGEvent? {
        switch real.type {
        case .keyDown, .keyUp, .flagsChanged:
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: unusedKey, keyDown: false) else { return nil }
            event.flags = []
            return event
        default:
            guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: real.location, mouseButton: .left) else { return nil }
            event.flags = []
            return event
        }
    }
    /// kVK_F20: on no Mac keyboard and bound to nothing by default.
    static let unusedKey: CGKeyCode = 0x5A

    enum Delivery: Equatable { case pass, drop, replace }
    /// What the gate's tap does with one of the agent's events. A release always passes, so
    /// nothing stays held. A stand-in becomes its real event only for the armed step, with
    /// its real event still held, where the window server routes it to the selected app and
    /// window; anything else is dropped.
    static func delivery(release: Bool, currentStep: Bool, held: Bool, admitted: Bool) -> Delivery {
        if release { return .pass }
        return currentStep && held && admitted ? .replace : .drop
    }

    /// Whether one of the agent's events may reach the process (and, for the
    /// pointer, the window) the window server is about to hand it to. Releases
    /// always go, so nothing stays held; every press, move, scroll and key only
    /// to the selected app, and pointer events only to the selected window.
    /// `panel` is the process macOS draws the selected app's open Save or Open panel in,
    /// which takes that panel's keys.
    static func admits(release: Bool, target: pid_t, window: CGWindowID, to pid: pid_t, under: CGWindowID, panel: pid_t? = nil) -> Bool {
        release || (pid == target || panel.map { $0 == pid } == true) && (under == 0 || under == window)
    }

    /// The agent's real input reaches the HID state the person-input checks read, so
    /// while a step sends it those checks read the gate instead: only events the
    /// agent did not tag, which are the person's own mouse and keyboard.
    static func personInput(hid: TimeInterval, untagged: TimeInterval?, armed: Bool) -> TimeInterval {
        armed ? (untagged ?? -.infinity) : hid
    }
}

/// Real input is open to every app, not only the ones known to need it. The agent asks for
/// it with `input: "real"` on an act; once a real-input step visibly changes the window, the
/// session keeps it. Input addressed to the app that changed nothing gets a hint to try the
/// step once as real input. Nothing is ever resent by the computer itself: the first input
/// may have landed in a way the window does not show.
enum RealInputUse {
    enum Sent: Equatable { case targeted, real }

    static let suggestion = "The window looks exactly as before. If the app ignored that input, as apps that draw their own interface do, repeat the step once with input: \"real\"."

    static func requested(_ raw: Any?) throws -> Bool {
        guard let raw else { return false }
        guard let value = raw as? String, ["auto", "real"].contains(value) else {
            throw UseError("invalid_arguments", "input must be auto or real.")
        }
        return value == "real"
    }

    /// After the observation that follows an act: keep real input when it worked,
    /// suggest it when addressed input changed nothing.
    static func after(_ sent: Sent?, changes: [String: Any]?, alreadyReal: Bool) -> (keepReal: Bool, suggest: Bool) {
        guard let sent, let changes else { return (false, false) }
        let unchanged = changes["no_visible_change"] as? Bool == true
        switch sent {
        case .real: return (!alreadyReal && !unchanged, false)
        case .targeted: return (false, unchanged && !alreadyReal)
        }
    }
}

/// Binds real input to the selected window where the window server routes it.
/// The check before each post can race an app that comes forward; an annotated
/// session tap sees every event with the process it is about to be delivered to,
/// and drops any of the agent's events bound for another app or window. It fails
/// closed: without the tap, while the tap is off, or outside the armed step, the
/// agent's events are not delivered. It also notes when the person's own events
/// pass, so their input still pauses the step while the agent's does not.
final class RealInputGate: @unchecked Sendable {
    static let shared = RealInputGate()
    static let unavailable = UseError("real_input_unavailable", "Input for this app could not be limited to the selected window, so nothing was sent. Observe again, or ask the person to take over.", next: "observe")
    static let unconfirmed = UseError("input_unconfirmed", "The system did not confirm where the last input went. Observe before continuing.", next: "observe")
    private let lock = NSLock()
    private var tap: CFMachPort?
    private var generation: UInt32 = 0
    private var armed: (pid: pid_t, window: CGWindowID, panel: pid_t?)?
    private var posted = 0, seen = 0, diverted = false
    /// The real events whose stand-ins are on their way, by sequence.
    private var held: [UInt32: CGEvent] = [:]
    private var sequence: UInt32 = 0
    /// When the person's own clicks, keys and moves last passed, by event type, while armed.
    private var personAt: [CGEventType.RawValue: TimeInterval] = [:]

    var isArmed: Bool { lock.withLock { armed != nil } }

    /// Starts a step's real input for `window` of `pid`; throws before anything is sent.
    /// `panel` is the process drawing that window's open Save or Open panel, if any.
    func arm(pid: pid_t, window: CGWindowID, panel: pid_t? = nil) throws {
        guard let tap = start() else { throw Self.unavailable }
        lock.withLock {
            generation &+= 1
            armed = (pid, window, panel); posted = 0; seen = 0; diverted = false; personAt = [:]; held = [:]
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else {
            lock.withLock { armed = nil }
            throw Self.unavailable
        }
    }
    /// Posts one of the armed step's events through the system input stream. A release goes
    /// as itself so nothing stays held; anything else goes as its stand-in, which only the
    /// tap turns back into this event once it is routed to the selected window.
    func post(_ event: CGEvent, release: Bool) throws {
        if release {
            let value = lock.withLock { () -> Int64 in
                posted += 1
                return RealInput.tag(generation: generation, release: true)
            }
            event.setIntegerValueField(.eventSourceUserData, value: value)
            event.post(tap: .cghidEventTap)
            return
        }
        guard let standIn = RealInput.standIn(for: event) else { throw UseError("input_failed", "Could not create an input event.") }
        let value = lock.withLock { () -> Int64 in
            posted += 1
            sequence &+= 1
            held[sequence] = event
            return RealInput.tag(generation: generation, sequence: sequence, release: false)
        }
        standIn.setIntegerValueField(.eventSourceUserData, value: value)
        standIn.post(tap: .cghidEventTap)
    }
    /// Stops the step once anything was held back or the tap stopped watching.
    func check() throws {
        guard let tap = lock.withLock({ diverted ? nil : self.tap }), CGEvent.tapIsEnabled(tap: tap) else { throw RealInput.targetChanged }
    }
    /// When the person's own event of `type` last passed during this step, if it did.
    func personInput(_ type: CGEventType) -> TimeInterval? {
        lock.withLock { personAt[type.rawValue] }
    }
    /// Waits for the window server to route every posted event, then stops watching.
    /// Events still in flight stay under the armed check.
    func finish() async -> UseError? {
        var waits = 0
        while waits < 30, lock.withLock({ seen < posted }) {
            try? await Task.sleep(nanoseconds: 10_000_000)
            waits += 1
        }
        let (drained, wasDiverted, tap) = lock.withLock { () -> (Bool, Bool, CFMachPort?) in
            let drained = seen >= posted
            if drained { armed = nil; held = [:] }
            return (drained, diverted, self.tap)
        }
        if drained, let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        return wasDiverted ? RealInput.targetChanged : drained ? nil : Self.unconfirmed
    }

    /// Ends a step that stopped before `finish`: once every posted event was routed the
    /// gate stops watching; events still in flight stay under the armed check.
    func abandon() {
        let tap = lock.withLock { () -> CFMachPort? in
            guard armed != nil, seen >= posted else { return nil }
            armed = nil; held = [:]
            return self.tap
        }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    }

    /// Returns the event to deliver: this one, its real event, or nil to drop it.
    private func filter(_ type: CGEventType, _ event: CGEvent) -> (CGEvent?, replaced: Bool) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // While the tap was off, only stand-ins and releases went out. The step stops,
            // and the tap comes back.
            let tap = lock.withLock { () -> CFMachPort? in
                guard armed != nil else { return nil }
                diverted = true
                return self.tap
            }
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return (event, false)
        }
        guard let tag = RealInput.untag(event.getIntegerValueField(.eventSourceUserData)) else {
            // The person's own mouse or keyboard: it always passes, and is noted.
            lock.withLock { if armed != nil { personAt[type.rawValue] = ProcessInfo.processInfo.systemUptime } }
            return (event, false)
        }
        let pid = pid_t(truncatingIfNeeded: event.getIntegerValueField(.eventTargetUnixProcessID))
        let under = CGWindowID(truncatingIfNeeded: event.getIntegerValueField(Self.windowUnderPointer))
        let (delivery, real) = lock.withLock { () -> (RealInput.Delivery, CGEvent?) in
            let currentStep = armed != nil && tag.generation == generation & RealInput.generationMask
            if currentStep { seen += 1 }
            let real = tag.release ? nil : held.removeValue(forKey: tag.sequence)
            let admitted = armed.map { RealInput.admits(release: tag.release, target: $0.pid, window: $0.window, to: pid, under: under, panel: $0.panel) } ?? false
            let delivery = RealInput.delivery(release: tag.release, currentStep: currentStep, held: real != nil, admitted: admitted)
            if currentStep, delivery == .drop { diverted = true }
            return (delivery, real)
        }
        switch delivery {
        case .pass: return (event, false)
        case .drop: return (nil, false)
        case .replace:
            guard let real else { return (nil, false) }
            // The real event takes the stand-in's place and the route the window server gave it.
            for field in Self.routeFields { real.setIntegerValueField(field, value: event.getIntegerValueField(field)) }
            real.setIntegerValueField(.eventSourceUserData, value: event.getIntegerValueField(.eventSourceUserData))
            return (real, true)
        }
    }
    private static let routeFields: [CGEventField] = [.eventTargetUnixProcessID, .eventTargetProcessSerialNumber,
        .mouseEventWindowUnderMousePointer, .mouseEventWindowUnderMousePointerThatCanHandleThisEvent]
    // kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent: 0 for keys.
    private static let windowUnderPointer = CGEventField(rawValue: 92)!
    private static let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged,
        .rightMouseDown, .rightMouseUp, .rightMouseDragged, .otherMouseDown, .otherMouseUp, .otherMouseDragged,
        .scrollWheel, .keyDown, .keyUp, .flagsChanged]
    private static let callback: CGEventTapCallBack = { _, type, event, info in
        guard let info else { return Unmanaged.passUnretained(event) }
        let (deliver, replaced) = Unmanaged<RealInputGate>.fromOpaque(info).takeUnretainedValue().filter(type, event)
        guard let deliver else { return nil }
        // A replacement is handed over with its own reference; the stand-in stays with the system.
        return replaced ? Unmanaged.passRetained(deliver) : Unmanaged.passUnretained(deliver)
    }
    /// The tap runs on its own thread, so a busy main thread never holds input up.
    private func start() -> CFMachPort? {
        if let tap = lock.withLock({ tap }) { return tap }
        let ready = DispatchSemaphore(value: 0)
        let info = Unmanaged.passUnretained(self).toOpaque()
        var made: CFMachPort?
        let thread = Thread {
            let mask = Self.types.reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }
            made = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap, options: .defaultTap,
                eventsOfInterest: mask, callback: Self.callback, userInfo: info)
            if let made {
                CGEvent.tapEnable(tap: made, enable: false)
                CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(nil, made, 0), .commonModes)
            }
            ready.signal()
            if made != nil { CFRunLoopRun() }
        }
        thread.name = "computer-use.real-input"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
        lock.withLock { tap = made }
        return made
    }
}

/// Has an app treat a window as active, and for keys as its key window,
/// without raising it or activating the app (the focus-without-raise pattern
/// from yabai and cua-driver): WindowServer event records sent to the target
/// process only. It never calls `SLPSSetFrontProcessWithOptions`, which raises
/// and can switch Spaces, and never sends the person's front app a defocus
/// record, which would drop their typing.
enum BackgroundFocus {
    private typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
    private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    private static func symbol<T>(_ name: String, _ type: T.Type) -> T? {
        guard let pointer = dlsym(skyLight, name) ?? dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
        return unsafeBitCast(pointer, to: type)
    }
    private static let postRecord = symbol("SLPSPostEventRecordTo", PostEventRecordTo.self)
    private static let processForPID = symbol("GetProcessForPID", GetProcessForPID.self)

    /// Both private calls resolved on this macOS; otherwise every session keeps the front.
    static var available: Bool { postRecord != nil && processForPID != nil }

    /// The 0xF8-byte records, window id at 0x3C: a focus record (the app treats
    /// the window as active, enough for clicks), then for keys the make-key pair.
    static func records(window: CGWindowID, makeKey: Bool) -> [[UInt8]] {
        func record(kind: UInt8) -> [UInt8] {
            var bytes = [UInt8](repeating: 0, count: 0xF8)
            bytes[0x04] = 0xF8; bytes[0x08] = kind
            withUnsafeBytes(of: window.littleEndian) { for (index, byte) in $0.enumerated() { bytes[0x3C + index] = byte } }
            return bytes
        }
        var focus = record(kind: 0x0D)
        focus[0x8A] = 0x01
        guard makeKey else { return [focus] }
        return [focus] + ([0x01, 0x02] as [UInt8]).map { kind in
            var key = record(kind: kind)
            key[0x3A] = 0x10
            for index in 0x20..<0x30 { key[index] = 0xFF }
            return key
        }
    }

    /// True when every record was posted (macOS answers 1002 without
    /// Accessibility). Whether the app acted on them is for the caller to read back.
    static func post(pid: pid_t, window: CGWindowID, makeKey: Bool) -> Bool {
        var process = [UInt32](repeating: 0, count: 2)
        guard let postRecord, let processForPID, process.withUnsafeMutableBytes({ processForPID(pid, $0.baseAddress!) }) == 0 else { return false }
        return records(window: window, makeKey: makeKey).allSatisfy { record in
            process.withUnsafeBytes { psn in record.withUnsafeBytes { postRecord(psn.baseAddress!, $0.baseAddress!) } } == 0
        }
    }

    static let settle: TimeInterval = 0.05
    static let keyAttempts = 2
    static let keyLimit: TimeInterval = 0.4
    static let keysUnavailable = UseError("background_keys_unavailable", "The app did not make the selected window its focused window in the background, so nothing was typed. Its next steps bring it to the front; observe again.", next: "observe")

    /// Keys go to the app's own key window: post the records, then wait until
    /// the app reports the selected window as focused. `routes` reads that back.
    @MainActor static func primeKeys(routes: () -> Bool, post: () -> Bool, now: () -> TimeInterval, check: () throws -> Void,
        sleep: (TimeInterval) async throws -> Void) async throws {
        try check()
        if routes() { return }
        for _ in 0..<keyAttempts {
            guard post() else { throw keysUnavailable }
            let started = now()
            repeat {
                try await sleep(settle)
                try check()
                if routes() { return }
            } while now() - started < keyLimit
        }
        throw keysUnavailable
    }
}

/// Chromium, Electron and Catalyst accept a process-targeted key only with
/// WindowServer's authentication envelope (macOS 15 and later), the way
/// cua-driver sends background keys. Without it their keys need the front.
enum KeyAuthentication {
    private typealias SetMessage = @convention(c) (UnsafeMutableRawPointer, AnyObject) -> Void
    private typealias Factory = @convention(c) (AnyClass, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> Unmanaged<AnyObject>?
    private static let selector = NSSelectorFromString("messageWithEventRecord:pid:version:")
    private static let parts: (AnyClass, Factory, SetMessage)? = {
        guard let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
              let set = dlsym(skyLight, "SLEventSetAuthenticationMessage"),
              let messageClass = NSClassFromString("SLSEventAuthenticationMessage"),
              // macOS 14 has the class without this factory; calling it there would raise.
              let method = class_getClassMethod(messageClass, selector) else { return nil }
        return (messageClass, unsafeBitCast(method_getImplementation(method), to: Factory.self), unsafeBitCast(set, to: SetMessage.self))
    }()

    static var available: Bool { parts != nil }

    /// The event's WindowServer record: `__CGEvent` is a CF base, a 32-bit field
    /// and then the record pointer, at offset 24 on current releases.
    static func record(_ event: CGEvent) -> UnsafeMutableRawPointer? {
        let base = Unmanaged.passUnretained(event).toOpaque()
        for offset in [24, 32, 16] {
            if let pointer = base.load(fromByteOffset: offset, as: UnsafeMutableRawPointer?.self) { return pointer }
        }
        return nil
    }

    /// True when the envelope is attached; the caller then posts through SkyLight.
    static func attach(_ event: CGEvent, pid: pid_t) -> Bool {
        guard let (messageClass, factory, set) = parts, let record = record(event),
              let message = factory(messageClass, selector, record, pid, 0)?.takeUnretainedValue() else { return false }
        set(Unmanaged.passUnretained(event).toOpaque(), message)
        return true
    }
}

/// Whether and how an observation carries a screenshot. Capturing one takes
/// about a tenth of a second; the model reading it costs far more, so an image
/// is sent only when it adds something the accessible elements do not.
/// Requested wins. Automatic reads the accessibility tree first and adds the
/// image only when the tree names too few controls to act on, or leaves most
/// of them unnamed, as canvas and many Electron windows do.
enum ImagePolicy {
    static let enoughControls = 8

    /// Background delivery reads the tree first. So do the modes that never take
    /// coordinates, observe and assist, whose images are only for reading.
    static func automatic(delivery: InputDelivery, mode: AccessMode, policy: RuntimePolicy) -> Bool {
        delivery == .background || policy == .embedded && mode != .control
    }

    static func include(requested: Bool?, automatic: Bool, namedControls: Int, interactiveControls: Int = 0) -> Bool {
        if let requested { return requested }
        return !automatic || namedControls < enoughControls || namedControls * 2 < interactiveControls
    }

    /// Encoding for an observation image. Control mode clicks at image
    /// coordinates, so it keeps the sharper image; observe and assist only read
    /// it, and computer_zoom shows small text at full resolution.
    struct Profile: Equatable {
        let maxLongSide: CGFloat
        let jpegQuality: CGFloat
    }
    static let precise = Profile(maxLongSide: 1280, jpegQuality: 0.8)
    static let reading = Profile(maxLongSide: 1024, jpegQuality: 0.7)

    static func profile(mode: AccessMode, policy: RuntimePolicy) -> Profile {
        policy == .embedded && mode != .control ? reading : precise
    }

    /// The last image the model received from a session's window.
    struct Sent: Equatable {
        let observationID: String
        let generation: Int
        let window: CGWindowID
        let width: Int
        let height: Int
        let digest: Data
    }

    /// An automatic image identical to the last one sent from the same window, at
    /// the same size and without a handoff in between, is not sent again: the
    /// model already has those pixels, and its coordinates still apply to them.
    static func alreadySent(requested: Bool?, last: Sent?, generation: Int, window: CGWindowID, width: Int, height: Int, digest: Data) -> Sent? {
        guard requested == nil, let last, last.generation == generation, last.window == window,
              last.width == width, last.height == height, last.digest == digest else { return nil }
        return last
    }
}

/// What the person would notice on their desktop: which app is in front, where
/// the cursor is and which Space is shown. Receipts report changes across an
/// action, including the person's own, so background delivery can be checked.
struct DesktopState: Equatable {
    let frontPID: pid_t?
    let cursor: CGPoint
    let space: Int

    @MainActor static func now() -> DesktopState {
        DesktopState(frontPID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            cursor: CGEvent(source: nil)?.location ?? .zero, space: SpaceWatch.shared.changes)
    }

    func changes(to after: DesktopState) -> [String: Any] {
        ["front_app_changed": frontPID != after.frontPID,
         "cursor_moved": hypot(after.cursor.x - cursor.x, after.cursor.y - cursor.y) > 0.5,
         "space_changed": space != after.space]
    }
}

/// Counts Space switches since launch; NSWorkspace reports no current Space id.
@MainActor
final class SpaceWatch {
    static let shared = SpaceWatch()
    private(set) var changes = 0
    private var observer: NSObjectProtocol?

    private init() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.changes += 1 }
        }
    }
}
