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

    /// The most windows a stage tiles; the host never sends more.
    static let stageLimit = 6

    /// Where each of `count` agents' windows goes while the person watches them all, on the
    /// screen OpenWork is on (else the one holding most of `window`). OpenWork keeps its own
    /// column: the room beside it when that is at least half the screen, otherwise a third of the
    /// screen on its side. The windows tile the rest: one fills it, two sit side by side, three
    /// are one large beside two stacked, four and more a grid of two rows.
    static func stage(count: Int, window: CGRect, screens: [CGRect], host: CGRect?) throws -> [CGRect] {
        guard (1...stageLimit).contains(count) else { throw UseError("invalid_arguments", "A stage holds 1 to \(stageLimit) windows.") }
        let onHost = host.flatMap { host in screens.max(by: { area($0.intersection(host)) < area($1.intersection(host)) }).flatMap { area($0.intersection(host)) > 0 ? $0 : nil } }
        let screen = try onHost ?? frame(.full, window: window, screens: screens, host: nil)
        var room = screen
        if let host, onHost != nil {
            let shared = host.intersection(screen)
            let roomLeft = CGRect(x: screen.minX, y: screen.minY, width: max(0, shared.minX - screen.minX), height: screen.height)
            let roomRight = CGRect(x: shared.maxX, y: screen.minY, width: max(0, screen.maxX - shared.maxX), height: screen.height)
            let beside = roomRight.width >= roomLeft.width ? roomRight : roomLeft
            if beside.width >= screen.width / 2 { room = beside }
            else {
                let column = (screen.width / 3).rounded(.down)
                room = shared.midX < screen.midX
                    ? CGRect(x: screen.minX + column, y: screen.minY, width: screen.width - column, height: screen.height)
                    : CGRect(x: screen.minX, y: screen.minY, width: screen.width - column, height: screen.height)
            }
        }
        func cell(_ column: Int, of columns: Int, row: Int, of rows: Int, in area: CGRect) -> CGRect {
            let x0 = (area.minX + area.width * CGFloat(column) / CGFloat(columns)).rounded(.down)
            let x1 = column == columns - 1 ? area.maxX : (area.minX + area.width * CGFloat(column + 1) / CGFloat(columns)).rounded(.down)
            let y0 = (area.minY + area.height * CGFloat(row) / CGFloat(rows)).rounded(.down)
            let y1 = row == rows - 1 ? area.maxY : (area.minY + area.height * CGFloat(row + 1) / CGFloat(rows)).rounded(.down)
            return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
        }
        switch count {
        case 1: return [room]
        case 2: return [cell(0, of: 2, row: 0, of: 1, in: room), cell(1, of: 2, row: 0, of: 1, in: room)]
        case 3:
            let right = cell(1, of: 2, row: 0, of: 1, in: room)
            return [cell(0, of: 2, row: 0, of: 1, in: room), cell(0, of: 1, row: 0, of: 2, in: right), cell(0, of: 1, row: 1, of: 2, in: right)]
        default:
            let columns = (count + 1) / 2
            return (0..<count).map { cell($0 % columns, of: columns, row: $0 / columns, of: 2, in: room) }
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

    /// The person's window as it was before the session's first `arrange`, and where the
    /// last `arrange` left it, so closing the session can put it back.
    struct Placement {
        let window: AXUIElement
        let original: CGRect
        var arranged: CGRect?
    }

    /// The frame to put back on close: the original, unless the person moved or resized the
    /// window since the session last arranged it. Their own placement always wins.
    static func restoring(_ placement: Placement, current: CGRect?) -> CGRect? {
        guard let arranged = placement.arranged, matches(current, arranged), !matches(current, placement.original) else { return nil }
        return placement.original
    }

    /// Puts the window back where it was, when the person has not moved it since.
    @discardableResult
    static func restore(_ placement: Placement) -> Bool {
        guard let original = restoring(placement, current: read(placement.window)) else { return false }
        return (try? apply(original, to: placement.window, check: {})) == "window_arranged"
    }

    static func frame(of window: AXUIElement) -> CGRect? { read(window) }

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
