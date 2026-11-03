import XCTest
@testable import ComputerUse

final class InputMotionTests: XCTestCase {
    func testPathEndsOnEveryPointWithShortSteps() {
        let points = [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 0), CGPoint(x: 100, y: 35)]
        let path = PointerMotion.path(points, maxStep: 10)
        XCTAssertEqual(path.last, points[2])
        XCTAssertTrue(path.contains(points[1]))
        XCTAssertFalse(path.contains(points[0]))
        var previous = points[0]
        for point in path {
            XCTAssertLessThanOrEqual(hypot(point.x - previous.x, point.y - previous.y), 10.0001)
            previous = point
        }
    }

    func testLongPathsStayWithinTheEventBudget() {
        let points = (0..<32).map { CGPoint(x: CGFloat($0 % 2) * 3_000, y: CGFloat($0) * 40) }
        let path = PointerMotion.path(points, maxStep: 10, maxEvents: 120)
        XCTAssertLessThanOrEqual(path.count, 120)
        for point in points.dropFirst() { XCTAssertTrue(path.contains(point)) }
        XCTAssertEqual(PointerMotion.path([CGPoint(x: 5, y: 5), CGPoint(x: 5, y: 5)]), [CGPoint(x: 5, y: 5)])
        XCTAssertEqual(PointerMotion.path([CGPoint(x: 5, y: 5)]), [])
    }

    func testScrollStepsAddUpExactly() {
        for (dx, dy) in [(Int32(0), Int32(-1_200)), (37, 0), (-250, 999), (0, 0), (1, -1)] {
            let steps = PointerMotion.scrollSteps(dx: dx, dy: dy)
            XCTAssertEqual(steps.reduce(0) { $0 + $1.dx }, dx)
            XCTAssertEqual(steps.reduce(0) { $0 + $1.dy }, dy)
            XCTAssertTrue(steps.allSatisfy { abs($0.dx) <= 120 && abs($0.dy) <= 120 })
        }
        XCTAssertEqual(PointerMotion.scrollSteps(dx: 0, dy: -1_200).count, 10)
    }

    @MainActor
    func testDoubleClickHoldsEachPressAndReleasesBeforeTheNext() async throws {
        var events: [String] = []
        try await InputDispatch.press(clicks: 2, check: {}, validate: { events.append("validate") }, move: {
            events.append("move")
        }, down: { events.append("down\($0)") }, up: { events.append("up\($0)") }, pace: { nanoseconds in
            events.append(nanoseconds == PointerMotion.pressHold ? "hold" : nanoseconds == PointerMotion.clickGap ? "gap" : "settle")
        })
        XCTAssertEqual(events, ["validate", "move", "settle", "validate", "down1", "hold", "up1",
                                "gap", "validate", "down2", "hold", "up2"])
    }

    @MainActor
    func testControlEndingDuringAHoldStillReleasesTheButton() async throws {
        var events: [String] = []
        do {
            try await InputDispatch.press(clicks: 1, check: {}, validate: {}, move: {}, down: { events.append("down\($0)") },
                up: { events.append("up\($0)") }, pace: { nanoseconds in
                    if nanoseconds == PointerMotion.pressHold { throw UseError("session_paused", "The person took over") }
                })
            XCTFail("The hold should have been interrupted")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
        }
        XCTAssertEqual(events, ["down1", "up1"])
    }

    @MainActor
    func testDragHoldsTravelsAndRestsBeforeReleasing() async throws {
        var events: [String] = []
        let start = CGPoint(x: 0, y: 0)
        let steps = [CGPoint(x: 5, y: 0), CGPoint(x: 10, y: 0)]
        try await InputDispatch.drag(from: start, through: steps, check: {}, validate: { _ in }, move: { events.append("move \($0.x)") },
            down: { events.append("down \($0.x)") }, drag: { events.append("drag \($0.x)") }, up: { events.append("up \($0.x)") },
            pace: { nanoseconds in
                switch nanoseconds {
                case PointerMotion.dragHold: events.append("hold")
                case PointerMotion.dropDwell: events.append("dwell")
                case PointerMotion.step: events.append("step")
                default: events.append("settle")
                }
            })
        XCTAssertEqual(events, ["move 0.0", "settle", "down 0.0", "hold", "drag 5.0", "step", "drag 10.0", "step", "dwell", "up 10.0"])
    }

    @MainActor
    func testDragFailureReleasesWhereThePointerGot() async throws {
        var events: [String] = []
        do {
            try await InputDispatch.drag(from: .zero, through: [CGPoint(x: 5, y: 0), CGPoint(x: 10, y: 0)], check: {}, validate: { point in
                if point.x == 10 { throw UseError("stale_observation", "The window moved") }
            }, move: { _ in }, down: { _ in events.append("down") }, drag: { events.append("drag \($0.x)") },
                up: { events.append("up \($0.x)") }, pace: { _ in })
            XCTFail("The drag should have stopped")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "stale_observation")
        }
        XCTAssertEqual(events, ["down", "drag 5.0", "up 5.0"])
    }

    @MainActor
    func testSettleEndsOnceTheAppIsQuiet() async throws {
        var clock: TimeInterval = 10
        var activity: TimeInterval = 10.05
        let settled = try await InputSettle.wait(since: 10, lastActivity: { activity }, now: { clock }, check: {}, sleep: { seconds in
            clock += seconds
            if clock < 10.2 { activity = clock }
        })
        XCTAssertTrue(settled)
        XCTAssertGreaterThanOrEqual(clock - activity, InputSettle.quiet)
        XCTAssertLessThan(clock, 10.5)
    }

    @MainActor
    func testSettleGivesUpAtTheLimitWhileTheAppKeepsChanging() async throws {
        var clock: TimeInterval = 0
        let settled = try await InputSettle.wait(since: 0, lastActivity: { clock }, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertFalse(settled)
        XCTAssertGreaterThanOrEqual(clock, InputSettle.limit)
        XCTAssertLessThan(clock, InputSettle.limit + 0.05)
    }

    @MainActor
    func testSettleStopsWhenControlEnds() async throws {
        var clock: TimeInterval = 0
        do {
            _ = try await InputSettle.wait(since: 0, lastActivity: { 0 }, now: { clock }, check: {
                if clock > 0.05 { throw UseError("session_paused", "The person took over") }
            }, sleep: { clock += $0 })
            XCTFail("Settling should stop at takeover")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
        }
    }

    func testOnlyIdenticalElementsAndPixelsCountAsNoVisibleChange() {
        let baseline = ActionBaseline(generation: 1, stateDigest: Data([1]), imageDigest: Data([2]))
        XCTAssertEqual(baseline.changes(stateDigest: Data([1]), imageDigest: Data([2]))["no_visible_change"] as? Bool, true)
        XCTAssertNil(baseline.changes(stateDigest: Data([1]), imageDigest: Data([3]))["no_visible_change"])
        XCTAssertNil(baseline.changes(stateDigest: Data([9]), imageDigest: Data([2]))["no_visible_change"])
        let unknown = baseline.changes(stateDigest: Data([1]), imageDigest: nil)
        XCTAssertNil(unknown["no_visible_change"])
        XCTAssertTrue(unknown["image_changed"] is NSNull)
    }
}

