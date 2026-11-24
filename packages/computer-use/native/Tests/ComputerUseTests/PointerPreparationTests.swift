import XCTest
@testable import ComputerUse

final class PointerPreparationTests: XCTestCase {
    @MainActor
    func testPointerMovesAndRevalidatesBeforeButtonDown() async throws {
        var events: [String] = []
        try await InputDispatch.pointerDown(check: {
            events.append("check")
        }, validate: {
            events.append("validate")
        }, move: {
            events.append("move")
        }, down: {
            events.append("down")
        }, pace: {
            events.append("pace")
        })
        XCTAssertEqual(events, ["check", "validate", "move", "pace", "check", "validate", "check", "down"])
    }

    @MainActor
    func testChangedTargetAfterMovePreventsButtonDown() async throws {
        for code in ["stale_element", "stale_observation", "window_not_frontmost"] {
            var moved = false
            var down = false
            do {
                try await InputDispatch.pointerDown(check: {}, validate: {
                    if moved { throw UseError(code, "The pointer target changed") }
                }, move: {
                    moved = true
                }, down: {
                    down = true
                }, pace: {})
                XCTFail("Button-down crossed a changed target")
            } catch let error as UseError {
                XCTAssertEqual(error.code, code)
            }
            XCTAssertTrue(moved)
            XCTAssertFalse(down)
        }
    }

    @MainActor
    func testTakeoverDuringPacingPreventsButtonDown() async throws {
        var paused = false
        var events: [String] = []
        do {
            try await InputDispatch.pointerDown(check: {
                if paused { throw UseError("session_paused", "The person took over") }
            }, validate: {}, move: {
                events.append("move")
            }, down: {
                events.append("down")
            }, pace: {
                paused = true
            })
            XCTFail("Button-down crossed takeover")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
        }
        XCTAssertEqual(events, ["move"])
    }

    @MainActor
    func testInvalidInitialTargetPreventsAllPointerInput() async throws {
        var events: [String] = []
        do {
            try await InputDispatch.pointerDown(check: {}, validate: {
                throw UseError("stale_element", "The target changed before input")
            }, move: {
                events.append("move")
            }, down: {
                events.append("down")
            }, pace: {})
            XCTFail("An invalid target received input")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "stale_element")
        }
        XCTAssertTrue(events.isEmpty)
    }

    @MainActor
    func testCancellationAfterMovePreventsButtonDown() async throws {
        var events: [String] = []
        let task = Task { @MainActor in
            try await InputDispatch.pointerDown(check: {}, validate: {}, move: {
                events.append("move")
            }, down: {
                events.append("down")
            }, pace: {
                withUnsafeCurrentTask { $0?.cancel() }
            })
        }
        do {
            try await task.value
            XCTFail("Cancelled movement reached button-down")
        } catch is CancellationError { }
        XCTAssertEqual(events, ["move"])
    }
}
