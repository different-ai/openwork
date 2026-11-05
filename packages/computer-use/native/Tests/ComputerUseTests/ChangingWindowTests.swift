import CoreGraphics
import XCTest
@testable import ComputerUse

/// Windows whose content keeps changing on its own (a file panel's list, a live preview, a map
/// the agent pans) refused every screenshot, Cancel and Escape as stale_observation.
final class ChangingWindowTests: XCTestCase {
    func testAScreenshotMasksEveryProtectedFieldEitherReadFound() {
        let field = CGRect(x: 10, y: 10, width: 100, height: 20), moved = CGRect(x: 10, y: 40, width: 100, height: 20)
        XCTAssertEqual(CaptureMasks.during(before: [field], after: [field]), [field])
        XCTAssertEqual(CaptureMasks.during(before: [field], after: [moved]), [field, moved], "a field that moved during capture is masked in both places")
        XCTAssertEqual(CaptureMasks.during(before: [], after: [moved]), [moved], "a field that appeared during capture is masked")
    }

    func testStepsOnAnObservedControlOrTheFilePanelCheckOnlyWhatTheyActOn() {
        XCTAssertTrue(Action.press("e1").checksOwnTarget)
        XCTAssertTrue(Action.setValue("e1", "x").checksOwnTarget)
        XCTAssertTrue(Action.saveAs(URL(fileURLWithPath: "/tmp/a.rtf"), replace: false).checksOwnTarget)
        XCTAssertTrue(Action.openInPanel(URL(fileURLWithPath: "/tmp/a.png")).checksOwnTarget)
        XCTAssertFalse(Action.key("enter", []).checksOwnTarget, "a key goes to whatever has the keyboard")
        XCTAssertFalse(Action.click(CGPoint(x: 1, y: 1), 1, []).checksOwnTarget, "a click checks the image where it lands")
        XCTAssertTrue(Action.saveAs(URL(fileURLWithPath: "/tmp/a.rtf"), replace: false).usesFilePanel)
        XCTAssertFalse(Action.press("e1").usesFilePanel)
    }

    /// A Maps batch of scroll, scroll, drag stopped at the second scroll: the first had moved the map.
    func testAScrollAfterTheBatchsOwnScrollsCarriesOnMovingTheSameView() {
        let point = CGPoint(x: 400, y: 300)
        let scroll = Action.scroll(point, 0, -3)
        XCTAssertTrue(BatchContinuation.continuesPan(scroll, after: [scroll][...]))
        XCTAssertTrue(BatchContinuation.continuesPan(scroll, after: [scroll, .wait(200), .drag([point, CGPoint(x: 500, y: 300)])][...]))
        XCTAssertFalse(BatchContinuation.continuesPan(scroll, after: [][...]), "the first step checks the image as observed")
        XCTAssertFalse(BatchContinuation.continuesPan(scroll, after: [.click(point, 1, [])][...]), "a click may have opened something there")
        XCTAssertFalse(BatchContinuation.continuesPan(.click(point, 1, []), after: [scroll][...]), "a click checks the image where it lands")
        // Maps: scroll, scroll, then a drag that pans on.
        let pan = Action.drag([point, CGPoint(x: 460, y: 330)])
        XCTAssertTrue(BatchContinuation.continuesPan(pan, after: [scroll, scroll][...]))
        XCTAssertFalse(BatchContinuation.continuesPan(pan, after: [][...]), "a first drag checks the image as observed")
        XCTAssertFalse(BatchContinuation.continuesPan(pan, after: [scroll, .key("enter", [])][...]))
    }

    /// Live's window was on another Space and the app opened as having no usable window.
    func testAWindowIsElsewhereOnlyWhenNoDisplayShowsItsSpace() {
        XCTAssertTrue(Spaces.isElsewhere(spaces: [565], visible: [5, 6]), "Live's dialog on the LG display's other desktop")
        XCTAssertFalse(Spaces.isElsewhere(spaces: [6], visible: [5, 6]), "shown on the LG display while the laptop's Space is active")
        XCTAssertFalse(Spaces.isElsewhere(spaces: [565, 6], visible: [5, 6]), "on every Space, so in view")
        XCTAssertFalse(Spaces.isElsewhere(spaces: [], visible: [6]), "on no Space: an invisible helper window, never moved")
        XCTAssertFalse(Spaces.isElsewhere(spaces: [565], visible: []), "unknown: never moved on a guess")
        XCTAssertEqual(Spaces.Way.allCases.map(\.rawValue), ["move_to_space", "window_manager", "window_manager_fallback"])
    }
}
