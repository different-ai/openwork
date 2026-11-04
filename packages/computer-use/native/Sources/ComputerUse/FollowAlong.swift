import AppKit

/// Whether a session works where the person can see it. OpenWork says when this chat is
/// on screen (`watching`); while it is, the session works in front with its window beside
/// OpenWork, so both can use it. Otherwise it works in the background and never takes the
/// front from the person's own work.
/// A window's place on the chat's stage: `slot` of `count` agents' windows, set by the host.
struct StageSlot: Equatable {
    let slot: Int
    let count: Int

    /// From the host's `stage_slot` and `stage_count`; a count of zero is no stage.
    static func parse(_ values: Arguments) throws -> StageSlot? {
        let count = try values.integer("stage_count", min: 0, max: WindowArrangement.stageLimit)
        guard count > 0 else { return nil }
        return StageSlot(slot: try values.integer("stage_slot", min: 0, max: count - 1), count: count)
    }
}

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
    /// Several of the chat's agents work while the person watches: the window's tile on the
    /// stage, used instead of beside OpenWork.
    private(set) var stage: StageSlot?

    init(watching: Bool, beside: Bool = true, stage: StageSlot? = nil) {
        self.watching = watching; self.beside = beside; self.stage = stage; arrangeDue = watching
    }

    /// OpenWork's signal changed. Coming back to the chat follows again, and puts the window
    /// beside OpenWork once more unless it was placed. A new stage, as agents open or close
    /// apps, re-tiles at the next look; nil leaves the stage as it was.
    mutating func host(watching: Bool, beside: Bool? = nil, stage: StageSlot?? = nil) {
        if let beside { self.beside = beside }
        if let stage, stage != self.stage { self.stage = stage; arrangeDue = !placed }
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
        guard arrangeDue, beside || stage != nil, !placed else { return false }
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
