import XCTest
import Darwin
@testable import ComputerUse

final class BoundaryTests: XCTestCase {
    func testMalformedInputNeverBecomesAnAction() throws {
        let invalid: [[String: Any]] = [
            ["type": "click", "x": true, "y": 1],
            ["type": "click", "x": Double.nan, "y": 1],
            ["type": "click", "x": -1, "y": 1],
            ["type": "click", "x": 1, "y": 1, "strict": false],
            ["type": "click", "x": 1],
            ["type": "move", "x": -1, "y": 1],
            ["type": "move", "x": Double.nan, "y": 1],
            ["type": "move", "x": 1, "y": 1, "strict": false],
            ["type": "scroll", "x": 1, "y": 1, "delta_x": 1.5, "delta_y": 1],
            ["type": "key", "key": "command+space"],
            ["type": "key", "key": "paste"],
            ["type": "type", "text": "hello\0world"],
            ["type": "type", "text": String(repeating: "x", count: 8001)],
            ["type": "drag", "path": [["x": 1, "y": 1]]],
            ["type": "shell", "text": "ignored"],
        ]
        for candidate in invalid { XCTAssertThrowsError(try Action(candidate)) }
        let hover = try Action(["type": "move", "x": 10, "y": 20])
        XCTAssertEqual(hover.name, "move")
        XCTAssertTrue(hover.requiresPointer)
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
        let feedback = InputFeedback(action: "drag", phase: .move,
            screenPoint: try observation.screenPoint(CGPoint(x: 300, y: 200)), frame: frame)
        XCTAssertEqual(feedback.point, CGPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(Set(feedback.payload.keys), ["action", "phase", "at", "x", "y"])
        let typing = InputFeedback(action: "type", phase: .uncertain, frame: frame)
        XCTAssertEqual(Set(typing.payload.keys), ["action", "phase", "at"])
        XCTAssertNil(InputFeedback(action: "press", phase: .dispatched, screenPoint: .zero, frame: frame).point)
    }

    @MainActor
    func testEmbeddedWatchIsNotAControlOrRecoveryLease() {
        let previous = (SessionControls.hosted, SessionControls.coworkerPresentation, SessionControls.embeddedCoworker)
        defer {
            SessionControls.hosted = previous.0; SessionControls.coworkerPresentation = previous.1
            SessionControls.embeddedCoworker = previous.2
        }
        SessionControls.hosted = true; SessionControls.coworkerPresentation = false
        SessionControls.embeddedCoworker = true
        XCTAssertFalse(SessionControls.automaticRecovery)
        SessionControls.embeddedCoworker = false
        XCTAssertTrue(SessionControls.automaticRecovery)
        SessionControls.hosted = false; SessionControls.coworkerPresentation = true
        XCTAssertFalse(SessionControls.automaticRecovery)

        var watch = WatchLease()
        XCTAssertFalse(watch.isVisible(now: 100))
        watch.update(visible: true, now: 100)
        XCTAssertTrue(watch.isVisible(now: 101.499))
        XCTAssertFalse(watch.isVisible(now: 101.5))
        XCTAssertFalse(watch.isVisible(now: 99))
        let expiredGeneration = watch.generation
        watch.update(visible: true, now: 102)
        XCTAssertNotEqual(watch.generation, expiredGeneration)
        let activeGeneration = watch.generation
        watch.update(visible: true, now: 102.25)
        XCTAssertEqual(watch.generation, activeGeneration)
        watch.invalidate()
        XCTAssertNotEqual(watch.generation, activeGeneration)
        watch.update(visible: false, now: 102.3)
        XCTAssertFalse(watch.isVisible(now: 102.3))

        let access = MacAccessibility()
        let state = WindowState(records: [], visited: 1, truncated: false, protectedFrames: [.zero])
        let movedMask = WindowState(records: [], visited: 1, truncated: false,
            protectedFrames: [CGRect(x: 1, y: 1, width: 20, height: 20)])
        XCTAssertNotEqual(access.digest(state), access.digest(movedMask))
        XCTAssertNotEqual(access.digest(state), access.digest(WindowState(records: [], visited: 1, truncated: true, protectedFrames: [.zero])))
    }

    @MainActor
    func testEmbeddedOutputBackpressureDropsExtraFramesAndPreservesOrder() async throws {
        var descriptors: [Int32] = [0, 0]
        XCTAssertEqual(pipe(&descriptors), 0)
        defer { Darwin.close(descriptors[0]); Darwin.close(descriptors[1]) }
        XCTAssertEqual(fcntl(descriptors[0], F_SETFL, O_NONBLOCK), 0)
        let output = MCPOutput(fileDescriptor: descriptors[1])
        output.enableNonblocking()
        let frame = ["kind": "frame", "data": String(repeating: "x", count: 262_144)]
        output.send(frame, frame: true)
        XCTAssertFalse(output.canSendFrame)
        output.send(["kind": "dropped"], frame: true)
        output.send(["kind": "input"])
        output.send(["kind": "closed"])
        var received = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        for _ in 0..<1000 {
            let count = Darwin.read(descriptors[0], &buffer, buffer.count)
            if count > 0 { received.append(contentsOf: buffer.prefix(count)) }
            if output.canSendFrame && count <= 0 { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(output.canSendFrame)
        let messages = try received.split(separator: 10).map { line in
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line)) as? [String: String])
        }
        XCTAssertEqual(messages.map { $0["kind"] }, ["frame", "input", "closed"])
        XCTAssertEqual(messages.first?["data"], frame["data"])
    }

    @MainActor
    func testNoSessionMeansNoContentOrInput() async throws {
        let runtime = SessionRuntime()
        let calls: [(String, [String: Any])] = [
            ("computer_observe", ["session_id": "invented"]),
            ("computer_act", ["session_id": "invented", "observation_id": "invented", "request_id": "one", "action": ["type": "click", "x": 10, "y": 20]]),
            ("computer_act", ["session_id": "invented", "observation_id": "invented", "request_id": "hover", "action": ["type": "move", "x": 10, "y": 20]]),
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
