import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// The masks for a capture taken between two reads of the window: every protected field
/// either read found, so one that appeared or moved while the image was taken stays hidden.
enum CaptureMasks {
    static func during(before: [CGRect], after: [CGRect]) -> [CGRect] {
        before + after.filter { frame in !before.contains(frame) }
    }
}

/// Saving what the agent sees in the session's window as a PNG file, so another app can
/// use it (open it, place it). The image is the observation's capture at full resolution,
/// with the same privacy masks; only the file leaves the helper.
enum WindowImage {
    /// The longest side a saved image may have: a full-screen window on a 6K display fits.
    static let maxLongSide: CGFloat = 8_192

    /// Where the image is written: `FileHandoff.destination`'s rules (absolute, existing folder,
    /// links resolved, never a folder) for a `.png` name, since the file is a PNG.
    static func destination(_ path: String) throws -> URL {
        let name = (path as NSString).lastPathComponent
        guard name.count > 4, name.lowercased().hasSuffix(".png") else {
            throw UseError("invalid_arguments", "path must be an absolute path ending in a .png file name, such as /Users/…/Desktop/map.png: the image is saved as a PNG.")
        }
        return try FileHandoff.destination(path)
    }

    /// The window-local points (top-left origin) that a region of the observation image covers.
    static func windowRegion(_ pixels: CGRect, image: CGSize, window: CGSize) throws -> CGRect {
        guard image.width > 0, image.height > 0, pixels.width >= 1, pixels.height >= 1,
              CGRect(origin: .zero, size: image).contains(pixels) else {
            throw UseError("invalid_arguments", "region must lie inside the observation image, in its pixels. Nothing was saved.", next: "observe")
        }
        let x = window.width / image.width, y = window.height / image.height
        return CGRect(x: pixels.minX * x, y: pixels.minY * y, width: pixels.width * x, height: pixels.height * y)
    }

    /// The pixel density of the display that shows most of `bounds` (global, top-left origin),
    /// so the saved image has the window's real pixels: never upscaled on a standard display.
    @MainActor static func scale(for bounds: CGRect) -> CGFloat {
        let shown = NSScreen.screens.compactMap { screen -> (CGFloat, CGFloat)? in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            let overlap = CGDisplayBounds(CGDirectDisplayID(number.uint32Value)).intersection(bounds)
            return overlap.isNull ? nil : (overlap.width * overlap.height, screen.backingScaleFactor)
        }
        return shown.max { $0.0 < $1.0 }?.1 ?? NSScreen.main?.backingScaleFactor ?? 2
    }

    /// Masks protected fields in a capture of `captured` (global points). Observations and saved
    /// images share it, so a field masked for the model is masked in the file too.
    static func redacted(_ image: CGImage, captured: CGRect, protectedFrames: [CGRect]) -> CGImage? {
        guard captured.width > 0, captured.height > 0,
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.setFillColor(CGColor(gray: 0.15, alpha: 1))
        let xScale = CGFloat(image.width) / captured.width
        let yScale = CGFloat(image.height) / captured.height
        for rect in protectedFrames {
            let clipped = rect.intersection(captured)
            guard !clipped.isNull, !clipped.isEmpty else { continue }
            context.fill(CGRect(x: (clipped.minX - captured.minX) * xScale,
                y: CGFloat(image.height) - (clipped.maxY - captured.minY) * yScale,
                width: clipped.width * xScale, height: clipped.height * yScale).insetBy(dx: -2, dy: -2))
        }
        return context.makeImage()
    }

    struct Saved: Equatable { let bytes: Int; let width: Int; let height: Int }

    /// Writes the PNG and reads it back from disk: reported only once it is there, a PNG
    /// of the captured size. Without `replace`, a file that appeared meanwhile is kept.
    static func write(_ png: Data, to url: URL, replace: Bool) throws -> Saved {
        do { try png.write(to: url, options: replace ? .atomic : .withoutOverwriting) }
        catch CocoaError.fileWriteFileExists {
            throw UseError("file_exists", "A file appeared at that path while saving and was kept. Nothing was saved.", next: "correct_request")
        } catch {
            throw UseError("save_failed", "The image could not be written there. Nothing was saved; choose another folder.", next: "correct_request")
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              (CGImageSourceGetType(source) as String?) == UTType.png.identifier,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber,
              bytes.intValue == png.count else {
            throw UseError("save_unconfirmed", "The file on disk does not read back as the saved image. Check it before using it.", next: "observe")
        }
        return Saved(bytes: bytes.intValue, width: width, height: height)
    }
}
