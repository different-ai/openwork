import XCTest
@testable import ComputerUse

final class ObservationPreparationTests: XCTestCase {
    @MainActor
    func testControlFocusesBeforeReadingButOtherModesDoNot() async throws {
        for mode in [AccessMode.control, .observe, .assist] {
            var events: [String] = []
            let value = try await ObservationPreparation.capture(mode: mode, check: {
                events.append("check")
            }, focus: {
                events.append("focus")
            }, read: {
                events.append("capture")
                return "observed active window"
            })
            XCTAssertEqual(value, "observed active window")
            XCTAssertEqual(events, mode == .control
                ? ["check", "focus", "check", "capture", "check"]
                : ["check", "capture", "check"])
        }
    }

    @MainActor
    func testPausedOrChangedSessionCannotFocusOrCapture() async throws {
        for code in ["session_paused", "session_changed", "desktop_unavailable"] {
            var events: [String] = []
            do {
                _ = try await ObservationPreparation.capture(mode: .control, check: {
                    throw UseError(code, "Control is no longer available")
                }, focus: {
                    events.append("focus")
                }, read: {
                    events.append("capture")
                    return true
                })
                XCTFail("An unavailable session was observed")
            } catch let error as UseError {
                XCTAssertEqual(error.code, code)
            }
            XCTAssertTrue(events.isEmpty)
        }
    }

    @MainActor
    func testInterruptionDuringFocusPreventsCaptureAndDoesNotRefocus() async throws {
        for code in ["session_paused", "session_changed", "desktop_unavailable"] {
            var changed = false
            var focusCount = 0
            var captured = false
            do {
                _ = try await ObservationPreparation.capture(mode: .control, check: {
                    if changed { throw UseError(code, "Control changed during focus") }
                }, focus: {
                    focusCount += 1
                    changed = true
                }, read: {
                    captured = true
                    return true
                })
                XCTFail("Capture crossed an interruption")
            } catch let error as UseError {
                XCTAssertEqual(error.code, code)
            }
            XCTAssertEqual(focusCount, 1)
            XCTAssertFalse(captured)
        }
    }

    @MainActor
    func testFailedFocusCannotFallBackToBackgroundCapture() async throws {
        var captured = false
        do {
            _ = try await ObservationPreparation.capture(mode: .control, check: {}, focus: {
                throw UseError("window_not_frontmost", "The target could not be focused")
            }, read: {
                captured = true
                return true
            })
            XCTFail("Failed focus allowed a background observation")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "window_not_frontmost")
        }
        XCTAssertFalse(captured)
    }

    @MainActor
    func testInterruptionDuringCaptureCannotReturnAnObservation() async throws {
        var stopped = false
        do {
            _ = try await ObservationPreparation.capture(mode: .control, check: {
                if stopped { throw UseError("session_paused", "The person took over") }
            }, focus: {}, read: {
                stopped = true
                return "must not be returned"
            })
            XCTFail("A paused session returned an observation")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
        }
    }

    @MainActor
    func testCancellationDuringFocusPreventsCapture() async throws {
        var captured = false
        let task = Task { @MainActor in
            try await ObservationPreparation.capture(mode: .control, check: {
                try Task.checkCancellation()
            }, focus: {
                withUnsafeCurrentTask { $0?.cancel() }
            }, read: {
                captured = true
                return true
            })
        }
        do {
            _ = try await task.value
            XCTFail("Cancelled focus allowed capture")
        } catch is CancellationError { }
        XCTAssertFalse(captured)
    }
}
