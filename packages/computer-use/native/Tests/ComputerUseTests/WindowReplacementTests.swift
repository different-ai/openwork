import XCTest
@testable import ComputerUse

/// QuickTime closes its Open panel and shows an Audio Recording window after File › New Audio
/// Recording: the session followed neither and every later read failed.
final class WindowReplacementTests: XCTestCase {
    func testTheSessionFollowsTheOneWindowThatReplacedItsOwn() {
        XCTAssertEqual(WindowReplacement.replacement(before: [19365], after: [19377], target: 19365), 19377)
        XCTAssertEqual(WindowReplacement.replacement(before: [19365, 12], after: [12, 19377], target: 19365), 19377, "other windows of the app stay as they were")
    }

    func testItNeverGuessesWhichWindowToFollow() {
        XCTAssertNil(WindowReplacement.replacement(before: [19365], after: [19365, 19377], target: 19365), "the window is still open: a new window is followed only as one the action opened")
        XCTAssertNil(WindowReplacement.replacement(before: [19365], after: [], target: 19365), "the app shows no window")
        XCTAssertNil(WindowReplacement.replacement(before: [19365], after: [19377, 19378], target: 19365), "two new windows")
        XCTAssertNil(WindowReplacement.replacement(before: [19365], after: [19377, 19378], target: 19365, focused: 12), "the app focuses neither new window")
        XCTAssertNil(WindowReplacement.replacement(before: [19365, 12], after: [12], target: 19365), "only an older window is left")
        XCTAssertNil(WindowReplacement.replacement(before: [12], after: [19377], target: 19365), "the session's window was not there before the input")
        XCTAssertGreaterThan(WindowReplacement.within, 0)
    }

    /// Keynote's theme chooser closes as its new presentation and an inspector appear: the
    /// session follows the window the app put in front.
    func testOfSeveralNewWindowsTheSessionFollowsTheOneTheAppFocused() {
        XCTAssertEqual(WindowReplacement.replacement(before: [24480], after: [24504, 24505], target: 24480, focused: 24504), 24504)
        XCTAssertGreaterThan(WindowReplacement.settle, 0)
    }

    /// QuickTime starts in its Open window, a panel-layer window: after File › New Audio Recording
    /// the recording window replaced it and the session failed every read.
    func testAPanelWindowTheSessionWorkedInIsReplacedLikeAnyOther() {
        let openPanel: UInt32 = 25498, recording: UInt32 = 25504
        XCTAssertEqual(WindowReplacement.replacement(before: [openPanel], after: [recording], target: openPanel), recording)
    }
}
