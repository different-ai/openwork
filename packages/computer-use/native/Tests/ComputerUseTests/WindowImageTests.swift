import XCTest
import AppKit
import ImageIO
@testable import ComputerUse

final class WindowImageTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

    /// A plain white capture, as ScreenCaptureKit would return for a window.
    private func capture(width: Int, height: Int) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }
    private func png(_ image: CGImage) throws -> Data {
        try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
    }
    /// Brightness at a pixel, top-left origin as in the observation image.
    private func gray(_ image: CGImage, _ x: Int, _ y: Int) throws -> CGFloat {
        let color = try XCTUnwrap(NSBitmapImageRep(cgImage: image).colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
        return (color.redComponent + color.greenComponent + color.blueComponent) / 3
    }

    func testSaveImageIsAnEmbeddedStepThatSendsNoInput() throws {
        let path = folder.appendingPathComponent("map.png").path
        guard case .saveImage(let file, let region, let replace) = try Action(["type": "save_image", "path": path,
            "region": ["x": 10, "y": 20, "width": 300, "height": 200]], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(file.path, path)
        XCTAssertEqual(region, CGRect(x: 10, y: 20, width: 300, height: 200))
        XCTAssertFalse(replace)
        let step = try Action(["type": "save_image", "path": path, "replace": true], policy: .embedded)
        XCTAssertFalse(step.requiresControl, "observe and assist sessions can save what they see")
        XCTAssertFalse(InputDelivery.stepNeedsFront(step, route: .skyLight, signedKeys: false), "it never takes the front")
        XCTAssertEqual(step.name, "save_image")
        XCTAssertThrowsError(try Action(["type": "save_image", "path": path], policy: .desktop), "only the OpenWork host offers it")
        XCTAssertThrowsError(try Action(["type": "save_image", "path": path, "replace": 1], policy: .embedded))
        XCTAssertThrowsError(try Action(["type": "save_image", "path": path, "region": ["x": 0, "y": 0, "width": 0, "height": 5]], policy: .embedded))
    }

    func testWritesAPNGOfTheCapturedSizeAndReadsItBack() throws {
        let file = try WindowImage.destination(folder.appendingPathComponent("map.png").path)
        let image = try capture(width: 1280, height: 800)
        let data = try png(try XCTUnwrap(WindowImage.redacted(image, captured: CGRect(x: 0, y: 0, width: 640, height: 400), protectedFrames: [])))
        let saved = try WindowImage.write(data, to: file, replace: false)
        XCTAssertEqual(saved, WindowImage.Saved(bytes: data.count, width: 1280, height: 800), "full resolution: two pixels per point")
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(file as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, "public.png")
        let read = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual([read.width, read.height], [1280, 800])
    }

    func testRegionCropMapsObservationPixelsToTheWindow() throws {
        // A 400×300-point window observed as an 800×600 image.
        let window = CGSize(width: 400, height: 300), observed = CGSize(width: 800, height: 600)
        XCTAssertEqual(try WindowImage.windowRegion(CGRect(x: 100, y: 50, width: 200, height: 100), image: observed, window: window),
            CGRect(x: 50, y: 25, width: 100, height: 50))
        for outside in [CGRect(x: 700, y: 0, width: 200, height: 100), CGRect(x: -1, y: 0, width: 10, height: 10)] {
            XCTAssertThrowsError(try WindowImage.windowRegion(outside, image: observed, window: window)) { error in
                XCTAssertEqual((error as? UseError)?.code, "invalid_arguments")
            }
        }
        XCTAssertThrowsError(try WindowImage.windowRegion(CGRect(x: 0, y: 0, width: 10, height: 10), image: .zero, window: window),
            "a region needs an observation image to be measured against")
    }

    func testMaskedFieldStaysMaskedInTheSavedImageAndItsCrop() throws {
        // A window at (1000, 500) with a password field at window points (100, 100, 60, 20).
        let field = CGRect(x: 1100, y: 600, width: 60, height: 20)
        let whole = try XCTUnwrap(WindowImage.redacted(try capture(width: 800, height: 600),
            captured: CGRect(x: 1000, y: 500, width: 400, height: 300), protectedFrames: [field]))
        XCTAssertLessThan(try gray(whole, 260, 220), 0.4, "inside the field, at two pixels per point")
        XCTAssertGreaterThan(try gray(whole, 100, 100), 0.9, "the rest of the window is untouched")
        // The region crop: window points (80, 90) to (280, 190). The field sits at (20, 10) inside it.
        let crop = try XCTUnwrap(WindowImage.redacted(try capture(width: 400, height: 200),
            captured: CGRect(x: 1080, y: 590, width: 200, height: 100), protectedFrames: [field]))
        XCTAssertLessThan(try gray(crop, 60, 30), 0.4, "the mask follows the field into the crop")
        XCTAssertGreaterThan(try gray(crop, 300, 150), 0.9)
        // And it is still masked in the file on disk.
        let file = try WindowImage.destination(folder.appendingPathComponent("crop.png").path)
        _ = try WindowImage.write(try png(crop), to: file, replace: false)
        let read = try XCTUnwrap(CGImageSourceCreateImageAtIndex(try XCTUnwrap(CGImageSourceCreateWithURL(file as CFURL, nil)), 0, nil))
        XCTAssertLessThan(try gray(read, 60, 30), 0.4)
    }

    func testRefusesAnExistingFileWithoutReplace() throws {
        let existing = folder.appendingPathComponent("flyer.png")
        try Data("keep me".utf8).write(to: existing)
        let file = try WindowImage.destination(existing.path)
        XCTAssertThrowsError(try FileHandoff.refuseReplacing(file, replace: false)) { error in
            XCTAssertEqual((error as? UseError)?.code, "file_exists")
        }
        let data = try png(try capture(width: 20, height: 10))
        // A file that appears between the check and the write is kept too.
        XCTAssertThrowsError(try WindowImage.write(data, to: file, replace: false)) { error in
            XCTAssertEqual((error as? UseError)?.code, "file_exists")
        }
        XCTAssertEqual(try Data(contentsOf: existing), Data("keep me".utf8))
        XCTAssertNoThrow(try FileHandoff.refuseReplacing(file, replace: true))
        XCTAssertEqual(try WindowImage.write(data, to: file, replace: true).width, 20)

        // Links are resolved, so the receipt names the real file.
        let link = folder.appendingPathComponent("link.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: existing)
        XCTAssertEqual(try WindowImage.destination(link.path).path, existing.path)
        for (path, code) in [("map.png", "invalid_arguments"), (folder.path + "/", "invalid_arguments"),
                             (folder.appendingPathComponent("map.jpg").path, "invalid_arguments"),
                             (folder.appendingPathComponent("missing/map.png").path, "folder_unavailable")] {
            XCTAssertThrowsError(try WindowImage.destination(path), path) { error in XCTAssertEqual((error as? UseError)?.code, code, path) }
        }
        let named = folder.appendingPathComponent("folder.png")
        try FileManager.default.createDirectory(at: named, withIntermediateDirectories: false)
        XCTAssertThrowsError(try WindowImage.destination(named.path), "never a folder")
    }

    func testRefusesWhenThePrivacyScanIsIncomplete() {
        for state in [WindowState(records: [], visited: 1, truncated: true, protectedFrames: []),
                      WindowState(records: [], visited: 1, truncated: false, protectedFrames: [], privacyIssue: "unverified"),
                      WindowState(records: [], visited: 1, truncated: false, protectedFrames: [CGRect(x: 0, y: 0, width: -1, height: 4)])] {
            XCTAssertThrowsError(try state.requireCapture()) { error in XCTAssertEqual((error as? UseError)?.code, "privacy_incomplete") }
        }
        XCTAssertNoThrow(try WindowState(records: [], visited: 1, truncated: false, protectedFrames: [CGRect(x: 0, y: 0, width: 10, height: 4)]).requireCapture())
    }
}
