import XCTest
import AppKit
import ApplicationServices
@testable import ComputerUse

/// Editing values with real key presses, as a person does in a design app's inspector:
/// click a field, select all, type, Return.
final class KeyEditingTests: XCTestCase {
    private func key(_ name: String, _ modifiers: [String]? = nil) throws -> (String, CGEventFlags) {
        var raw: [String: Any] = ["type": "key", "key": name]
        if let modifiers { raw["modifiers"] = modifiers }
        guard case .key(let key, let flags) = try Action(raw, policy: .embedded) else { throw UseError("test", "not a key") }
        return (key, flags)
    }
    /// What has the keyboard after the previous step: (enabled, protected, text field).
    private func ready(_ focused: (Bool, Bool, Bool)?, field: Bool, typing: Bool = false, secureInput: Bool = false,
                       designKey: Bool = false, editingKey: Bool = false, afterClick: Bool = false, given: Bool = false) -> BatchContinuation.Keyboard {
        BatchContinuation.keyboard(focused: focused.map { (enabled: $0.0, protected: $0.1, textField: $0.2) }, field: field, typing: typing,
            entersText: typing, secureInput: secureInput, protectedOnScreen: false, credentialConfirmed: false, credentialGiven: given,
            designKey: designKey, editingKey: editingKey, afterClick: afterClick)
    }

    func testEditingKeysGoToANonTextControlInADesignAppWindow() throws {
        for (name, modifiers) in [("backspace", nil), ("delete", nil), ("backspace", ["option"]), ("enter", nil), ("escape", nil),
                                  ("tab", ["shift"]), ("up", ["shift"]), ("home", nil), ("page_down", nil)] as [(String, [String]?)] {
            let (key, flags) = try key(name, modifiers)
            XCTAssertTrue(NativeKey.isEditingKey(key, flags), name)
            // A stepper or value field the app draws itself has the keyboard, or nothing listed does.
            XCTAssertTrue(InputDelivery.editsInKeyWindow(key, flags, designApp: true, fieldFocused: false), name)
            // Elsewhere Delete on a focused list row deletes the message or file: an observed field is still needed.
            XCTAssertFalse(InputDelivery.editsInKeyWindow(key, flags, designApp: false, fieldFocused: false), name)
        }
        // An observed text field keeps its exact check, with refocus.
        XCTAssertFalse(InputDelivery.editsInKeyWindow("backspace", [], designApp: true, fieldFocused: true))
        XCTAssertFalse(NativeKey.isEditingKey("escape", .maskCommand), "Command-Escape is a blocked chord")
        XCTAssertFalse(NativeKey.isEditingKey("space", []), "space types text")
        XCTAssertTrue(InputDelivery.takesToolKeys(info: ["LSApplicationCategoryType": "public.app-category.graphics-design"]))
        // Mid-batch, after a click: the same rule for whatever reads back with the keyboard.
        XCTAssertEqual(ready((true, false, false), field: true, designKey: true), .keyWindow, "Backspace with a stepper focused")
        XCTAssertEqual(ready(nil, field: false, designKey: true), .keyWindow, "Return with nothing listed focused")
        XCTAssertEqual(ready((true, false, false), field: true), .stop, "not a design app: Delete still needs a text field")
        XCTAssertEqual(ready((true, false, true), field: true, designKey: true), .focus, "a listed text field is used exactly")
    }

    func testKeysAndTypingStillStopAtASecureFieldOrSecureInput() {
        XCTAssertEqual(ready((true, true, true), field: true, designKey: true), .stop, "a secure field has the keyboard")
        XCTAssertEqual(ready(nil, field: false, secureInput: true, designKey: true), .stop, "macOS reports secure input")
        XCTAssertEqual(ready((true, false, false), field: true, typing: true, secureInput: true, afterClick: true), .stop)
        XCTAssertEqual(ready((true, true, true), field: true, typing: true, afterClick: true), .stop)
        // An observed secure field keeps the exact path, which types only what the person confirmed.
        XCTAssertFalse(InputDelivery.editsInKeyWindow("backspace", [], designApp: true, fieldFocused: true))
        XCTAssertFalse(BatchContinuation.goesToEditor(.type("x"), afterClick: true, focus: (protected: true, textField: true), credentialGiven: false))
        XCTAssertFalse(BatchContinuation.goesToEditor(.type("x"), afterClick: true, focus: nil, credentialGiven: true),
            "a password the person gave goes only into a field that can be named")
        XCTAssertEqual(ready(nil, field: true, typing: true, afterClick: true, given: true), .stop)
    }

