import Foundation
import XCTest
@testable import ComputerUse

/// macOS quits TextEdit once it has no windows but keeps listing it under its old pid, so
/// computer_open refused it as app_unavailable, with or without that pid.
final class QuitAppTests: XCTestCase {
    private func executable(_ pid: pid_t) -> URL {
        var buffer = [CChar](repeating: 0, count: 4096)
        XCTAssertGreaterThan(proc_pidpath(pid, &buffer, 4096), 0)
        return URL(fileURLWithPath: String(cString: buffer))
    }

    func testARunningProcessIsRunning() {
        XCTAssertEqual(AppIdentity.processState(getpid(), executable: executable(getpid())), .running)
        XCTAssertEqual(AppIdentity.processState(getpid(), executable: nil), .unknown, "nothing to compare: kept as running")
    }

    func testAPidWithNoProcessOrAnotherProgramIsGone() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try process.run(); process.waitUntilExit()
        XCTAssertEqual(AppIdentity.processState(process.processIdentifier, executable: URL(fileURLWithPath: "/usr/bin/true")), .gone,
            "the pid Launch Services still lists names no process")
        XCTAssertEqual(AppIdentity.processState(getpid(), executable: URL(fileURLWithPath: "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit")), .gone,
            "a recycled pid runs another program")
    }

    func testTheRefusalSaysHowToStartTheAppAgain() {
        XCTAssertEqual(AppIdentity.quitByMacOS.code, "app_not_running")
        XCTAssertTrue(AppIdentity.quitByMacOS.message.contains("without a pid"))
        XCTAssertEqual(AppIdentity.quitByMacOS.next, "open_session")
    }
}
