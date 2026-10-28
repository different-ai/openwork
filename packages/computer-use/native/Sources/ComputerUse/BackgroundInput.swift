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

    /// Set by the trusted host only while the `computerUseBackground` feature is on.
    static let hostVariable = "OPENWORK_COMPUTER_USE_DELIVERY"

    /// `frameworks` are the names in the app's Contents/Frameworks.
    static func decide(enabled: Bool, available: Bool, mode: AccessMode, bundleID: String,
        info: [String: Any] = [:], frameworks: [String] = []) -> InputDelivery {
        guard enabled, available, mode == .control else { return .foreground }
        return needsRealInput(bundleID: bundleID, info: info, frameworks: frameworks) ? .foreground : .background
    }

    /// Apps whose surfaces act only on hardware-origin input: events addressed to
    /// the app are dropped, in front or not. Their clicks, keys and scrolls go
    /// through the system input stream with the real pointer instead.
    static func needsRealInput(bundleID: String, info: [String: Any] = [:], frameworks: [String] = []) -> Bool {
        let id = bundleID.lowercased()
        if foregroundBundlePrefixes.contains(where: id.hasPrefix) { return true }
        if (info["LSApplicationCategoryType"] as? String)?.lowercased().hasSuffix("games") == true { return true }
        return frameworks.contains(where: { name in foregroundFrameworkPrefixes.contains { name.lowercased().hasPrefix($0) } })
    }

    /// Steps a background session still takes the front for: menu shortcuts
    /// (background keys never reach an app's menus), modified clicks (apps drop
    /// modifier state from process-targeted clicks), hover and drags (tracking
    /// areas and drag-and-drop follow the real pointer), and keys to Chromium,
    /// Electron and Catalyst apps (which need a signed envelope the helper does
    /// not send).
    static func stepNeedsFront(_ action: Action, route: PointerRoute) -> Bool {
        switch action {
        case .key(_, let flags): return flags.contains(.maskCommand) || route == .skyLight
        case .type: return route == .skyLight
        case .click(_, _, let flags): return !flags.isEmpty
        case .move, .drag: return true
        case .press, .setValue, .scroll, .wait: return false
        }
    }
}

/// Input posted through the system input stream for apps that take only real
/// mouse and keyboard input.
enum RealInput {
    /// A drag holds the button while the pointer travels. If something comes forward
    /// mid-drag, the release that must go out could drop the dragged content into
    /// another app, so these apps get no real drags.
    static let dragUnavailable = UseError("drag_unavailable", "Drags are not sent to this app: if another window came forward during one, its release could drop into that window. Use clicks, keys or the app's own commands. Nothing was sent.", next: "observe")

    /// Hands the pointer back only if it is still where the agent left it;
    /// a pointer the person moved since stays with them.
    static func restore(to person: CGPoint?, current: CGPoint?, agentLast: CGPoint?) -> CGPoint? {
        guard let person, let current, let agentLast, hypot(current.x - agentLast.x, current.y - agentLast.y) < 2 else { return nil }
        return person
    }

    static let targetChanged = UseError("window_not_frontmost", "Another app or window came in front of the selected window, so nothing more was sent. Choose Continue in the Computer Use controls to return to it.", next: "human_takeover")

    /// The system stream delivers to whatever is in front, so each real press,
    /// move and scroll is re-checked just before it is posted: keys only while the
    /// app is frontmost, pointer events only where the selected window itself is
    /// the topmost one under the point, not another window of the app. `windows`
    /// are on-screen, front to back; only windows the pointer passes through
    /// (`passThrough`, the agent's presence overlay) are skipped.
    static func reachesTarget(_ pid: pid_t, window target: CGWindowID, front: pid_t?, at point: CGPoint?,
        windows: [(id: CGWindowID, pid: pid_t, bounds: CGRect)], passThrough: Set<CGWindowID>) -> Bool {
        guard front == pid else { return false }
        guard let point else { return true }
        guard let top = windows.first(where: { !passThrough.contains($0.id) && $0.bounds.contains(point) }) else { return false }
        return top.id == target && top.pid == pid
    }

    /// Marks the agent's real events in `eventSourceUserData`: the step they belong
    /// to, and whether the event only releases a press.
    static func tag(generation: UInt32, release: Bool) -> Int64 {
        tagMarker << 48 | Int64(generation) << 1 | (release ? 1 : 0)
    }
    static func untag(_ value: Int64) -> (generation: UInt32, release: Bool)? {
        guard value >> 48 == tagMarker else { return nil }
        return (UInt32(truncatingIfNeeded: value >> 1), value & 1 == 1)
    }
    private static let tagMarker: Int64 = 0x4F57

