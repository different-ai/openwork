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
        XCTAssertNil(WindowReplacement.replacement(before: [19365, 12], after: [12], target: 19365), "only an older window is left")
        XCTAssertNil(WindowReplacement.replacement(before: [12], after: [19377], target: 19365), "the session's window was not there before the input")
        XCTAssertGreaterThan(WindowReplacement.within, 0)
    }
}
