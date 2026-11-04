import AppKit
import ApplicationServices

/// Where `arrange` puts the session's window on the screen it is on.
enum WindowLayout: String, CaseIterable {
    case leftHalf = "left_half", rightHalf = "right_half", full, besideOpenWork = "beside_openwork"
}

/// Moving and resizing the session's own window, so apps can sit side by side. Frames are
/// in global display coordinates with the origin at the top left of the main display,
/// as Accessibility and the window list use them.
enum WindowArrangement {
    /// Narrower than this, the room beside OpenWork is not used; the window takes the
    /// half of the screen away from OpenWork instead.
    static let minimumWidth: CGFloat = 480

    /// The frame for `layout`, on the screen holding most of `window`. `screens` are visible
    /// frames (without the menu bar and Dock); `host` is the OpenWork window, if one is shown.
    static func frame(_ layout: WindowLayout, window: CGRect, screens: [CGRect], host: CGRect?) throws -> CGRect {
        guard let screen = screens.max(by: { area($0.intersection(window)) < area($1.intersection(window)) }),
              area(screen.intersection(window)) > 0 || screens.count == 1 else {
            throw UseError("screen_unavailable", "The window is not on a screen. Nothing was moved.", next: "observe")
        }
        let left = CGRect(x: screen.minX, y: screen.minY, width: (screen.width / 2).rounded(.down), height: screen.height)
        let right = CGRect(x: left.maxX, y: screen.minY, width: screen.maxX - left.maxX, height: screen.height)
        switch layout {
        case .leftHalf: return left
        case .rightHalf: return right
        case .full: return screen
        case .besideOpenWork:
            guard let host else {
                throw UseError("openwork_window_unavailable", "The OpenWork window is not on screen, so there is nothing to put this window beside. Use left_half, right_half or full. Nothing was moved.", next: "observe")
            }
            // OpenWork on another screen leaves this one free.
            let shared = host.intersection(screen)
            guard area(shared) > 0 else { return screen }
            let roomLeft = CGRect(x: screen.minX, y: screen.minY, width: max(0, shared.minX - screen.minX), height: screen.height)
            let roomRight = CGRect(x: shared.maxX, y: screen.minY, width: max(0, screen.maxX - shared.maxX), height: screen.height)
            let room = roomRight.width >= roomLeft.width ? roomRight : roomLeft
            if room.width >= minimumWidth { return room }
            return shared.midX < screen.midX ? right : left
        }
    }

    /// Screens' visible frames in window-list coordinates. AppKit counts up from the bottom
    /// of the main display; Accessibility counts down from its top.
    static func visibleScreens() -> [CGRect] {
        guard let main = NSScreen.screens.first?.frame else { return [] }
        return NSScreen.screens.map { screen in
            let visible = screen.visibleFrame
            return CGRect(x: visible.minX, y: main.maxY - visible.maxY, width: visible.width, height: visible.height)
        }
    }

    /// The largest on-screen window of the OpenWork app that started this helper.
    static func hostWindow(pid: pid_t = Responsibility.hostPID) -> CGRect? {
        guard pid > 1, let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        return windows.compactMap { info -> CGRect? in
            guard (info[kCGWindowOwnerPID as String] as? Int32) == pid, (info[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds), rect.width > 100, rect.height > 100 else { return nil }
            return rect
        }.max { area($0) < area($1) }
    }

    /// Sets the window's position and size, then reads them back: apps may keep a minimum
    /// size or refuse to move. Returns the step path for the receipt.
    static func apply(_ frame: CGRect, to window: AXUIElement, check: () throws -> Void) throws -> String {
        var origin = frame.origin
        var size = frame.size
        guard let position = AXValueCreate(.cgPoint, &origin), let dimensions = AXValueCreate(.cgSize, &size) else {
            throw UseError("action_failed", "The window frame could not be prepared. Nothing was moved.", next: "observe")
        }
        try check()
        // Size, then position, then size again: a window moved onto a smaller part of the
        // screen can be clamped by its first resize.
        let sized = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, dimensions)
        let moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position)
        _ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, dimensions)
        guard sized == .success || moved == .success else {
            throw UseError("arrange_refused", "The app does not let this window be moved or resized. Nothing changed.", next: "observe")
        }
        return matches(read(window), frame) ? "window_arranged" : "window_arranged_partly"
    }

    /// Within a couple of points: apps round sizes to their own grid.
    static func matches(_ actual: CGRect?, _ wanted: CGRect, tolerance: CGFloat = 2) -> Bool {
        guard let actual else { return false }
        return abs(actual.minX - wanted.minX) <= tolerance && abs(actual.minY - wanted.minY) <= tolerance
            && abs(actual.width - wanted.width) <= tolerance && abs(actual.height - wanted.height) <= tolerance
    }

    private static func read(_ window: AXUIElement) -> CGRect? {
        var rawPosition: CFTypeRef?, rawSize: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &rawPosition) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &rawSize) == .success,
              let rawPosition, let rawSize, CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &point), AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    private static func area(_ rect: CGRect) -> CGFloat { rect.isNull ? 0 : rect.width * rect.height }
}
