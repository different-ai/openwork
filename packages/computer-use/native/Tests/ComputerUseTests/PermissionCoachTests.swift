import AppKit
import XCTest
@testable import ComputerUse

final class PermissionCoachTests: XCTestCase {
    @MainActor
    func testGuideCannotTakeKeyboardFocusFromThePasswordPrompt() {
        _ = NSApplication.shared
        let panel = PermissionCoachPanel(contentRect: .zero,
                                        styleMask: [.borderless, .nonactivatingPanel],
                                        backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        defer { panel.close() }

        XCTAssertFalse(panel.canBecomeKey)
        XCTAssertFalse(panel.canBecomeMain)
    }

    @MainActor
    func testGuideActionsWorkWithoutRequestingKeyboardFocus() {
        _ = NSApplication.shared
        let target = ActionTarget()
        let button = PermissionCoachButton(title: "Open settings", target: target, action: #selector(ActionTarget.invoke))
        for role in [PermissionCoachButton.Role.primary, .quiet, .close] {
            button.role = role
            XCTAssertFalse(button.needsPanelToBecomeKey)
            XCTAssertFalse(button.acceptsFirstResponder)
            button.performClick(nil)
        }
        XCTAssertEqual(target.invocations, 3)
    }

    @MainActor
    private final class ActionTarget: NSObject {
        var invocations = 0
        @objc func invoke() { invocations += 1 }
    }
}
