import XCTest
import AppKit
import ApplicationServices
@testable import ComputerUse

/// focus and expect make a multi-step edit deterministic: the keyboard goes where the agent
/// means, and a batch stops before any later input when the state is not what it expected.
final class FocusAndExpectTests: XCTestCase {
    private func expect(_ values: [String: Any]) throws -> Expectation {
        guard case .expect(let expectation) = try Action(values.merging(["type": "expect"]) { _, new in new }, policy: .embedded) else {
            throw UseError("test", "not an expect step")
        }
        return expectation
    }

    func testFocusPutsTheKeyboardOnARefAndClicksOnlyInControl() throws {
        guard case .focus(let ref) = try Action(["type": "focus", "ref": "e12"], policy: .embedded) else { return XCTFail("focus") }
        XCTAssertEqual(ref, "e12")
        XCTAssertThrowsError(try Action(["type": "focus", "ref": "e12", "x": 4], policy: .embedded))
        XCTAssertThrowsError(try Action(["type": "focus", "ref": "e12"], policy: .desktop), "Mac host only")
        let step = Action.focus("e12")
        XCTAssertFalse(step.requiresControl, "accessibility focus works in assist")
        XCTAssertFalse(step.entersText)
        XCTAssertEqual(BatchContinuation.need(step), .control("e12"), "mid-batch it needs its control unchanged")
        XCTAssertFalse(InputDelivery.stepNeedsFront(step, route: .appKit))
        XCTAssertTrue(FocusStep.clicks(in: .control))
        XCTAssertFalse(FocusStep.clicks(in: .assist), "a click is pointer input: assist only uses accessibility focus")
        XCTAssertFalse(FocusStep.clicks(in: .observe))
        // After focus, the keys and typing that follow go to it.
        XCTAssertTrue(BatchContinuation.goesToEditor(.type("120"), afterClick: true, focus: nil, credentialGiven: false))
    }

    func testFocusRefusesASecureOrDisabledField() {
        XCTAssertNoThrow(try FocusStep.checkFocusable(protected: false, enabled: true))
        XCTAssertThrowsError(try FocusStep.checkFocusable(protected: true, enabled: true)) {
            XCTAssertEqual(($0 as? UseError)?.code, "protected_input")
        }
        XCTAssertThrowsError(try FocusStep.checkFocusable(protected: false, enabled: false))
        XCTAssertThrowsError(try FocusStep.checkComparable(protected: true), "a secure field's value is never read") {
            XCTAssertEqual(($0 as? UseError)?.code, "protected_input")
        }
        XCTAssertNoThrow(try FocusStep.checkComparable(protected: false))
    }

    func testExpectParsesEachCheck() throws {
        XCTAssertEqual(try expect(["focused": "e12"]).focused, .ref("e12"))
        XCTAssertEqual(try expect(["focused": "text_input"]).focused, .textInput)
        XCTAssertEqual(try expect(["front": true]).front, true)
        XCTAssertEqual(try expect(["enabled": "e3"]).enabled, "e3")
        XCTAssertEqual(try expect(["exists": "e4"]).exists, "e4")
        XCTAssertEqual(try expect(["gone": "e5"]).gone, "e5")
        XCTAssertEqual(try expect(["dialog": "open"]).dialog, true)
        XCTAssertEqual(try expect(["dialog": "closed"]).dialog, false)
        let value = try expect(["value": ["ref": "e12", "equals": "120"]])
        XCTAssertEqual([value.valueRef, value.valueEquals], ["e12", "120"])
        XCTAssertEqual(try expect(["value": ["ref": "e12", "equals": ""]]).valueEquals, "", "an empty field can be expected")
        XCTAssertEqual(try expect(["title_contains": "Poster"]).titleContains, "Poster")
        let all = try expect(["focused": "e12", "front": true, "enabled": "e3", "exists": "e4", "gone": "e5", "dialog": "closed",
                              "value": ["ref": "e12", "equals": "120"], "title_contains": "Poster"])
        XCTAssertEqual(all.checks, ["focused", "front", "enabled", "exists", "gone", "dialog", "value", "title_contains"])
        XCTAssertEqual(all.refs, ["e12", "e3", "e4", "e5", "e12"])
        XCTAssertThrowsError(try expect([:]), "at least one check")
        XCTAssertThrowsError(try expect(["dialog": "maybe"]))
        XCTAssertThrowsError(try expect(["value": ["ref": "e12"]]))
        XCTAssertThrowsError(try expect(["value": ["ref": "e12", "equals": "1", "x": 1]]))
        XCTAssertThrowsError(try expect(["front": "yes"]))
        XCTAssertThrowsError(try expect(["unknown": "e1"]))
        let step = Action.expect(all)
        XCTAssertEqual(step.name, "expect")
        XCTAssertFalse(step.requiresControl); XCTAssertFalse(step.changesWindow); XCTAssertFalse(step.entersText)
        XCTAssertFalse(InputDelivery.stepNeedsFront(step, route: .skyLight))
    }

