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
            ["type": "key", "key": "s", "modifiers": ["cmd"]],
            ["type": "key", "key": "s", "modifiers": "command"],
            ["type": "key", "key": "select_all", "modifiers": ["shift"]],
            ["type": "click", "x": 1, "y": 1, "modifiers": ["fn"]],
            ["type": "wait", "ms": 10], ["type": "wait", "ms": 3001], ["type": "wait"],
            ["type": "type", "text": "hello\0world"],
            ["type": "type", "text": String(repeating: "x", count: 8001)],
            ["type": "drag", "path": [["x": 1, "y": 1]]],
            ["type": "shell", "text": "ignored"],
        ]
        for candidate in invalid {
            for policy in [RuntimePolicy.desktop, .coworker] { XCTAssertThrowsError(try Action(candidate, policy: policy)) }
        }
        let hover = try Action(["type": "move", "x": 10, "y": 20])
        XCTAssertEqual(hover.name, "move")
        XCTAssertTrue(hover.requiresControl); XCTAssertTrue(hover.usesCoordinates)
        XCTAssertTrue(hover.changesWindow)
        XCTAssertNoThrow(try Action(["type": "set_value", "ref": "e1", "text": ""]))
        XCTAssertNoThrow(try Action(["type": "type", "text": "Hello 👋🏽 café 日本語"]))
        XCTAssertEqual(try Action(["type": "triple_click", "x": 1, "y": 1], policy: .coworker).name, "triple_click")
        XCTAssertEqual(try Action(["type": "click", "x": 1, "y": 1, "modifiers": ["shift", "command"]], policy: .coworker).name, "click")
        let wait = try Action(["type": "wait", "ms": 500], policy: .coworker)
        XCTAssertFalse(wait.requiresControl); XCTAssertFalse(wait.changesWindow)
        for action in [try Action(["type": "key", "key": "tab"]), try Action(["type": "type", "text": "hello"])] {
            XCTAssertTrue(action.requiresControl); XCTAssertFalse(action.usesCoordinates)
        }
        XCTAssertThrowsError(try Arguments(values: ["pid": true]).integer("pid", min: 1, max: 999))
        XCTAssertThrowsError(try Arguments(values: ["include_image": "false"]).bool("include_image", default: true))
    }

    func testShortcutsAreFiniteAndExcludeClipboardAndSystemChords() throws {
        for allowed in [("s", ["command"]), ("f", ["command"]), ("z", ["command", "shift"]), ("enter", ["command"]),
                        ("left", ["option", "shift"]), ("a", ["command"]), ("tab", []), ("tab", ["shift"])] {
            XCTAssertNoThrow(try Action(["type": "key", "key": allowed.0, "modifiers": allowed.1], policy: .coworker), allowed.0)
        }
        for blocked in [("c", ["command"]), ("x", ["command"]), ("v", ["command", "shift", "option"]), ("y", ["control"]), ("k", ["control"]),
                        ("q", ["command", "shift"]), ("w", ["command", "option"]), ("h", ["command"]), ("m", ["command"]),
                        ("tab", ["command"]), ("space", ["command"]), ("`", ["command"]), ("3", ["command", "shift"]),
                        ("4", ["command", "shift", "control"]), ("5", ["command", "shift"]), ("6", ["command", "shift"]),
                        ("f", ["command", "control"]), ("d", ["command", "option"]), ("escape", ["command", "option"])] {
            do { _ = try Action(["type": "key", "key": blocked.0, "modifiers": blocked.1], policy: .coworker); XCTFail("\(blocked) was allowed") }
            catch let error as UseError { XCTAssertEqual(error.code, "blocked_shortcut", blocked.0) }
        }
        for key in ["f1", "f11", "n", "v", "q"] { XCTAssertThrowsError(try Action(["type": "key", "key": key], policy: .coworker)) }
        XCTAssertFalse(NativeKey.isBlocked("3", .maskCommand))
        XCTAssertTrue(NativeKey.isBlocked("3", [.maskCommand, .maskShift]))
        if case .key(let key, let flags) = try Action(["type": "key", "key": "redo"]) {
            XCTAssertEqual(key, "z"); XCTAssertEqual(flags, [.maskCommand, .maskShift])
        } else { XCTFail("redo should resolve to a chord") }
    }

    func testBatchIsOrderedBoundedExclusiveAndReportsInterruptedPrefix() throws {
        XCTAssertEqual(try Action.batch(["action": ["type": "type", "text": "hi"]]).count, 1)
        let raw: [String: Any] = ["actions": [["type": "click", "x": 1, "y": 2], ["type": "type", "text": "hi"], ["type": "key", "key": "enter"]]]
        let batch = try Action.batch(raw, policy: .coworker)
        XCTAssertEqual(batch.map(\.name), ["click", "type", "key"])
        XCTAssertThrowsError(try Action.batch(raw))
        let invalid: [[String: Any]] = [[:], ["action": ["type": "type", "text": "hi"], "actions": [["type": "key", "key": "enter"]]],
            ["actions": []], ["actions": Array(repeating: ["type": "key", "key": "tab"], count: Action.batchLimit + 1)],
            ["actions": [["type": "key", "key": "tab"], ["type": "shell", "text": "x"]]]]
        for candidate in invalid { XCTAssertThrowsError(try Action.batch(candidate, policy: .coworker)) }
        var progress = BatchProgress(actions: batch.map(\.name))
        let failure = UseError("session_paused", "Paused", next: "human_takeover")
        let rejected = progress.receipt(requestID: "one", failure: failure, detailed: true)
        XCTAssertEqual(rejected["may_have_acted"] as? Bool, false)
        progress.dispatched(path: "targeted_input")
        let partial = progress.receipt(requestID: "one", failure: failure, uncertain: true, detailed: true)
        XCTAssertEqual(partial["ok"] as? Bool, false)
        XCTAssertEqual(partial["status"] as? String, "partial")
        XCTAssertEqual(partial["next"] as? String, "human_takeover")
        XCTAssertEqual(partial["completed"] as? Int, 1)
        XCTAssertEqual(partial["failed_step"] as? Int, 1)
        XCTAssertEqual(partial["may_have_acted"] as? Bool, true)
        XCTAssertEqual((partial["steps"] as? [[String: Any]])?.compactMap { $0["status"] as? String }, ["dispatched", "uncertain", "skipped"])
        XCTAssertEqual(progress.steps.count, 1)
        var completed = BatchProgress(actions: ["type"])
        completed.dispatched(path: "targeted_input")
        let interruptedAfter = completed.receipt(requestID: "last", failure: failure, detailed: true)
        XCTAssertEqual(interruptedAfter["failed_phase"] as? String, "after_dispatch")
        XCTAssertEqual(interruptedAfter["ok"] as? Bool, false)
        XCTAssertEqual(Set(completed.receipt(requestID: "legacy", detailed: false).keys), ["ok", "status", "next", "action", "path", "request_id", "outcome_verified"])
    }

    @MainActor
    func testTypingChecksRevocationAndFocusBeforeEveryChunkAndAlwaysReleasesKeys() async throws {
        let text = String(repeating: "café 日本語 e\u{301} ", count: 10)
        XCTAssertEqual(try InputDispatch.chunks(text).joined(), text)
        XCTAssertTrue(try InputDispatch.chunks(text).allSatisfy { $0.utf16.count <= 16 })
        for changedFocus in [false, true] {
            var changed = false
            var posted: [String] = []
            var validations = 0
            do {
                try await InputDispatch.type(text, check: {
                    if changed && !changedFocus { throw UseError("session_paused", "Paused") }
                }, validate: {
                    validations += 1
                    if changed { throw UseError("focus_changed", "Focus changed") }
                }, send: { posted.append($0) }, pace: { changed = true })
                XCTFail("Interrupted typing finished")
            } catch let error as UseError {
                XCTAssertEqual(error.code, changedFocus ? "focus_changed" : "session_paused")
            }
            XCTAssertEqual(posted.count, 1)
            XCTAssertEqual(validations, changedFocus ? 2 : 1)
        }
        var cancelledPosts = 0
        let task = Task { @MainActor in
            try await InputDispatch.type(text, check: {}, validate: {}, send: { _ in cancelledPosts += 1 }, pace: {
                withUnsafeCurrentTask { $0?.cancel() }
            })
        }
        do { try await task.value; XCTFail("Cancelled typing finished") } catch is CancellationError { }
        XCTAssertEqual(cancelledPosts, 1)
        var revoked = false
        var events: [String] = []
        let check = { if revoked { throw UseError("session_paused", "Paused") } }
        XCTAssertThrowsError(try InputDispatch.pair(check: check, down: { events.append("down"); revoked = true }, up: { events.append("up") }))
        XCTAssertEqual(events, ["down", "up"])
        XCTAssertThrowsError(try InputDispatch.pair(check: check, down: { events.append("unexpected") }, up: { events.append("unexpected") }))
        XCTAssertEqual(events, ["down", "up"])
    }

    func testObservationCannotCrossWindowGenerationTimeOrImageBoundary() throws {
        let frame = CGRect(x: -1440, y: 200, width: 1200, height: 800)
        let observation = ObservationLease(id: "observed", createdAt: 100, generation: 7, frame: frame, imageWidth: 600, imageHeight: 400)
        XCTAssertNoThrow(try observation.validate(id: "observed", generation: 7, frame: frame, now: 101))
        XCTAssertNoThrow(try observation.validate(id: "observed", generation: 7, frame: frame, now: 100 + ObservationLease.validitySeconds))
        XCTAssertThrowsError(try observation.validate(id: "other-session", generation: 7, frame: frame, now: 101))
        XCTAssertThrowsError(try observation.validate(id: "observed", generation: 8, frame: frame, now: 101))
        XCTAssertThrowsError(try observation.validate(id: "observed", generation: 7, frame: frame, now: 101 + ObservationLease.validitySeconds))
        var longer = observation
        longer.validFor = RuntimePolicy.coworker.observationSeconds
        XCTAssertNoThrow(try longer.validate(id: "observed", generation: 7, frame: frame, now: 160))
        XCTAssertThrowsError(try longer.validate(id: "observed", generation: 7, frame: frame, now: 161))
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
    func testEmbeddedWatchIsNotAControlOrRecoveryLease() throws {
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
        let mask = CGRect(x: 0, y: 0, width: 20, height: 20)
        let state = WindowState(records: [], visited: 1, truncated: false, protectedFrames: [mask])
        let movedMask = WindowState(records: [], visited: 1, truncated: false,
            protectedFrames: [mask.offsetBy(dx: 1, dy: 1)])
        XCTAssertNotEqual(try access.captureDigest(state), try access.captureDigest(movedMask))
        XCTAssertNotEqual(try access.captureDigest(state), try access.captureDigest(WindowState(records: [], visited: 1, truncated: true, protectedFrames: [mask])))
    }

    @MainActor
    func testCaptureRequiresCompletePrivacyAndStrictContentWithBoundedReads() throws {
        let access = MacAccessibility()
        let element = AXUIElementCreateSystemWide()
        func record(_ value: String, frame: CGRect = CGRect(x: 0, y: 0, width: 10, height: 10)) -> ElementRecord {
            ElementRecord(ref: "e1", element: element, role: "AXStaticText", label: "", value: value, frame: frame, actions: [], settable: false, enabled: true, protected: false)
        }
        func state(_ records: [ElementRecord]) -> WindowState { WindowState(records: records, visited: 1, truncated: false, protectedFrames: []) }
        let first = state([record("10:41")])
        XCTAssertNoThrow(try first.requireCapture())
        XCTAssertNotEqual(try access.captureDigest(first), try access.captureDigest(state([record("10:42")])))
        var changedTail = record(String(repeating: "a", count: 500))
        changedTail.valueHash = Data([1])
        let before = try access.captureDigest(state([changedTail]))
        changedTail.valueHash = Data([2])
        XCTAssertNotEqual(before, try access.captureDigest(state([changedTail])))
        for incomplete in [WindowState(records: first.records, visited: 1500, truncated: true, protectedFrames: []),
                           WindowState(records: first.records, visited: 1, truncated: false, protectedFrames: [], privacyIssue: "missing_secure_mask"),
                           WindowState(records: first.records, visited: 1, truncated: false, protectedFrames: [.zero]),
                           state([record("bad", frame: CGRect(x: Double.infinity, y: 0, width: 10, height: 10))])] {
            XCTAssertThrowsError(try incomplete.requireCapture())
        }
        XCTAssertThrowsError(try access.captureDigest(state([record("bad", frame: CGRect(x: 0, y: 0, width: Double.nan, height: 10))])))
        var time: TimeInterval = 100
        let budget = AXReadBudget(seconds: 0.1, clock: { time })
        XCTAssertEqual(try budget.timeout(), 0.05, accuracy: 0.0001)
        time = 100.08
        XCTAssertEqual(try budget.timeout(), 0.02, accuracy: 0.0001)
        time = 100.1
        XCTAssertThrowsError(try budget.timeout())
    }

    @MainActor
    func testCoworkerPolicyDoesNotChangeDesktopSchemaOrObservationShape() throws {
        func schema(_ name: String, _ policy: RuntimePolicy) throws -> [String: Any] {
            let tool = try XCTUnwrap(MCPServer.schemas(policy: policy).first { $0["name"] as? String == name })
            return try XCTUnwrap(tool["inputSchema"] as? [String: Any])
        }
        let desktop = try schema("computer_act", .desktop)
        let properties = try XCTUnwrap(desktop["properties"] as? [String: Any])
        XCTAssertEqual(Set(properties.keys), ["session_id", "observation_id", "request_id", "action"])
        XCTAssertTrue(try XCTUnwrap(desktop["required"] as? [String]).contains("action"))
        let action = try XCTUnwrap(properties["action"] as? [String: Any])
        let variants = try XCTUnwrap(action["oneOf"] as? [[String: Any]])
        XCTAssertEqual(variants.count, 9)
        XCTAssertFalse(variants.contains { ($0["properties"] as? [String: Any])?["modifiers"] != nil })
        let coworker = try schema("computer_act", .coworker)
        XCTAssertNotNil((coworker["properties"] as? [String: Any])?["actions"])
        XCTAssertNil(coworker["oneOf"])
        XCTAssertEqual(RuntimePolicy.desktop.observationSeconds, 15)
        XCTAssertEqual(RuntimePolicy.coworker.observationSeconds, 60)
        XCTAssertEqual(try ObservationOptions([:], policy: .desktop).elements, "all")
        XCTAssertEqual(try ObservationOptions([:], policy: .coworker).elements, "interactive")
        XCTAssertThrowsError(try ObservationOptions(["elements": "none", "include_image": false], policy: .coworker))
        XCTAssertThrowsError(try ObservationOptions(["elements": "all"], policy: .desktop))
        XCTAssertThrowsError(try Action(["type": "triple_click", "x": 1, "y": 1]))
        XCTAssertThrowsError(try Action(["type": "key", "key": "s", "modifiers": ["command"]]))
        let frame = CGRect(x: 0, y: 0, width: 100, height: 100)
        let record = ElementRecord(ref: "e1", element: AXUIElementCreateSystemWide(), role: "AXTextField", label: "Draft", value: "text",
            frame: frame, actions: [], settable: true, enabled: true, protected: false)
        let payload = try record.payload(bounds: frame, width: 100, height: 100, compact: false)
        let legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: payload)) as? [String: Any])
        XCTAssertEqual(legacy["role"] as? String, "AXTextField")
        XCTAssertEqual(legacy["bounds"] as? [String: Double], ["x": 0, "y": 0, "width": 100, "height": 100])
        XCTAssertEqual(legacy["enabled"] as? Bool, true)
        XCTAssertEqual(legacy["actions"] as? [String], [])
        let compact = try record.payload(bounds: frame, width: 100, height: 100, compact: true)
        XCTAssertEqual(compact["role"] as? String, "TextField")
        XCTAssertEqual(compact["w"] as? Int, 100)
        XCTAssertNil(compact["bounds"])
        XCTAssertTrue(record.textField)
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
