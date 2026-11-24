import XCTest
@testable import ComputerUse

final class PointerAddressingTests: XCTestCase {
    // Another process's window away from the main screen's bottom-left corner,
    // like Blender's window above the Dock.
    let window: CGWindowID = 987_654
    let frame = CGRect(x: 243, y: 141, width: 673, height: 439)

    @MainActor
    func testPointerEventsForAnotherAppsWindowAreAddressedToIt() throws {
        let point = CGPoint(x: 580.5, y: 360.25)
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseUp] {
            let event = try MacInput.pointerEvent(type, point, count: 1, windowID: window, frame: frame)
            XCTAssertNoThrow(try MacInput.verifyTargeted(event, point, windowID: window, frame: frame), "\(type.rawValue)")
        }
        let scroll = try MacInput.scrollEvent(point, dx: 0, dy: -120, windowID: window, frame: frame)
        XCTAssertNoThrow(try MacInput.verifyTargeted(scroll, point, windowID: window, frame: frame))
    }

    @MainActor
    func testEventsForAnotherWindowOrPointAreNotPosted() throws {
        let point = CGPoint(x: 580.5, y: 360.25)
        let event = try MacInput.pointerEvent(.leftMouseDown, point, count: 1, windowID: window, frame: frame)
        let moved = frame.offsetBy(dx: 0, dy: 58)
        for (windowID, frame, point) in [(window + 1, frame, point), (window, moved, point), (window, frame, CGPoint(x: point.x, y: point.y + 2))] {
            XCTAssertThrowsError(try MacInput.verifyTargeted(event, point, windowID: windowID, frame: frame)) { error in
                XCTAssertEqual((error as? UseError)?.code, "unsupported_pointer_input")
            }
        }
    }
}