    func testEachCheckHoldsOrNamesItselfWhenItDoesNot() {
        XCTAssertNil(Expectation.failure([("focused", true), ("value", true)]))
        for check in ["focused", "front", "enabled", "exists", "gone", "dialog", "value", "title_contains"] {
            let failed = Expectation.failure([("front", true), (check, false), ("value", false)])
            XCTAssertEqual(failed?.code, "expectation_failed")
            XCTAssertEqual(failed?.next, "observe")
            XCTAssertTrue(failed?.message.contains("\(check) check did not hold") == true, check)
        }
        XCTAssertTrue(Expectation.failure([("value", true), ("dialog", false)])?.message.contains("dialog check") == true, "the first that failed")
    }

    func testValueIsComparedInTheHelperAndNeverReported() {
        XCTAssertTrue(Expectation.valueMatches("120" as CFString, "120"))
        XCTAssertTrue(Expectation.valueMatches(" 120 " as CFString, "120"))
        XCTAssertTrue(Expectation.valueMatches("120.0" as CFString, "120"), "the same number")
        XCTAssertTrue(Expectation.valueMatches(NSNumber(value: 120), "120"))
        XCTAssertFalse(Expectation.valueMatches("100" as CFString, "120"))
        XCTAssertFalse(Expectation.valueMatches("120 px" as CFString, "120"), "equals means equals")
        XCTAssertFalse(Expectation.valueMatches(nil, "120"))
        XCTAssertFalse(Expectation.valueMatches(kCFBooleanTrue, "1"), "a checkbox is not a number")
        // What leaves the helper: which check, and whether it held. Neither text appears.
        let secret = "s3cr3t-value", wanted = "w4nted-value"
        let failure = Expectation.failure([("value", Expectation.valueMatches(secret as CFString, wanted))])!
        var progress = BatchProgress(actions: ["expect", "key"])
        let receipt = progress.receipt(requestID: "r1", failure: failure, detailed: true)
        let checks: [[String: Any]] = [["step": 0, "check": "value", "ok": false]]
        let text = String(decoding: try! JSONSerialization.data(withJSONObject: [receipt, checks].map { $0 }), as: UTF8.self)
        XCTAssertFalse(text.contains(secret)); XCTAssertFalse(text.contains(wanted))
        progress.dispatched(path: "expected")
        XCTAssertFalse(progress.hasInput)
    }

    func testAFailedExpectStopsTheBatchBeforeAnyLaterInput() throws {
        let actions = try Action.batch(["actions": [
            ["type": "focus", "ref": "e12"], ["type": "expect", "focused": "e12"],
            ["type": "key", "key": "a", "modifiers": ["command"]], ["type": "type", "text": "120"], ["type": "key", "key": "enter"],
            ["type": "expect", "value": ["ref": "e12", "equals": "120"]]]], policy: .embedded)
        XCTAssertEqual(actions.map(\.name), ["focus", "expect", "key", "type", "key", "expect"])
        // focus landed, then expect {focused} did not hold: nothing after it is sent.
        var progress = BatchProgress(actions: actions.map(\.name))
        progress.dispatched(path: "focused")
        let failure = Expectation.failure([("focused", false)])!
        let receipt = progress.receipt(requestID: "r2", failure: failure, detailed: true)
        XCTAssertEqual(receipt["code"] as? String, "expectation_failed")
        XCTAssertEqual(receipt["failed_step"] as? Int, 1)
        let steps = receipt["steps"] as? [[String: Any]] ?? []
        XCTAssertEqual(steps.map { $0["status"] as? String }, ["dispatched", "skipped", "skipped", "skipped", "skipped", "skipped"])
        // An expect that holds is not input: a batch of checks alone may_have_acted false.
        var checksOnly = BatchProgress(actions: ["expect"])
        checksOnly.dispatched(path: "expected")
        XCTAssertFalse(checksOnly.hasInput)
    }
}
