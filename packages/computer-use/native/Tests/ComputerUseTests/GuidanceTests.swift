import XCTest
@testable import ComputerUse

final class GuidanceTests: XCTestCase {
    func testAgentReadsThatComputerUseIsForFinishingTheTaskBeforeItsBoundaries() {
        for policy in [RuntimePolicy.desktop, .embedded] {
            let instructions = policy.instructions
            XCTAssertTrue(instructions.hasPrefix("Computer use is for doing the person's task"))
            XCTAssertTrue(instructions.contains("Open control mode unless the person asks"))
            // The existing session rules still follow, unchanged.
            XCTAssertTrue(instructions.hasSuffix(policy.guidance))
        }
    }

    func testControlIsDescribedAsTheDefaultAndNarrowerModesAsOptIn() {
        XCTAssertTrue(AccessMode.control.explanation.hasPrefix("Default."))
        XCTAssertTrue(AccessMode.observe.explanation.contains("when the person asks"))
    }
}
