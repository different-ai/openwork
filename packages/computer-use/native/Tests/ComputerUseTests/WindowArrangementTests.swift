import XCTest
import AppKit
@testable import ComputerUse

final class WindowArrangementTests: XCTestCase {
    // A laptop screen under the menu bar, and a second display to its right.
    private let laptop = CGRect(x: 0, y: 25, width: 1440, height: 875)
    private let monitor = CGRect(x: 1440, y: 0, width: 2560, height: 1415)

    func testArrangeIsAnOpenWorkStepThatNeedsControlButNoPointer() throws {
        for layout in WindowLayout.allCases {
            let action = try Action(["type": "arrange", "layout": layout.rawValue], policy: .embedded)
            guard case .arrange(let parsed) = action else { return XCTFail(layout.rawValue) }
            XCTAssertEqual(parsed, layout)
            XCTAssertEqual(action.name, "arrange")
            XCTAssertTrue(action.requiresControl, "moving a window is control, not assist")
            XCTAssertFalse(action.usesCoordinates)
            XCTAssertTrue(action.changesWindow)
            XCTAssertFalse(InputDelivery.stepNeedsFront(action, route: .skyLight, signedKeys: false), "a background session keeps the person's front")
        }
        XCTAssertThrowsError(try Action(["type": "arrange", "layout": "top_half"], policy: .embedded)) { error in
            XCTAssertEqual((error as? UseError)?.code, "invalid_arguments")
        }
        XCTAssertThrowsError(try Action(["type": "arrange", "layout": "full", "x": 10], policy: .embedded), "no free-form frame")
        XCTAssertThrowsError(try Action(["type": "arrange", "layout": "full"], policy: .desktop), "only the OpenWork host offers it")
    }

    func testHalvesAndFullFillTheScreenTheWindowIsOn() throws {
        let screens = [laptop, monitor]
        let onLaptop = CGRect(x: 100, y: 100, width: 600, height: 400)
        XCTAssertEqual(try WindowArrangement.frame(.leftHalf, window: onLaptop, screens: screens, host: nil), CGRect(x: 0, y: 25, width: 720, height: 875))
        XCTAssertEqual(try WindowArrangement.frame(.rightHalf, window: onLaptop, screens: screens, host: nil), CGRect(x: 720, y: 25, width: 720, height: 875))
        XCTAssertEqual(try WindowArrangement.frame(.full, window: onLaptop, screens: screens, host: nil), laptop)
        // Mostly on the monitor: it stays there, never jumping to another screen.
        let straddling = CGRect(x: 1300, y: 200, width: 900, height: 600)
        XCTAssertEqual(try WindowArrangement.frame(.leftHalf, window: straddling, screens: screens, host: nil), CGRect(x: 1440, y: 0, width: 1280, height: 1415))
        XCTAssertEqual(try WindowArrangement.frame(.rightHalf, window: straddling, screens: screens, host: nil), CGRect(x: 2720, y: 0, width: 1280, height: 1415))
        // Odd widths leave no gap between the halves.
        let odd = [CGRect(x: 0, y: 0, width: 1511, height: 900)]
        let left = try WindowArrangement.frame(.leftHalf, window: CGRect(x: 0, y: 0, width: 300, height: 300), screens: odd, host: nil)
        let right = try WindowArrangement.frame(.rightHalf, window: CGRect(x: 0, y: 0, width: 300, height: 300), screens: odd, host: nil)
        XCTAssertEqual(left.maxX, right.minX)
        XCTAssertEqual(right.maxX, 1511)
        XCTAssertThrowsError(try WindowArrangement.frame(.full, window: CGRect(x: 9000, y: 9000, width: 300, height: 300), screens: screens, host: nil)) { error in
            XCTAssertEqual((error as? UseError)?.code, "screen_unavailable")
        }
    }

    func testBesideOpenWorkUsesTheRoomOpenWorkLeaves() throws {
        let screens = [laptop, monitor]
        let window = CGRect(x: 600, y: 100, width: 600, height: 400)
        // OpenWork on the left: the window takes everything to its right.
        let openWorkLeft = CGRect(x: 0, y: 25, width: 560, height: 875)
        XCTAssertEqual(try WindowArrangement.frame(.besideOpenWork, window: window, screens: screens, host: openWorkLeft), CGRect(x: 560, y: 25, width: 880, height: 875))
        // OpenWork on the right: everything to its left.
        let openWorkRight = CGRect(x: 900, y: 25, width: 540, height: 875)
        XCTAssertEqual(try WindowArrangement.frame(.besideOpenWork, window: window, screens: screens, host: openWorkRight), CGRect(x: 0, y: 25, width: 900, height: 875))
        // OpenWork fills the screen: the half away from its middle, rather than a sliver.
        let openWorkWide = CGRect(x: 100, y: 25, width: 1200, height: 875)
        XCTAssertEqual(try WindowArrangement.frame(.besideOpenWork, window: window, screens: screens, host: openWorkWide), CGRect(x: 720, y: 25, width: 720, height: 875))
        // OpenWork on the other display: this screen is free.
        XCTAssertEqual(try WindowArrangement.frame(.besideOpenWork, window: window, screens: screens, host: CGRect(x: 1600, y: 100, width: 900, height: 900)), laptop)
        XCTAssertThrowsError(try WindowArrangement.frame(.besideOpenWork, window: window, screens: screens, host: nil)) { error in
            XCTAssertEqual((error as? UseError)?.code, "openwork_window_unavailable")
        }
    }

    func testClosingPutsAnArrangedWindowBackWhereThePersonHadIt() {
        let original = CGRect(x: 200, y: 120, width: 900, height: 640)
        let arranged = CGRect(x: 0, y: 25, width: 720, height: 875)
        let placement = WindowArrangement.Placement(window: AXUIElementCreateApplication(getpid()), original: original, arranged: arranged)
        XCTAssertEqual(WindowArrangement.restoring(placement, current: arranged), original)
        XCTAssertEqual(WindowArrangement.restoring(placement, current: CGRect(x: 1, y: 25, width: 721, height: 874)), original, "within the readback's rounding")
    }

    func testAWindowThePersonMovedSinceIsLeftWhereTheyPutIt() {
        let original = CGRect(x: 200, y: 120, width: 900, height: 640)
        let arranged = CGRect(x: 0, y: 25, width: 720, height: 875)
        let placement = WindowArrangement.Placement(window: AXUIElementCreateApplication(getpid()), original: original, arranged: arranged)
        XCTAssertNil(WindowArrangement.restoring(placement, current: CGRect(x: 300, y: 25, width: 720, height: 875)), "moved")
        XCTAssertNil(WindowArrangement.restoring(placement, current: CGRect(x: 0, y: 25, width: 1000, height: 875)), "resized")
        XCTAssertNil(WindowArrangement.restoring(placement, current: nil), "closed")
        XCTAssertNil(WindowArrangement.restoring(WindowArrangement.Placement(window: placement.window, original: original), current: original), "never arranged")
    }

    func testTheReceiptSaysWhetherTheAppTookTheWholeFrame() {
        let wanted = CGRect(x: 0, y: 25, width: 720, height: 875)
        XCTAssertTrue(WindowArrangement.matches(CGRect(x: 0, y: 25, width: 721, height: 874), wanted), "apps round sizes to their own grid")
        XCTAssertFalse(WindowArrangement.matches(CGRect(x: 0, y: 25, width: 900, height: 875), wanted), "an app that keeps a minimum width arranged only partly")
        XCTAssertFalse(WindowArrangement.matches(nil, wanted))
    }
}