    /// Whether one of the agent's events may reach the process (and, for the
    /// pointer, the window) the window server is about to hand it to. Releases
    /// always go, so nothing stays held; every press, move, scroll and key only
    /// to the selected app, and pointer events only to the selected window.
    static func admits(release: Bool, target: pid_t, window: CGWindowID, to pid: pid_t, under: CGWindowID) -> Bool {
        release || pid == target && (under == 0 || under == window)
    }
}

/// Binds real input to the selected window where the window server routes it.
/// The check before each post can race an app that comes forward; an annotated
/// session tap sees every event with the process it is about to be delivered to,
/// and drops any of the agent's events bound for another app or window. It fails
/// closed: without the tap, while the tap is off, or outside the armed step, the
/// agent's events are not delivered.
final class RealInputGate: @unchecked Sendable {
    static let shared = RealInputGate()
    static let unavailable = UseError("real_input_unavailable", "Input for this app could not be limited to the selected window, so nothing was sent. Use the app's own commands or ask the person.", next: "human_takeover")
    static let unconfirmed = UseError("input_unconfirmed", "The system did not confirm where the last input went. Observe before continuing.", next: "observe")
    private let lock = NSLock()
    private var tap: CFMachPort?
    private var generation: UInt32 = 0
    private var armed: (pid: pid_t, window: CGWindowID)?
    private var posted = 0, seen = 0, diverted = false

    /// Starts a step's real input for `window` of `pid`; throws before anything is sent.
    func arm(pid: pid_t, window: CGWindowID) throws {
        guard let tap = start() else { throw Self.unavailable }
        lock.withLock {
            generation &+= 1
            armed = (pid, window); posted = 0; seen = 0; diverted = false
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else { throw Self.unavailable }
    }
    /// Marks an event of the armed step, just before it is posted.
    func tag(_ event: CGEvent, release: Bool) {
        let value = lock.withLock { () -> Int64 in
            posted += 1
            return RealInput.tag(generation: generation, release: release)
        }
        event.setIntegerValueField(.eventSourceUserData, value: value)
    }
    /// Stops the step once anything was held back or the tap stopped watching.
    func check() throws {
        guard let tap = lock.withLock({ diverted ? nil : self.tap }), CGEvent.tapIsEnabled(tap: tap) else { throw RealInput.targetChanged }
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
            if drained { armed = nil }
            return (drained, diverted, self.tap)
        }
        if drained, let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        return wasDiverted ? RealInput.targetChanged : drained ? nil : Self.unconfirmed
    }

    private func filter(_ type: CGEventType, _ event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // Events may have passed unchecked: the step stops, and the tap comes back.
            let tap = lock.withLock { () -> CFMachPort? in
                guard armed != nil else { return nil }
                diverted = true
                return self.tap
            }
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return true
        }
        guard let tag = RealInput.untag(event.getIntegerValueField(.eventSourceUserData)) else { return true }
        let pid = pid_t(truncatingIfNeeded: event.getIntegerValueField(.eventTargetUnixProcessID))
        let under = CGWindowID(truncatingIfNeeded: event.getIntegerValueField(Self.windowUnderPointer))
        return lock.withLock {
            guard let armed, tag.generation == generation else { return false }
            seen += 1
            let admitted = RealInput.admits(release: tag.release, target: armed.pid, window: armed.window, to: pid, under: under)
            if !admitted { diverted = true }
            return admitted
        }
    }
    // kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent: 0 for keys.
    private static let windowUnderPointer = CGEventField(rawValue: 92)!
    private static let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged,
        .rightMouseDown, .rightMouseUp, .rightMouseDragged, .otherMouseDown, .otherMouseUp, .otherMouseDragged,
        .scrollWheel, .keyDown, .keyUp, .flagsChanged]
    private static let callback: CGEventTapCallBack = { _, type, event, info in
        guard let info else { return Unmanaged.passUnretained(event) }
        return Unmanaged<RealInputGate>.fromOpaque(info).takeUnretainedValue().filter(type, event) ? Unmanaged.passUnretained(event) : nil
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

/// Whether an observation carries a screenshot. Requested wins. Automatic,
/// used with background delivery, reads the accessibility tree first and adds
/// the image only when the tree names too few controls to act on.
enum ImagePolicy {
    static let enoughControls = 8

    static func include(requested: Bool?, automatic: Bool, namedControls: Int) -> Bool {
        if let requested { return requested }
        return !automatic || namedControls < enoughControls
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
