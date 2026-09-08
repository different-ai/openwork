import XCTest
@testable import ComputerUse

final class BoundaryTests: XCTestCase {
    func testMalformedInputNeverBecomesAnAction() throws {
        let invalid: [[String: Any]] = [
            ["type": "click", "x": true, "y": 1],
            ["type": "click", "x": Double.nan, "y": 1],
            ["type": "click", "x": -1, "y": 1],
            ["type": "click", "x": 1, "y": 1, "strict": false],
            ["type": "click", "x": 1],
            ["type": "scroll", "x": 1, "y": 1, "delta_x": 1.5, "delta_y": 1],
            ["type": "key", "key": "command+space"],
            ["type": "key", "key": "paste"],
            ["type": "type", "text": "hello\0world"],
            ["type": "type", "text": String(repeating: "x", count: 8001)],
            ["type": "drag", "path": [["x": 1, "y": 1]]],
            ["type": "shell", "text": "ignored"],
        ]
        for candidate in invalid { XCTAssertThrowsError(try Action(candidate)) }
        XCTAssertNoThrow(try Action(["type": "set_value", "ref": "e1", "text": ""]))
        XCTAssertNoThrow(try Action(["type": "type", "text": "Hello 👋🏽 café 日本語"]))
        XCTAssertThrowsError(try Arguments(values: ["pid": true]).integer("pid", min: 1, max: 999))
        XCTAssertThrowsError(try Arguments(values: ["include_image": "false"]).bool("include_image", default: true))
    }

    func testObservationCannotCrossWindowGenerationTimeOrImageBoundary() throws {
        let frame = CGRect(x: -1440, y: 200, width: 1200, height: 800)
        let observation = ObservationLease(id: "observed", createdAt: 100, generation: 7, frame: frame, imageWidth: 600, imageHeight: 400)
        XCTAssertNoThrow(try observation.validate(id: "observed", generation: 7, frame: frame, now: 101))
        XCTAssertThrowsError(try observation.validate(id: "other-session", generation: 7, frame: frame, now: 101))
        XCTAssertThrowsError(try observation.validate(id: "observed", generation: 8, frame: frame, now: 101))
        XCTAssertThrowsError(try observation.validate(id: "observed", generation: 7, frame: frame, now: 116))
        XCTAssertThrowsError(try observation.validate(id: "observed", generation: 7, frame: frame.offsetBy(dx: 1, dy: 0), now: 101))
        XCTAssertEqual(try observation.screenPoint(CGPoint(x: 300, y: 200)), CGPoint(x: -840, y: 600))
        XCTAssertThrowsError(try observation.screenPoint(CGPoint(x: 600, y: 0)))
        XCTAssertThrowsError(try observation.screenPoint(CGPoint(x: 0, y: 400)))
        XCTAssertThrowsError(try observation.screenPoint(CGPoint(x: Double.infinity, y: 0)))
    }

    @MainActor
    func testNoSessionMeansNoContentOrInput() async throws {
        let runtime = SessionRuntime()
        let calls: [(String, [String: Any])] = [
            ("computer_observe", ["session_id": "invented"]),
            ("computer_act", ["session_id": "invented", "observation_id": "invented", "request_id": "one", "action": ["type": "click", "x": 10, "y": 20]]),
            ("computer_session_status", ["session_id": "invented"]),
            ("computer_close_session", ["session_id": "invented"]),
        ]
        for (name, args) in calls {
            do { _ = try await runtime.call(name, args); XCTFail("Unapproved access succeeded") }
            catch let error as UseError { XCTAssertEqual(error.code, "session_unavailable") }
        }
    }

    @MainActor
    func testLegacyEscapeHatchesAreNotTools() async throws {
        let runtime = SessionRuntime()
        for name in ["snapshot", "set_strict_mode", "cua_screenshot", "cua_click", "clipboard_read", "clipboard_write", "open_url", "launch_app"] {
            do { _ = try await runtime.call(name, [:]); XCTFail("Legacy tool succeeded") }
            catch let error as UseError { XCTAssertEqual(error.code, "unknown_tool") }
        }
        let names = Set(MCPServer.schemas().compactMap { $0["name"] as? String })
        XCTAssertEqual(names, ["computer_discover", "computer_open_session", "computer_observe", "computer_act", "computer_session_status", "computer_close_session"])
    }
}
