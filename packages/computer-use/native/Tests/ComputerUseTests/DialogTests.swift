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

    func testOpenInPanelTakesAnExistingFileWithLinksResolvedAndRefusesFolders() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("photos"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let map = folder.appendingPathComponent("photos/map.png")
        try Data([1]).write(to: map)
        let link = folder.appendingPathComponent("latest.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: map)

        guard case .openInPanel(let file) = try Action(["type": "open_in_panel", "path": link.path], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(file.path, map.resolvingSymlinksInPath().path, "the panel gets the file a link points to")
        XCTAssertEqual(try Action(["type": "open_in_panel", "path": map.path], policy: .embedded).name, "open_in_panel")
        XCTAssertTrue(try Action(["type": "open_in_panel", "path": map.path], policy: .embedded).requiresControl)
        for (path, code) in [("map.png", "invalid_arguments"), (folder.appendingPathComponent("photos").path, "file_unavailable"),
                             (folder.appendingPathComponent("missing.png").path, "file_unavailable")] {
            XCTAssertThrowsError(try Action(["type": "open_in_panel", "path": path], policy: .embedded), path) { error in
                XCTAssertEqual((error as? UseError)?.code, code, path)
            }
        }
        XCTAssertThrowsError(try Action(["type": "open_in_panel", "path": map.path, "replace": true], policy: .embedded))
        XCTAssertThrowsError(try Action(["type": "open_in_panel", "path": map.path], policy: .desktop), "only the OpenWork host offers it")
    }

    func testOpenInPanelIsOnlyForAnOpenStylePanel() {
        for title in ["Open", "Place", "Insert", "Choose", " attach "] {
            XCTAssertTrue(OpenPanelRules.isOpenPanel(kind: .filePanel, saveField: false, defaultButton: title), title)
        }
        XCTAssertFalse(OpenPanelRules.isOpenPanel(kind: .filePanel, saveField: true, defaultButton: "Open"), "a Save sheet has a name field")
        XCTAssertFalse(OpenPanelRules.isOpenPanel(kind: .filePanel, saveField: false, defaultButton: "Save"))
        XCTAssertFalse(OpenPanelRules.isOpenPanel(kind: .sheet, saveField: false, defaultButton: "Open"), "a sheet with no file browser")
        XCTAssertFalse(OpenPanelRules.isOpenPanel(kind: nil, saveField: false, defaultButton: "Open"), "no panel is open")
        XCTAssertFalse(OpenPanelRules.isOpenPanel(kind: .filePanel, saveField: false, defaultButton: nil))
        XCTAssertTrue(DialogRules.isFilePanel(bundleID: "com.adobe.Photoshop", roles: ["AXOutline"], defaultButton: "Place"),
            "Photoshop's Place panel is a file panel")
    }

    @MainActor
    func testPickingAFileGoesToItReadsItBackAndPressesTheDefaultButton() async throws {
        let file = URL(fileURLWithPath: "/Users/someone/Desktop/map.png")
        var steps: [String] = []
        var field = ""
        try await OpenPanelRules.pick(file, goTo: { path in
            try await PanelGoTo.enter(path, open: { steps.append("go_to"); return "go-to field" },
                set: { _, value in field = value; steps.append("set"); return true },
                value: { _ in field }, submit: { _ in steps.append("return") })
        }, selection: { ["map.png"] }, until: { $0() },
           button: { ("Place", true) }, press: { steps.append("place"); return .success })
        XCTAssertEqual(field, file.path, "the file's own path goes into Go To")
        XCTAssertEqual(steps, ["go_to", "set", "return", "place"], "read back before Return, the press last")

        // A Save sheet's folder goes through the same Go To field.
        var folder = ""
        let saved = try await PanelGoTo.enter("/Users/someone/Desktop", open: { 1 }, set: { _, value in folder = value; return true },
            value: { _ in folder }, submit: { _ in })
        XCTAssertNil(saved)
        XCTAssertEqual(folder, "/Users/someone/Desktop")
    }

    @MainActor
    func testNothingIsPressedUnlessThePathAndTheSelectionReadBack() async throws {
        let file = URL(fileURLWithPath: "/Users/someone/Desktop/map.png")
        func attempt(goTo: PanelGoTo.Failure? = nil, selected: [String] = ["map.png"], button: (title: String?, enabled: Bool)? = ("Open", true),
                     pressed: AXError = .success) async -> (code: String?, pressed: Bool) {
            var didPress = false
            do {
                try await OpenPanelRules.pick(file, goTo: { _ in goTo }, selection: { selected }, until: { $0() },
                    button: { button }, press: { didPress = true; return pressed })
                return (nil, didPress)
            } catch { return ((error as? UseError)?.code, didPress) }
        }
        var result = await attempt(goTo: .noField)
        XCTAssertEqual(result.code, "panel_path_unavailable"); XCTAssertFalse(result.pressed)
        result = await attempt(goTo: .notTaken)
        XCTAssertEqual(result.code, "panel_path_unavailable"); XCTAssertFalse(result.pressed)
        for selected in [[], ["other.png"], ["map.png", "map.png"]] {
            result = await attempt(selected: selected)
            XCTAssertEqual(result.code, "file_not_selected", "\(selected)"); XCTAssertFalse(result.pressed)
        }
        for button in [nil, ("Save", true), ("Open", false)] as [(title: String?, enabled: Bool)?] {
            result = await attempt(button: button)
            XCTAssertEqual(result.code, "open_panel_required"); XCTAssertFalse(result.pressed)
        }
        result = await attempt(pressed: .failure)
        XCTAssertEqual(result.code, "action_failed")
        result = await attempt(pressed: .cannotComplete)
        XCTAssertNil(result.code, "a press that opened something modal was delivered")

        // A value the field did not keep is never entered.
        var submitted = false
        let failure = try await PanelGoTo.enter(file.path, open: { 1 }, set: { _, _ in true }, value: { _ in "/Users/someone/Desk" },
            submit: { _ in submitted = true })
        XCTAssertEqual(failure, .notTaken)
        XCTAssertFalse(submitted)
    }

    func testTheSelectionMatchesTheFileEvenWithItsExtensionHidden() {
        let file = URL(fileURLWithPath: "/tmp/map.png")
        XCTAssertTrue(OpenPanelRules.selects(["map.png"], file: file, displayName: "map.png"))
        XCTAssertTrue(OpenPanelRules.selects(["map"], file: file, displayName: "map"))
        XCTAssertFalse(OpenPanelRules.selects(["map"], file: file, displayName: "map.png"))
        XCTAssertFalse(OpenPanelRules.selects(["map.png", "notes.txt"], file: file, displayName: "map.png"))
    }

    func testAnAlertAfterThePanelIsAFailureAndAQuietAppIsUnconfirmed() {
        let alert = FileOpenCheck.alert(title: "Could not place", texts: ["The file is not a supported type."])
        XCTAssertEqual(OpenPanelRules.outcome(panelOpen: false, alert: alert, windowOpened: true, retitled: false, contentChanged: false), "file_open_failed")
        XCTAssertEqual(OpenPanelRules.outcome(panelOpen: true, alert: alert, windowOpened: false, retitled: false, contentChanged: false), "file_open_failed")
        XCTAssertNil(OpenPanelRules.outcome(panelOpen: true, alert: nil, windowOpened: true, retitled: true, contentChanged: true), "still in the panel")
        XCTAssertEqual(OpenPanelRules.outcome(panelOpen: false, alert: nil, windowOpened: true, retitled: false, contentChanged: false), "file_chosen")
        XCTAssertEqual(OpenPanelRules.outcome(panelOpen: false, alert: nil, windowOpened: false, retitled: true, contentChanged: false), "file_chosen")
        XCTAssertEqual(OpenPanelRules.outcome(panelOpen: false, alert: nil, windowOpened: false, retitled: false, contentChanged: true), "file_chosen")
        XCTAssertNil(OpenPanelRules.outcome(panelOpen: false, alert: nil, windowOpened: false, retitled: false, contentChanged: false), "nothing to show yet")
    }
}
