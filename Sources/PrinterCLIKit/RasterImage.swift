import CoreGraphics
import Foundation
import ImageIO
import PocketPrinter5890Kit
import UniformTypeIdentifiers

public enum RasterImage {
    public static let width = 384
    public static let maximumHeight = 4096
    public static let maximumFileBytes = 16 * 1024 * 1024

    public static func loadPNG(at url: URL) throws -> MonochromeBitmap {
        let handle: FileHandle
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true else {
                throw CLIError.image("PNG input must be a regular file.")
            }
            guard let size = values.fileSize, size <= maximumFileBytes else {
                throw CLIError.image("PNG exceeds the 16 MiB input limit.")
            }
            handle = try FileHandle(forReadingFrom: url)
        } catch let error as CLIError {
            throw error
        } catch {
            throw CLIError.image("Cannot open PNG: \(error.localizedDescription)")
        }
        let data: Data
        do {
            data = try handle.read(upToCount: maximumFileBytes + 1) ?? Data()
            try handle.close()
        } catch {
            throw CLIError.image("Cannot read PNG: \(error.localizedDescription)")
        }
        return try decodePNG(data)
    }

    public static func decodePNG(_ data: Data) throws -> MonochromeBitmap {
        guard data.count <= maximumFileBytes else {
            throw CLIError.image("PNG exceeds the 16 MiB input limit.")
        }
        guard data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == UTType.png.identifier,
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let imageWidth = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else {
            throw CLIError.image("Expected a valid single-frame PNG, not another image format.")
        }
        guard imageWidth == width, (1...maximumHeight).contains(height) else {
            throw CLIError.image("PNG must be 384 pixels wide and 1...4096 pixels high; got \(imageWidth)x\(height). No automatic resizing.")
        }
        if let orientation = properties[kCGImagePropertyOrientation] as? Int, orientation != 1 {
            throw CLIError.image("Normalize PNG orientation before printing.")
        }
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, [
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary),
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
              ) else {
            throw CLIError.image("PNG pixel data could not be decoded.")
        }
        // Composite transparency over paper-white before upstream hard thresholding.
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let pixels = context.data else {
            throw CLIError.image("Cannot access decoded PNG pixels.")
        }
        let grayscale = Array(UnsafeBufferPointer(
            start: pixels.assumingMemoryBound(to: UInt8.self), count: width * height
        ))
        return try MonochromeConverter.threshold(
            grayscale: grayscale, width: width, height: height, threshold: 160
        )
    }

    public static func pngData(for image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw CLIError.image("Cannot create PNG encoder.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw CLIError.image("Cannot encode PNG.")
        }
        return data as Data
    }
}
