import CoreGraphics
import ImageIO
import XCTest
@testable import ComputerUse

/// Coordinate steps compare the live window with the observation where they land: an animation
/// that was still running, or a blinking caret, must not refuse a step that lands as observed.
final class SettledImageTests: XCTestCase {
    private enum Mark { case rect(CGRect, CGColor) }
    /// A white window with a line of dark text, then the given marks; top-down pixel coordinates.
    private func image(_ marks: [Mark] = [], width: Int = 240, height: Int = 160, jpeg: Bool = true) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        func fill(_ rect: CGRect, _ color: CGColor) {
            context.setFillColor(color)
            context.fill(CGRect(x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height))
        }
        // "Come have coffee": glyph-sized dark blocks before the caret.
        for x in stride(from: 40, to: 110, by: 9) { fill(CGRect(x: x, y: 60, width: 6, height: 22), CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)) }
        for case let .rect(rect, color) in marks { fill(rect, color) }
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, (jpeg ? "public.jpeg" : "public.png") as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()),
            [kCGImageDestinationLossyCompressionQuality: ImagePolicy.precise.jpegQuality] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
    private let ink = CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
    private let caretAt = CGPoint(x: 116, y: 70)
    private func caret(x: CGFloat = 115, width: CGFloat = 2, height: CGFloat = 24) -> Mark { .rect(CGRect(x: x, y: 59, width: width, height: height), ink) }

    func testAClickOnABlinkingCaretLandsAsObserved() throws {
        // The observation caught the caret on; the live window has it off, and the other way round.
        for (observed, live) in [(try image([caret()]), try image()), (try image(), try image([caret()]))] {
            XCTAssertTrue(ImageRegions.unchanged(observed, live, around: [caretAt]))
        }
        // A caret one or three pixels wide, as a scaled window draws it.
        XCTAssertTrue(ImageRegions.unchanged(try image([caret(width: 1)]), try image(), around: [caretAt]))
        XCTAssertTrue(ImageRegions.unchanged(try image([caret(width: 3)]), try image(), around: [caretAt]))
        // Lossless captures too.
        XCTAssertTrue(ImageRegions.unchanged(try image([caret()], jpeg: false), try image(jpeg: false), around: [caretAt]))
    }

    func testACaretNeverHidesARealChange() throws {
        let observed = try image()
        // A letter typed where the click lands is wider than a caret.
        XCTAssertFalse(ImageRegions.unchanged(observed, try image([.rect(CGRect(x: 114, y: 60, width: 7, height: 22), ink)]), around: [caretAt]))
        // An underline or a horizontal rule: flat, not upright.
        XCTAssertFalse(ImageRegions.unchanged(observed, try image([.rect(CGRect(x: 100, y: 84, width: 30, height: 2), ink)]), around: [caretAt]))
        // A short tick or dot is not a caret.
        XCTAssertFalse(ImageRegions.unchanged(observed, try image([.rect(CGRect(x: 115, y: 70, width: 2, height: 3), ink)]), around: [caretAt]))
        // The caret blinked and a control near it changed too.
        XCTAssertFalse(ImageRegions.unchanged(try image([caret()]),
            try image([.rect(CGRect(x: 140, y: 90, width: 6, height: 6), CGColor(red: 0, green: 0.4, blue: 1, alpha: 1))]), around: [caretAt]))
        // A highlight drawn behind the text: a change over the whole area.
        XCTAssertFalse(ImageRegions.unchanged(observed, try image([.rect(CGRect(x: 90, y: 50, width: 60, height: 40), CGColor(red: 1, green: 0.9, blue: 0.5, alpha: 1))]),
            around: [caretAt]))
        // A dashed vertical selection edge: upright and thin, but not solid.
        let dashes = stride(from: 50, to: 90, by: 8).map { Mark.rect(CGRect(x: 115, y: CGFloat($0), width: 2, height: 2), ink) }
        XCTAssertFalse(ImageRegions.unchanged(observed, try image(dashes), around: [caretAt]))
    }

    func testCaretRulesOnRawPixels() {
        func crop(_ marks: [(Int, Int, Int, Int, UInt8)], width: Int = 40, height: Int = 40) -> Data {
            var pixels = Data(repeating: 255, count: width * height * 4)
            for (x0, y0, w, h, level) in marks {
                for y in y0..<(y0 + h) { for x in x0..<(x0 + w) { let i = (y * width + x) * 4; pixels[i] = level; pixels[i + 1] = level; pixels[i + 2] = level } }
            }
            return pixels
        }
        let blank = crop([])
        XCTAssertTrue(ImageRegions.caretOnly(blank, crop([(20, 5, 2, 20, 0)]), width: 40, height: 40))
        XCTAssertFalse(ImageRegions.caretOnly(blank, blank, width: 40, height: 40), "nothing strong changed: not a caret, and no change at all compares equal before this")
        XCTAssertFalse(ImageRegions.caretOnly(blank, crop([(20, 5, 5, 20, 0)]), width: 40, height: 40), "five pixels wide")
        XCTAssertFalse(ImageRegions.caretOnly(blank, crop([(20, 5, 2, 20, 220)]), width: 40, height: 40), "a faint tint is not a caret")
        XCTAssertFalse(ImageRegions.caretOnly(blank, crop([(20, 5, 2, 20, 0), (2, 38, 1, 1, 250)]), width: 40, height: 40),
            "a faint change beyond the caret's JPEG block")
        XCTAssertFalse(ImageRegions.caretOnly(blank, crop([(5, 5, 2, 20, 0), (30, 5, 2, 20, 0)]), width: 40, height: 40), "two strips")
    }

    @MainActor
    func testAnAnimatingWindowIsObservedOnceItHoldsStill() async throws {
        // Look Around turning: three frames, then it holds still.
        var frames = [Data([1]), Data([2]), Data([3]), Data([3]), Data([3])]
        var clock: TimeInterval = 0
        let (last, still) = try await ObservationSettle.settle(first: Data([0]), digest: { $0 }, capture: { frames.removeFirst() },
            now: { clock }, sleep: { clock += $0 })
        XCTAssertEqual(last, Data([3])); XCTAssertTrue(still)
        XCTAssertEqual(frames.count, 1, "stops at the first two captures that match")
    }

    @MainActor
    func testSettlingIsBounded() async throws {
        var clock: TimeInterval = 0
        var n: UInt8 = 0
        let (_, still) = try await ObservationSettle.settle(first: Data([0]), digest: { $0 }, capture: { n &+= 1; return Data([n]) },
            now: { clock }, sleep: { clock += $0 })
        XCTAssertFalse(still, "a window that never holds still is reported as still changing")
        XCTAssertLessThanOrEqual(clock, ObservationSettle.limit + ObservationSettle.interval)
        // A capture that failed mid-change keeps the last complete one.
        let (kept, settled) = try await ObservationSettle.settle(first: Data([7]), digest: { $0 }, capture: { nil }, now: { clock }, sleep: { clock += $0 })
        XCTAssertEqual(kept, Data([7])); XCTAssertFalse(settled)
    }

    func testOnlyAnimatingWindowsSettleAndOnlyAfterInput() {
        let after = ActionBaseline(generation: 1, stateDigest: Data(), imageDigest: nil)
        XCTAssertTrue(ObservationSettle.applies(info: ["LSApplicationCategoryType": "public.app-category.travel"], baseline: after), "Maps")
        XCTAssertTrue(ObservationSettle.applies(info: ["LSApplicationCategoryType": "public.app-category.graphics-design"], baseline: after), "PhotoCraft")
        XCTAssertFalse(ObservationSettle.applies(info: ["LSApplicationCategoryType": "public.app-category.productivity"], baseline: after))
        XCTAssertTrue(ObservationSettle.applies(info: [:], baseline: ActionBaseline(generation: 1, stateDigest: Data(), imageDigest: nil, moved: true)),
            "after a drag or scroll in any app")
        XCTAssertFalse(ObservationSettle.applies(info: ["LSApplicationCategoryType": "public.app-category.travel"], baseline: nil), "a first look waits for nothing")
    }
}
