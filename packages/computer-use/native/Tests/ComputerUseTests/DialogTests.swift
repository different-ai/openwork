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
        XCTAssertTrue(HandoverRules.message("permission").contains("Observe again"), "an action points to the observation that waits")
        XCTAssertTrue(HandoverRules.message("permission", waited: true).contains("ask them to"))
    }

    @MainActor
    func testAnObservationCarriesOnOnceThePersonAnswers() async throws {
        var clock: TimeInterval = 0
        let open = try await HandoverRules.waitForPerson(prompt: { clock < 3 ? ("permission", "macOS") : nil },
            check: {}, now: { clock }, sleep: { clock += $0 })
        XCTAssertNil(open)
        XCTAssertGreaterThanOrEqual(clock, 3)
        XCTAssertLessThan(clock, 3 + HandoverRules.personPoll * 2)
    }

    @MainActor
    func testAPromptLeftOpenIsHandedBackAfterTheWait() async throws {
        var clock: TimeInterval = 0
        let open = try await HandoverRules.waitForPerson(prompt: { ("sign_in", "Security Agent") },
            check: {}, now: { clock }, sleep: { clock += $0 })
        XCTAssertEqual(open?.reason, "sign_in")
        XCTAssertGreaterThanOrEqual(clock, HandoverRules.personWait)
        XCTAssertLessThan(clock, HandoverRules.personWait + HandoverRules.personPoll * 2)
    }

    @MainActor
    func testStopEndsTheWaitForThePerson() async throws {
        var clock: TimeInterval = 0
        do {
            _ = try await HandoverRules.waitForPerson(prompt: { ("permission", "macOS") }, check: {
                if clock > 2 { throw UseError("session_changed", "Access ended", next: "human_takeover") }
            }, now: { clock }, sleep: { clock += $0 })
            XCTFail("The wait outlived Stop")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_changed")
            XCTAssertLessThan(clock, HandoverRules.personWait)
        }
    }

    func testOnlyWindowsTheLastActionOpenedAreFollowed() {
        XCTAssertTrue(HandoverRules.followsNewWindow(focused: 9, target: 4, opened: [9]), "a sign-in popup the click opened")
        XCTAssertFalse(HandoverRules.followsNewWindow(focused: 9, target: 4, opened: []), "a window the person opened stays theirs")
        XCTAssertFalse(HandoverRules.followsNewWindow(focused: 4, target: 4, opened: [4]))
        XCTAssertFalse(HandoverRules.followsNewWindow(focused: nil, target: 4, opened: [9]))
    }
}