    func testClickThenSelectAllTypeAndEnterIsOneBatch() throws {
        let actions = try Action.batch(["actions": [
            ["type": "click", "x": 40, "y": 60], ["type": "key", "key": "a", "modifiers": ["command"]],
            ["type": "type", "text": "120"], ["type": "key", "key": "enter"]]], policy: .embedded)
        XCTAssertEqual(actions.map(\.name), ["click", "key", "type", "key"])
        // After the click, typing and editing keys go to what it gave the keyboard: nothing listed, a
        // value field the app draws itself, or a field editor.
        XCTAssertTrue(BatchContinuation.goesToEditor(actions[2], afterClick: true, focus: nil, credentialGiven: false))
        XCTAssertTrue(BatchContinuation.goesToEditor(actions[2], afterClick: true, focus: (protected: false, textField: false), credentialGiven: false))
        XCTAssertTrue(BatchContinuation.goesToEditor(actions[3], afterClick: true, focus: nil, credentialGiven: false))
        XCTAssertFalse(BatchContinuation.goesToEditor(actions[2], afterClick: true, focus: (protected: false, textField: true), credentialGiven: false),
            "a listed text field is typed into exactly, as before")
        XCTAssertFalse(BatchContinuation.goesToEditor(actions[2], afterClick: false, focus: (protected: false, textField: false), credentialGiven: false),
            "without the agent's own click, a non-text focus still needs an observation")
        XCTAssertFalse(BatchContinuation.goesToEditor(actions[1], afterClick: true, focus: nil, credentialGiven: false), "Command-A is a shortcut")
        XCTAssertEqual(ready((true, false, false), field: true, typing: true, afterClick: true), .editor)
        XCTAssertEqual(ready(nil, field: false, editingKey: true, afterClick: true), .editor, "Return after the click")
        XCTAssertEqual(ready((true, false, false), field: true, editingKey: true, afterClick: true), .editor, "Backspace: editable text is checked live")
        XCTAssertEqual(ready((true, false, false), field: true, typing: true), .stop, "no click in this batch")
        XCTAssertEqual(ready(nil, field: false, editingKey: true), .stop)
    }

    func testEnterValueParsesAndReportsWhetherTheValueTook() throws {
        guard case .enterValue(let ref, let text, let commit) = try Action(["type": "enter_value", "ref": "e7", "text": "120"], policy: .embedded) else {
            return XCTFail("enter_value")
        }
        XCTAssertEqual([ref, text], ["e7", "120"]); XCTAssertEqual(commit, .enter)
        guard case .enterValue(_, _, .tab) = try Action(["type": "enter_value", "ref": "e7", "text": "8", "commit": "tab"], policy: .embedded) else {
            return XCTFail("commit tab")
        }
        XCTAssertThrowsError(try Action(["type": "enter_value", "ref": "e7", "text": "8", "commit": "space"], policy: .embedded))
        XCTAssertThrowsError(try Action(["type": "enter_value", "ref": "e7", "text": ""], policy: .embedded))
        XCTAssertThrowsError(try Action(["type": "enter_value", "ref": "e7", "text": "8"], policy: .desktop), "Mac host only")
        let step = Action.enterValue("e7", "120", .enter)
        XCTAssertEqual(step.name, "enter_value")
        XCTAssertTrue(step.requiresControl); XCTAssertTrue(step.entersText)
        XCTAssertEqual(BatchContinuation.need(step), .control("e7"))
        XCTAssertFalse(InputDelivery.stepNeedsFront(step, route: .appKit), "background delivery keeps the person's front")
        // Read back inside the helper; only the outcome is reported.
        XCTAssertEqual(EnteredValue.outcome("120", before: "100" as CFString, after: "120" as CFString), "value_applied")
        XCTAssertEqual(EnteredValue.outcome("120", before: "100" as CFString, after: "120 px" as CFString), "value_applied")
        XCTAssertEqual(EnteredValue.outcome("120", before: NSNumber(value: 100), after: NSNumber(value: 120)), "value_applied")
        XCTAssertEqual(EnteredValue.outcome("120", before: "100" as CFString, after: "100" as CFString), "value_not_applied")
        XCTAssertEqual(EnteredValue.outcome("120", before: "100" as CFString, after: nil), "value_unconfirmed")
    }

