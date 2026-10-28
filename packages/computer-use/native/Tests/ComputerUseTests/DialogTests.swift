import XCTest
import ApplicationServices
@testable import ComputerUse

final class DialogTests: XCTestCase {
    func testFilePanelsAreRecognizedWithoutNaggingForOtherDialogs() {
        XCTAssertTrue(DialogRules.isFilePanel(bundleID: AppIdentity.filePanelService, roles: [], defaultButton: nil),
            "the system panel process only ever shows file panels")
        XCTAssertTrue(DialogRules.isFilePanel(bundleID: "com.google.Chrome", roles: ["AXBrowser", "AXButton"], defaultButton: "Open"))
        XCTAssertTrue(DialogRules.isFilePanel(bundleID: "com.google.Chrome", roles: ["AXOutline", "AXButton"], defaultButton: "Upload"))
        XCTAssertFalse(DialogRules.isFilePanel(bundleID: "com.apple.TextEdit", roles: ["AXButton", "AXStaticText"], defaultButton: "Save"),
            "a save-changes alert is not a file panel")
        XCTAssertFalse(DialogRules.isFilePanel(bundleID: "com.example.app", roles: ["AXOutline"], defaultButton: "Done"))
    }

    func testConfirmingAFilePanelIsTheDefaultButtonOrReturn() {
        let button = AXUIElementCreateApplication(1)
        let other = AXUIElementCreateApplication(2)
        XCTAssertTrue(DialogRules.confirmsFilePanel(.press("e1"), pressed: button, defaultButton: button))
        XCTAssertFalse(DialogRules.confirmsFilePanel(.press("e2"), pressed: other, defaultButton: button), "Cancel or a file row is not a confirmation")
        XCTAssertTrue(DialogRules.confirmsFilePanel(.key("enter", []), pressed: nil, defaultButton: button))
        XCTAssertTrue(DialogRules.confirmsFilePanel(.key("return", []), pressed: nil, defaultButton: nil))
        XCTAssertFalse(DialogRules.confirmsFilePanel(.type("launch.mp4"), pressed: nil, defaultButton: button))
        XCTAssertFalse(DialogRules.confirmsFilePanel(.press("e1"), pressed: button, defaultButton: nil))
    }

    func testOnlyPromptsThePersonMustAnswerAreHandedOver() {
        XCTAssertEqual(HandoverRules.reason(bundleID: "com.apple.UserNotificationCenter"), "permission")
        XCTAssertEqual(HandoverRules.reason(bundleID: "com.apple.SecurityAgent"), "sign_in")
        XCTAssertEqual(HandoverRules.reason(bundleID: "com.apple.PassbookUIService"), "payment")
        XCTAssertNil(HandoverRules.reason(bundleID: "com.apple.TextEdit"))
        XCTAssertNil(HandoverRules.reason(bundleID: nil))
        XCTAssertTrue(HandoverRules.message("payment").contains("Nothing was sent"))
    }

    func testOnlyWindowsTheLastActionOpenedAreFollowed() {
        XCTAssertTrue(HandoverRules.followsNewWindow(focused: 9, target: 4, opened: [9]), "a sign-in popup the click opened")
        XCTAssertFalse(HandoverRules.followsNewWindow(focused: 9, target: 4, opened: []), "a window the person opened stays theirs")
        XCTAssertFalse(HandoverRules.followsNewWindow(focused: 4, target: 4, opened: [4]))
        XCTAssertFalse(HandoverRules.followsNewWindow(focused: nil, target: 4, opened: [9]))
    }
}
