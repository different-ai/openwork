import XCTest
import ApplicationServices
@testable import ComputerUse

final class ObservationListingTests: XCTestCase {
    func testRefsStayWithTheirControlAndAreNeverReusedForAnother() {
        var refs = StableRefs<String>(hash: { $0.hashValue }, same: { $0 == $1 })
        XCTAssertEqual(refs.assign(["clear", "one", "two"], window: 7), ["e1", "e2", "e3"])
        // A control appears above the others: they keep their refs.
        XCTAssertEqual(refs.assign(["result", "clear", "one", "two"], window: 7), ["e4", "e1", "e2", "e3"])
        // A control goes away and later returns: its old ref is not handed to anything else meanwhile.
        XCTAssertEqual(refs.assign(["result", "two"], window: 7), ["e4", "e3"])
        XCTAssertEqual(refs.assign(["result", "two", "one"], window: 7), ["e4", "e3", "e5"])
        // Another window starts over without reusing any ref from this session.
        XCTAssertEqual(refs.assign(["clear"], window: 8), ["e6"])
    }

    func testTwoReadsOfTheSameIdentityNeverShareARef() {
        var refs = StableRefs<String>(hash: { _ in 0 }, same: { $0 == $1 })
        XCTAssertEqual(refs.assign(["a", "a"], window: 1), ["e1", "e2"])
    }

    func testInvisibleDirectionMarksAreDroppedFromListedText() throws {
        XCTAssertEqual(ElementRecord.visibleText("\u{200E}12\u{200E}×\u{200E}34"), "12×34")
        XCTAssertEqual(ElementRecord.visibleText("\u{2068}TextEdit\u{2069} — iCloud"), "TextEdit — iCloud")
        let record = ElementRecord(ref: "e1", element: AXUIElementCreateSystemWide(), role: "AXStaticText", label: "\u{200F}Total",
            value: "\u{200E}408", frame: CGRect(x: 0, y: 0, width: 50, height: 20), actions: [], settable: false, enabled: true, protected: false)
        let payload = try record.payload(bounds: CGRect(x: 0, y: 0, width: 100, height: 100), width: 100, height: 100, compact: true)
        XCTAssertEqual(payload["label"] as? String, "Total")
        XCTAssertEqual(payload["value"] as? String, "408")
    }

    func testTitleBarButtonsAreNamedFromTheirSubrole() {
        XCTAssertEqual(ElementRecord.windowButtonLabel(subrole: "AXCloseButton"), "Close window")
        XCTAssertEqual(ElementRecord.windowButtonLabel(subrole: "AXMinimizeButton"), "Minimize window")
        XCTAssertEqual(ElementRecord.windowButtonLabel(subrole: "AXZoomButton"), "Zoom window")
        XCTAssertNil(ElementRecord.windowButtonLabel(subrole: "AXSecureTextField"))
        XCTAssertNil(ElementRecord.windowButtonLabel(subrole: nil))
    }

    func testOnlySliversAndUnnamedWrappersOverTheirParentAreLeftOut() {
        let window = CGRect(x: 0, y: 0, width: 1728, height: 1026)
        XCTAssertTrue(ElementRecord.isClutter(role: "AXGroup", label: "", value: nil, frame: window, parentFrame: window))
        XCTAssertTrue(ElementRecord.isClutter(role: "AXRow", label: "Threads", value: nil, frame: CGRect(x: 117, y: 109, width: 193, height: 1), parentFrame: window))
        XCTAssertFalse(ElementRecord.isClutter(role: "AXGroup", label: "Messages", value: nil, frame: window, parentFrame: window))
        XCTAssertFalse(ElementRecord.isClutter(role: "AXButton", label: "", value: nil, frame: window, parentFrame: window))
        XCTAssertFalse(ElementRecord.isClutter(role: "AXGroup", label: "", value: nil, frame: CGRect(x: 0, y: 67, width: 1199, height: 1213), parentFrame: window))
    }

    func testACappedListingStillAllowsTheImageButAnIncompleteScanDoesNot() throws {
        let record = ElementRecord(ref: "e1", element: AXUIElementCreateSystemWide(), role: "AXStaticText", label: "", value: "x",
            frame: CGRect(x: 0, y: 0, width: 10, height: 10), actions: [], settable: false, enabled: true, protected: false)
        let capped = WindowState(records: [record], visited: 900, truncated: false, protectedFrames: [], listCapped: true)
        XCTAssertNoThrow(try capped.requireCapture())
        let cut = WindowState(records: [record], visited: 1500, truncated: true, protectedFrames: [], privacyIssue: "tree_limit", listCapped: true)
        XCTAssertThrowsError(try cut.requireCapture())
    }

    func testABatchContinuesOnlyWithTheExactUnchangedControl() {
        let element = AXUIElementCreateApplication(getpid())
        func button(_ label: String, frame: CGRect = CGRect(x: 10, y: 10, width: 48, height: 48), enabled: Bool = true, on element: AXUIElement) -> ElementRecord {
            var record = ElementRecord(ref: "e1", element: element, role: "AXButton", label: label, value: nil, frame: frame,
                actions: [kAXPressAction], settable: false, enabled: enabled, protected: false)
            record.labelHash = Data(label.utf8)
            return record
        }
        let observed = button("Equals", on: element)
        XCTAssertTrue(ElementRecord.sameControl(button("Equals", on: element), observed))
        XCTAssertFalse(ElementRecord.sameControl(button("Clear", on: element), observed))
        XCTAssertFalse(ElementRecord.sameControl(button("Equals", frame: CGRect(x: 10, y: 60, width: 48, height: 48), on: element), observed))
        XCTAssertFalse(ElementRecord.sameControl(button("Equals", enabled: false, on: element), observed))
        XCTAssertFalse(ElementRecord.sameControl(button("Equals", on: AXUIElementCreateSystemWide()), observed))
    }
}
