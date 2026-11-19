import CoreGraphics
import ImageIO
import XCTest
@testable import ComputerUse

final class InterruptionRecoveryTests: XCTestCase {
    /// A plain window image, with an optional square of changed pixels.
    private func png(width: Int = 200, height: Int = 120, changed: CGRect? = nil, type: String = "public.png") throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if let changed {
            context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
            // CGContext draws bottom-up; observation pixels are top-down.
            context.fill(CGRect(x: changed.minX, y: CGFloat(height) - changed.maxY, width: changed.width, height: changed.height))
        }
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()),
            [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    func testPointerInputProceedsWhenOnlyPixelsElsewhereChanged() throws {
        let observed = try png()
        // A clock or rendering canvas in the bottom-right corner changed since the observation.
        let live = try png(changed: CGRect(x: 160, y: 90, width: 20, height: 20))
        XCTAssertTrue(ImageRegions.unchanged(observed, live, around: [CGPoint(x: 30, y: 33)]), "a click at the top left lands on what the model saw")
        XCTAssertTrue(ImageRegions.unchanged(observed, live, around: [CGPoint(x: 20, y: 20), CGPoint(x: 60, y: 20), CGPoint(x: 100, y: 30)]),
            "a drag far from the change keeps going")
        // Observations are often JPEG: unchanged blocks decode to the same pixels.
        let jpeg = try png(type: "public.jpeg"), liveJPEG = try png(changed: CGRect(x: 160, y: 90, width: 20, height: 20), type: "public.jpeg")
        XCTAssertTrue(ImageRegions.unchanged(jpeg, liveJPEG, around: [CGPoint(x: 30, y: 33)]))
        XCTAssertFalse(ImageRegions.unchanged(jpeg, liveJPEG, around: [CGPoint(x: 170, y: 100)]))
    }

    func testPointerInputStopsWhenPixelsChangedWhereItLands() throws {
        let observed = try png()
        let live = try png(changed: CGRect(x: 160, y: 90, width: 20, height: 20))
        XCTAssertFalse(ImageRegions.unchanged(observed, live, around: [CGPoint(x: 170, y: 100)]))
        XCTAssertFalse(ImageRegions.unchanged(observed, live, around: [CGPoint(x: 140, y: 75)]), "the change is within the checked radius")
        XCTAssertFalse(ImageRegions.unchanged(observed, live, around: [CGPoint(x: 20, y: 20), CGPoint(x: 165, y: 95)]), "any point of a drag counts")
    }

    func testPointerInputStopsWithoutAComparableImage() throws {
        let observed = try png()
        XCTAssertFalse(ImageRegions.unchanged(nil, observed, around: [CGPoint(x: 10, y: 10)]))
        XCTAssertFalse(ImageRegions.unchanged(observed, try png(width: 220), around: [CGPoint(x: 10, y: 10)]), "a resized window needs a new look")
        XCTAssertFalse(ImageRegions.unchanged(observed, Data("not an image".utf8), around: [CGPoint(x: 10, y: 10)]))
        XCTAssertFalse(ImageRegions.unchanged(observed, observed, around: []))
    }

    @MainActor
    func testKeysPutFocusBackOnTheObservedFieldOnce() throws {
        var focused = false
        var refocused = 0
        try FocusRecovery.check(validate: {
            guard focused else { throw UseError("focus_changed", "The exact observed keyboard target changed.") }
        }, refocus: { refocused += 1; focused = true; return true })
        XCTAssertEqual(refocused, 1)
    }

    @MainActor
    func testKeysStopWhenFocusCannotBeRestored() {
        for refocusWorks in [false, true] {
            var refocused = 0
            XCTAssertThrowsError(try FocusRecovery.check(validate: {
                throw UseError("focus_changed", "The exact observed keyboard target changed.")
            }, refocus: { refocused += 1; return refocusWorks })) { error in
                XCTAssertEqual((error as? UseError)?.code, "focus_changed")
            }
            XCTAssertEqual(refocused, 1, "one attempt, never a loop")
        }
    }

    @MainActor
    func testKeysWithNoKnownFieldAreNotGuessed() {
        var refocused = false
        XCTAssertThrowsError(try FocusRecovery.check(validate: {
            throw UseError("focus_required", "Observe a focused normal text field or control before using the keyboard.")
        }, refocus: { refocused = true; return true })) { error in
            XCTAssertEqual((error as? UseError)?.code, "focus_required")
        }
        XCTAssertFalse(refocused)
    }
}