final class InputRoutingTests: XCTestCase {
    func testChromiumElectronAndCatalystUseTheSkyLightRoute() {
        XCTAssertEqual(PointerRoute.classify(bundleID: "com.google.Chrome.canary", info: [:]), .skyLight)
        XCTAssertEqual(PointerRoute.classify(bundleID: "com.example.Notes", info: ["NSPrincipalClass": "AtomApplication"]), .skyLight)
        XCTAssertEqual(PointerRoute.classify(bundleID: "com.example.Chat", info: ["ElectronAsarIntegrity": [:]]), .skyLight)
        XCTAssertEqual(PointerRoute.classify(bundleID: "com.example.Pad", info: ["UIDeviceFamily": [2, 6]]), .skyLight)
        XCTAssertEqual(PointerRoute.classify(bundleID: "com.apple.finder", info: ["NSPrincipalClass": "NSApplication"]), .appKit)
        XCTAssertEqual(PointerRoute.classify(bundleID: "org.blenderfoundation.blender", info: [:]), .appKit)
    }

    func testWindowChangesReportOpenedWindowsPanelsAndFocusLoss() {
        let before = WindowChanges(windows: [10], panels: [], frontmost: true)
        XCTAssertNil(before.diff(before, target: 10))
        let after = WindowChanges(windows: [10, 12, 11], panels: [40], frontmost: false)
        let changes = before.diff(after, target: 10)
        let opened = changes?["opened"] as? [[String: Any]]
        XCTAssertEqual(opened?.map { $0["window_id"] as? Int }, [11, 12])
        XCTAssertEqual(opened?.allSatisfy { $0.keys.sorted() == ["window_id"] }, true)
        XCTAssertEqual(changes?["panel_opened"] as? Bool, true)
        XCTAssertEqual(changes?["another_app_in_front"] as? Bool, true)
        XCTAssertNil(changes?["target_closed"])
        XCTAssertEqual(before.diff(WindowChanges(windows: [], panels: [], frontmost: true), target: 10)?["target_closed"] as? Bool, true)
    }
}
