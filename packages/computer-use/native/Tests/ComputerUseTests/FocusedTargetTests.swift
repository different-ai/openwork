import AppKit
import Carbon.HIToolbox
import XCTest
@testable import ComputerUse

/// What made editing PhotoCraft work by hand: raw keys to the key window, a real double-click to
/// enter text editing, a check that editing started, and an honest receipt when nothing reads back.
final class FocusedTargetTests: XCTestCase {
    func testTypeKeyAndEnterValueTakeAFocusedTarget() throws {
        XCTAssertEqual(try Action(["type": "type", "text": "Come have coffee", "target": "focused"], policy: .embedded).name, "type")
        guard case .focused(.type("Come have coffee")) = try Action(["type": "type", "text": "Come have coffee", "target": "focused"], policy: .embedded) else { return XCTFail() }
        guard case .focused(.key("enter", [])) = try Action(["type": "key", "key": "enter", "target": "focused"], policy: .embedded) else { return XCTFail() }
        guard case .focused(.enter("300", .enter)) = try Action(["type": "enter_value", "text": "300", "target": "focused"], policy: .embedded) else { return XCTFail() }
        XCTAssertTrue(Action.focused(.type("x")).entersText, "the secure-field confirmation and password rules apply")
        XCTAssertThrowsError(try Action(["type": "type", "text": "x", "target": "window"], policy: .embedded))
        XCTAssertThrowsError(try Action(["type": "enter_value", "ref": "e4", "text": "3", "target": "focused"], policy: .embedded), "a ref or the focused target, not both")
        XCTAssertThrowsError(try Action(["type": "key", "key": "v", "modifiers": ["command"], "target": "focused"], policy: .embedded), "paste keeps its own step")
        XCTAssertThrowsError(try Action(["type": "key", "key": "n", "modifiers": ["command"], "target": "focused"], policy: .embedded), "menu-only shortcuts stay menu commands")
        XCTAssertThrowsError(try Action(["type": "type", "text": "x", "target": "focused"], policy: .desktop), "embedded only")
    }

    func testFocusedInputNeedsANamedEditorOrADesignAppsEditSession() {
        let type = FocusedInput.type("Come have coffee")
        XCTAssertNil(FocusedTarget.check(type, designApp: false, keyboard: .editor, editSession: false, afterOwnClick: false), "any app: an editor accessibility names")
        XCTAssertNil(FocusedTarget.check(.enter("300", .enter), designApp: true, keyboard: .editor, editSession: false, afterOwnClick: false), "an incrementor value field")
        XCTAssertEqual(FocusedTarget.check(type, designApp: false, keyboard: .other, editSession: true, afterOwnClick: true)?.code, "focus_required",
            "outside design apps nothing unnamed takes keys: Delete on a list row can delete a file")
        XCTAssertEqual(FocusedTarget.check(.key("delete", []), designApp: false, keyboard: .nothing, editSession: false, afterOwnClick: true)?.code, "focus_required")
        XCTAssertNil(FocusedTarget.check(.key("enter", []), designApp: true, keyboard: .nothing, editSession: false, afterOwnClick: false), "a design app's editing key, as without the target")
    }

    func testCanvasTypingWaitsForTheEditSessionTheAgentsClickOpened() {
        let type = FocusedInput.type("Come have coffee")
        // Typed before editing started, the letters picked tools ("F" is Cycle Screen Mode).
        XCTAssertEqual(FocusedTarget.check(type, designApp: true, keyboard: .nothing, editSession: false, afterOwnClick: true)?.code, "text_edit_not_active")
        XCTAssertEqual(FocusedTarget.check(.enter("300", .enter), designApp: true, keyboard: .other, editSession: false, afterOwnClick: true)?.code, "text_edit_not_active",
            "Command-A and digits would select all layers and set opacity")
        XCTAssertEqual(FocusedTarget.check(type, designApp: true, keyboard: .nothing, editSession: true, afterOwnClick: false)?.code, "text_edit_not_active",
            "an edit session the agent did not open is not where it meant to type")
        XCTAssertNil(FocusedTarget.check(type, designApp: true, keyboard: .nothing, editSession: true, afterOwnClick: true), "after its double-click opened one")
        XCTAssertTrue(MacAccessibility.textEditNotActive.message.contains("Double-click the text with the Type tool first, then type"))
    }

