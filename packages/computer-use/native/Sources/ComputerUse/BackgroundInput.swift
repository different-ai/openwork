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
    /// a real pointer move, so routed events silently do nothing there.
    static let foregroundBundlePrefixes = ["org.blenderfoundation.", "com.unity3d.unityeditor", "com.epicgames."]
    /// Bundled toolkits whose surfaces take only hardware-origin input (Qt, wxWidgets, Tk).
    static let foregroundFrameworkPrefixes = ["qtcore", "qtgui", "libwx_", "tk.framework", "tcl.framework", "libtk", "_tkinter"]

    /// Set by the trusted host only while the `computerUseBackground` feature is on.
    static let hostVariable = "OPENWORK_COMPUTER_USE_DELIVERY"

    /// `frameworks` are the names in the app's Contents/Frameworks.
    static func decide(enabled: Bool, available: Bool, mode: AccessMode, bundleID: String,
        info: [String: Any] = [:], frameworks: [String] = []) -> InputDelivery {
        guard enabled, available, mode == .control else { return .foreground }
        let id = bundleID.lowercased()
        if foregroundBundlePrefixes.contains(where: id.hasPrefix) { return .foreground }
        if (info["LSApplicationCategoryType"] as? String)?.lowercased().hasSuffix("games") == true { return .foreground }
        if frameworks.contains(where: { name in foregroundFrameworkPrefixes.contains { name.lowercased().hasPrefix($0) } }) { return .foreground }
        return .background
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
