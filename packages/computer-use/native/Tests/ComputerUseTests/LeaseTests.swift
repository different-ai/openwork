import XCTest
@testable import ComputerUse

final class LeaseTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("computer-use-leases-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testOneAgentPerWindowWhileOtherWindowsStayFree() throws {
        let first = try ControlLease(pid: 42, window: 7, directory: directory)
        XCTAssertThrowsError(try ControlLease(pid: 42, window: 7, directory: directory)) { error in
            XCTAssertEqual((error as? UseError)?.code, "window_busy")
        }
        let otherWindow = try ControlLease(pid: 42, window: 8, directory: directory)
        let otherApp = try ControlLease(pid: 43, window: 7, directory: directory)
        withExtendedLifetime((first, otherWindow, otherApp)) {}
    }

    func testReleasedWindowIsFreeAgainAndLeavesNoFile() throws {
        var first: ControlLease? = try ControlLease(pid: 42, window: 7, directory: directory)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("window-42-7.lock").path))
        first = nil
        XCTAssertNil(first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("window-42-7.lock").path))
        XCTAssertNoThrow(try ControlLease(pid: 42, window: 7, directory: directory))
    }

    @MainActor
    func testFocusWaitsForTheHolderThenProceeds() async throws {
        let holder = try await FocusLease.acquire(directory: directory, check: {})
        Task { @MainActor in
            try await Task.sleep(nanoseconds: 60_000_000)
            holder.release()
        }
        let started = ProcessInfo.processInfo.systemUptime
        let next = try await FocusLease.acquire(directory: directory, timeout: 2, check: {})
        XCTAssertGreaterThanOrEqual(ProcessInfo.processInfo.systemUptime - started, 0.05)
        next.release()
    }

    @MainActor
    func testFocusHeldTooLongGivesUpBeforeAnyInput() async throws {
        let holder = try await FocusLease.acquire(directory: directory, check: {})
        defer { holder.release() }
        do {
            _ = try await FocusLease.acquire(directory: directory, timeout: 0.05, check: {})
            XCTFail("A held focus lease was acquired twice.")
        } catch {
            XCTAssertEqual((error as? UseError)?.code, "focus_busy")
        }
    }

    @MainActor
    func testAgentsInOneAppTakeTurnsForItsKeyWindow() async throws {
        let holder = try await FocusLease.acquire(app: 42, directory: directory, check: {})
        do {
            _ = try await FocusLease.acquire(app: 42, directory: directory, timeout: 0.05, check: {})
            XCTFail("Two agents held one app's key window at once.")
        } catch {
            XCTAssertEqual((error as? UseError)?.code, "focus_busy")
        }
        // Other apps and the shared keyboard focus stay free.
        let otherApp = try await FocusLease.acquire(app: 43, directory: directory, timeout: 0.05, check: {})
        let focus = try await FocusLease.acquire(directory: directory, timeout: 0.05, check: {})
        otherApp.release(); focus.release()
        holder.release()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("app-42.lock").path))
        let next = try await FocusLease.acquire(app: 42, directory: directory, timeout: 0.05, check: {})
        next.release()
    }

    @MainActor
    func testHandBackSkipsWhileAnotherAgentHoldsFocus() async throws {
        let holder = try await FocusLease.acquire(directory: directory, check: {})
        XCTAssertNil(FocusLease.attempt(directory: directory))
        holder.release()
        let free = FocusLease.attempt(directory: directory)
        XCTAssertNotNil(free)
        free?.release()
    }

    @MainActor
    func testFocusWaitStopsWhenTheSessionChanges() async throws {
        let holder = try await FocusLease.acquire(directory: directory, check: {})
        defer { holder.release() }
        var checks = 0
        do {
            _ = try await FocusLease.acquire(directory: directory, timeout: 2, check: {
                checks += 1
                if checks > 2 { throw UseError("session_changed", "Control changed.") }
            })
            XCTFail("Focus was acquired after the session changed.")
        } catch {
            XCTAssertEqual((error as? UseError)?.code, "session_changed")
        }
    }
}