    @MainActor
    func testFocusedInputIsRefusedUnderSecureInput() throws {
        EnableSecureEventInput()
        defer { DisableSecureEventInput() }
        let app = NSRunningApplication.current
        let identity = AppIdentity(app: app, bundleID: "test", executable: app.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0]), launched: try XCTUnwrap(AppIdentity.ProcessStart(pid: getpid())))
        let window = WindowTarget(id: 1, title: "Canvas", element: AXUIElementCreateApplication(getpid()), frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        XCTAssertThrowsError(try MacAccessibility().focusedKeyboard(target: window, app: identity, requireFront: false)) { error in
            XCTAssertEqual((error as? UseError)?.code, "protected_input", "a password box anywhere stops focused input before a key is sent")
        }
    }

    func testFocusedInputStopsAtAnyWindowThatOpened() {
        XCTAssertEqual(BatchContinuation.need(.focused(.type("x"))), .keyWindow)
        XCTAssertFalse(BatchContinuation.runsPast(["panel_opened": true], need: .keyWindow, sessionHasKeyboard: true),
            "unlike a named field, raw keys never run past a new window")
        XCTAssertTrue(BatchContinuation.runsPast(nil, need: .keyWindow, sessionHasKeyboard: true))
    }

    @MainActor
    func testADoubleClickIsTwoRealClicksNeverAnAccessibilityPress() async throws {
        let step = try Action(["type": "double_click", "x": 40, "y": 30], policy: .embedded)
        guard case .click(_, 2, []) = step else { return XCTFail("double_click is pointer input") }
        XCTAssertTrue(step.usesCoordinates)
        XCTAssertFalse(step.requiresControl == false, "pointer input needs control mode, unlike a press")
        var events: [String] = []
        try await InputDispatch.press(clicks: 2, check: {}, validate: {}, move: { events.append("move") },
            down: { events.append("down \($0)") }, up: { events.append("up \($0)") }, pace: { _ in })
        XCTAssertEqual(events, ["move", "down 1", "up 1", "down 2", "up 2"], "each event carries its click count, 1 then 2")
        guard case .click(_, 1, []) = try Action(["type": "click", "x": 40, "y": 30], policy: .embedded) else { return XCTFail("a single click stays a click") }
    }

    func testUnverifiedInputIsReportedAsDispatchedNotRefused() {
        var progress = BatchProgress(actions: ["double_click", "type"])
        progress.dispatched(path: "targeted_input")
        progress.dispatched(path: FocusedTarget.unverified)
        let receipt = progress.receipt(requestID: "r1", detailed: true)
        XCTAssertEqual(receipt["ok"] as? Bool, true)
        XCTAssertEqual(receipt["status"] as? String, "dispatched")
        let steps = receipt["steps"] as? [[String: Any]]
        XCTAssertEqual(steps?.last?["path"] as? String, "raw_input_unverified")
        XCTAssertEqual(receipt["outcome_verified"] as? Bool, false)
    }

    func testAWindowOnAnotherSpaceIsReportedAndOthersAreBroughtBack() {
        XCTAssertEqual(WindowPresence.of(listed: true, onScreen: true, minimized: false, appHidden: false), .here)
        XCTAssertEqual(WindowPresence.of(listed: true, onScreen: false, minimized: false, appHidden: false), .otherSpace)
        XCTAssertEqual(WindowPresence.of(listed: true, onScreen: false, minimized: true, appHidden: false), .minimized)
        XCTAssertEqual(WindowPresence.of(listed: true, onScreen: false, minimized: true, appHidden: true), .hidden, "unhiding the app shows it first")
        XCTAssertEqual(WindowPresence.of(listed: false, onScreen: false, minimized: false, appHidden: false), .gone)
        XCTAssertEqual(WindowPresence.offSpace.code, "window_off_space")
        XCTAssertTrue(WindowPresence.offSpace.message.contains("another Space"))
    }
}
