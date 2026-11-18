import AppKit
import CoreGraphics
import ObjectiveC

/// Spaces are the desktops a person switches between. A window on another one cannot be seen or
/// used from here, so it is brought over to the Space the person is on, without activating its
/// app: through macOS's window management (the way Claude's own computer use does it), else by
/// minimizing and restoring it, which macOS does on the current Space.
enum Spaces {
    /// How a window was brought here, for the receipt.
    enum Way: String, CaseIterable { case moveToSpace = "move_to_space", windowManager = "window_manager", windowManagerFallback = "window_manager_fallback" }

    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
    private typealias MainConnection = @convention(c) () -> Int32
    private typealias ActiveSpace = @convention(c) (Int32) -> UInt64
    private typealias SpacesForWindows = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
    private typealias MoveWindows = @convention(c) (Int32, CFArray, UInt64) -> Void
    private typealias InitOperation = @convention(c) (AnyObject, Selector, NSArray, UInt64) -> AnyObject?
    private typealias DisplaySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
    private static func symbol<T>(_ name: String, as type: T.Type) -> T? {
        guard let skyLight, let found = dlsym(skyLight, name) else { return nil }
        return unsafeBitCast(found, to: type)
    }
    private static let connection = symbol("SLSMainConnectionID", as: MainConnection.self)
    private static let activeSpace = symbol("SLSGetActiveSpace", as: ActiveSpace.self)
    private static let spacesForWindows = symbol("CGSCopySpacesForWindows", as: SpacesForWindows.self)
    private static let moveWindows = symbol("SLSMoveWindowsToManagedSpace", as: MoveWindows.self)
    private static let displaySpaces = symbol("SLSCopyManagedDisplaySpaces", as: DisplaySpaces.self)
    /// kCGSAllSpacesMask: every Space a window is on.
    private static let allSpaces: Int32 = 7

    /// The Space the person is on now.
    static func current() -> UInt64? {
        guard let connection, let activeSpace else { return nil }
        let id = activeSpace(connection())
        return id == 0 ? nil : id
    }
    /// The Spaces `window` is on.
    static func of(_ window: CGWindowID) -> [UInt64] {
        guard let connection, let spacesForWindows,
              let spaces = spacesForWindows(connection(), allSpaces, [NSNumber(value: window)] as CFArray)?.takeRetainedValue() as? [NSNumber] else { return [] }
        return spaces.map(\.uint64Value)
    }
    /// The Space each display shows now: with two displays, two Spaces are in view at once.
    static func visible() -> Set<UInt64> {
        var shown: Set<UInt64> = current().map { [$0] } ?? []
        guard let connection, let displaySpaces,
              let displays = displaySpaces(connection())?.takeRetainedValue() as? [[String: Any]] else { return shown }
        for display in displays {
            if let id = ((display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? NSNumber)?.uint64Value { shown.insert(id) }
        }
        return shown
    }
    /// On some Space, but on none that a display shows now.
    static func isElsewhere(spaces: [UInt64], visible: Set<UInt64>) -> Bool {
        guard !visible.isEmpty, !spaces.isEmpty else { return false }
        return spaces.allSatisfy { !visible.contains($0) }
    }

    /// Tries each way in turn, reading back after each, until `here()` says the window shows.
    @MainActor static func bringHere(_ window: CGWindowID, here: () -> Bool) async -> Way? {
        guard let target = current() else { return nil }
        for way in Way.allCases {
            attempt(way, window: window, space: target)
            for _ in 0..<6 {
                if here() { return way }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        return nil
    }
    private static func attempt(_ way: Way, window: CGWindowID, space: UInt64) {
        let windows = [NSNumber(value: window)] as NSArray
        switch way {
        case .moveToSpace:
            guard let connection, let moveWindows else { return }
            moveWindows(connection(), windows, space)
        case .windowManager, .windowManagerFallback:
            let initializer = NSSelectorFromString("initWithWindows:spaceID:")
            let run = NSSelectorFromString(way == .windowManager ? "performWithWMBridgeDelegate" : "invokeFallback")
            guard let type = NSClassFromString("SLSBridgedMoveWindowsToManagedSpaceOperation") as? NSObject.Type,
                  type.instancesRespond(to: initializer), type.instancesRespond(to: run),
                  let fresh = type.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() else { return }
            let make = unsafeBitCast(class_getMethodImplementation(type, initializer), to: InitOperation.self)
            guard let operation = make(fresh, initializer, windows, space) as? NSObject else { return }
            _ = operation.perform(run)
        }
    }
}
