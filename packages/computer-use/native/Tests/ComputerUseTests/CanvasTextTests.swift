import XCTest
@testable import ComputerUse

/// Design apps that draw their own text editor (PhotoCraft is egui on winit) report no focused
/// element while a text layer is being edited, so typing after the agent's click had nowhere to go.
final class CanvasTextTests: XCTestCase {
    func testTypingAfterTheAgentsClickGoesToADesignAppsKeyWindow() {
        XCTAssertTrue(BatchContinuation.canvasText(designApp: true, afterOwnClick: true, credentialGiven: false, reported: .nothing))
        XCTAssertTrue(BatchContinuation.canvasText(designApp: true, afterOwnClick: true, credentialGiven: false, reported: .window),
            "the app reports only its window")
    }

    func testCanvasTextNeedsTheClickTheAppAndNoPassword() {
        XCTAssertFalse(BatchContinuation.canvasText(designApp: false, afterOwnClick: true, credentialGiven: false, reported: .nothing),
            "outside design apps, typing needs a field or editor the app names")
        XCTAssertFalse(BatchContinuation.canvasText(designApp: true, afterOwnClick: false, credentialGiven: false, reported: .nothing),
            "without the agent's own click, nothing says where the text goes")
        XCTAssertFalse(BatchContinuation.canvasText(designApp: true, afterOwnClick: true, credentialGiven: true, reported: .nothing),
            "a password or code goes only into a field that can be named")
        XCTAssertFalse(BatchContinuation.canvasText(designApp: true, afterOwnClick: true, credentialGiven: false, reported: .element),
            "an element the app reports is checked by the editor rule, which refuses a secure one")
    }

    func testTheBatchStillStopsOnAnythingSecure() {
        func keyboard(secureInput: Bool = false, protectedOnScreen: Bool = false, given: Bool = false) -> BatchContinuation.Keyboard {
            BatchContinuation.keyboard(focused: nil, field: true, typing: true, entersText: true, secureInput: secureInput,
                protectedOnScreen: protectedOnScreen, credentialConfirmed: false, credentialGiven: given, afterClick: true)
        }
        XCTAssertEqual(keyboard(), .editor, "click then type on a canvas reaches the editor or canvas-text check")
        XCTAssertEqual(keyboard(secureInput: true), .stop, "macOS reports a password box somewhere")
        XCTAssertEqual(keyboard(protectedOnScreen: true), .stop, "a secure field the person has not confirmed is on screen")
        XCTAssertEqual(keyboard(given: true), .stop)
    }

    func testTheRefusalSaysHowToStartEditingCanvasText() {
        let refusal = MacAccessibility.canvasTextRequired
        XCTAssertEqual(refusal.code, "focus_required")
        XCTAssertTrue(refusal.message.contains("double-click"))
        XCTAssertTrue(refusal.message.contains("Type tool"))
        XCTAssertTrue(refusal.message.contains("same batch"))
    }
}