    func testAKeyInAnAssistSessionSaysToReopenInControl() {
        let refusal = AccessMode.assist.refusal([.press("e1"), .key("end", .maskCommand), .type("x")])
        XCTAssertEqual(refusal.code, "scope_denied")
        XCTAssertEqual(refusal.next, "open_session")
        XCTAssertTrue(refusal.message.contains("assist mode"))
        XCTAssertTrue(refusal.message.contains("so key was not sent"), refusal.message)
        XCTAssertTrue(refusal.message.contains("open the app again with mode control"))
        XCTAssertTrue(AccessMode.observe.refusal([.press("e1")]).message.contains("observe mode, which only reads, so press"))
    }

    func testChordsWrittenAsOneNameAndMenuListedCommandShortcuts() throws {
        // Shift-U picks a tool in a design app, written either way.
        XCTAssertTrue(try { let (k, f) = try key("u+shift"); return NativeKey.isToolKey(k, f) && f == .maskShift }())
        XCTAssertTrue(try { let (k, f) = try key("shift+u"); return k == "u" && f == .maskShift }())
        // Command-N is outside the key list: it runs only as the menu command the app lists for it.
        let (n, command) = try key("n+command")
        XCTAssertEqual(NativeKey.chord(n, command), "command+n")
        XCTAssertTrue(NativeKey.isMenuShortcut(n, command))
        XCTAssertFalse(InputDelivery.stepNeedsFront(.key(n, command), route: .appKit), "a menu command needs no front")
        let entries = [MenuEntry(path: ["File", "New"], shortcut: "command+n")]
        XCTAssertEqual(InputDelivery.menuForShortcut(.key(n, command), in: entries), ["File", "New"])
        XCTAssertTrue(try { let (k, f) = try key("command+shift+g"); return NativeKey.chord(k, f) == "command+shift+g" && !NativeKey.isMenuShortcut(k, f) }(),
            "a listed chord keeps its own route")
        XCTAssertFalse(NativeKey.isMenuShortcut("s", .maskCommand), "listed")
        XCTAssertFalse(NativeKey.isMenuShortcut("n", [.maskCommand, .maskControl]), "Control chords are not menu shortcuts here")
        // Blocked chords stay blocked however they are written.
        XCTAssertThrowsError(try key("command+q")) { XCTAssertEqual(($0 as? UseError)?.code, "blocked_shortcut") }
        XCTAssertThrowsError(try key("w", ["command"])) { XCTAssertEqual(($0 as? UseError)?.code, "blocked_shortcut") }
        XCTAssertThrowsError(try key("command+tab")) { XCTAssertEqual(($0 as? UseError)?.code, "blocked_shortcut") }
        XCTAssertThrowsError(try key("command+shift+3")) { XCTAssertEqual(($0 as? UseError)?.code, "blocked_shortcut") }
        XCTAssertThrowsError(try key("a+b")) { XCTAssertEqual(($0 as? UseError)?.code, "unsupported_key") }
        XCTAssertThrowsError(try key("command+command+n")) { XCTAssertEqual(($0 as? UseError)?.code, "unsupported_key") }
        XCTAssertThrowsError(try Action(["type": "key", "key": "u+shift"], policy: .desktop), "the desktop policy keeps its plain list")
    }
}
