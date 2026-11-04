import AppKit

/// Whether a session works where the person can see it. OpenWork says when this chat is
/// on screen (`watching`); while it is, the session works in front with its window beside
/// OpenWork, so both can use it. Otherwise it works in the background and never takes the
/// front from the person's own work.
struct FollowAlong: Equatable {
    /// OpenWork shows this chat in a visible window.
    private(set) var watching: Bool
    /// The window may go beside OpenWork: not while several of the chat's apps are open.
    private(set) var beside: Bool
    /// The person brought another app in front while following: background until they come back to OpenWork.
    private(set) var pushedBehind = false
    /// Put the window beside OpenWork at the next look that follows.
    private(set) var arrangeDue: Bool
    /// The person, or the agent's own `arrange`, placed the window: it stays where it is.
    private(set) var placed = false

    init(watching: Bool, beside: Bool = true) {
        self.watching = watching; self.beside = beside; arrangeDue = watching
    }

    /// OpenWork's signal changed. Coming back to the chat follows again, and puts the window
    /// beside OpenWork once more unless it was placed.
    mutating func host(watching: Bool, beside: Bool? = nil) {
        if let beside { self.beside = beside }
        if watching, !self.watching { pushedBehind = false; arrangeDue = !placed }
        self.watching = watching
    }

    /// Before each step: whether it works in front. `frontmost` is the app in front now,
    /// `host` OpenWork and `target` the session's app; `shown` whether its window is on screen.
    mutating func follows(frontmost: pid_t?, host: pid_t, target: pid_t?, shown: Bool = true) -> Bool {
        guard watching else { return false }
        if !shown || frontmost.map({ $0 != host && $0 != target }) == true {
            // The window minimized or hidden, or another app in front: the person's doing.
            pushedBehind = true
        } else if frontmost == host, pushedBehind {
            // Back in OpenWork with this chat on screen.
            pushedBehind = false; arrangeDue = !placed
        }
        return !pushedBehind
    }

    /// Whether to put the window beside OpenWork now. `current` is its frame and `arranged`
    /// where the session last put it: a window moved or resized since stays put for good.
    mutating func arrangeNow(current: CGRect?, arranged: CGRect?) -> Bool {
        guard arrangeDue, beside, !placed else { return false }
        arrangeDue = false
        if let arranged, !WindowArrangement.matches(current, arranged) { placed = true; return false }
        return true
    }

    /// The agent arranged the window itself: its layout stands.
    mutating func agentPlaced() { placed = true; arrangeDue = false }

    /// Whether a window is on screen: not minimized, hidden or on another Space.
    static func onScreen(_ id: CGWindowID) -> Bool {
        let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first
        return info?[kCGWindowIsOnscreen as String] as? Bool ?? false
    }
}
