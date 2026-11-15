import Foundation
import PrinterCLIKit

@main
struct PrinterCLI {
    static func main() async {
        do {
            let options = try CLIOptions.parse(Array(CommandLine.arguments.dropFirst()))
            switch options.command {
            case .help:
                print(CLIOptions.usage)
            case .printPNG(let path):
                let bitmap = try RasterImage.loadPNG(at: URL(fileURLWithPath: path))
                let job = try PrintJob.image(bitmap)
                if !options.dryRun { try job.requireSafeTransport() }
                print("Image: \(bitmap.width)x\(bitmap.height), hard threshold 160, transparency on white.")
                print(job.summary)
            case .feed(let dots):
                let job = try PrintJob.feed(dots: dots)
                if !options.dryRun { try job.requireSafeTransport() }
                print(job.summary)
            case .status:
                print(try await PrinterDiscovery.status(deviceID: options.device, timeout: options.timeout))
            case .testPattern(let path):
                try TestPattern.write(to: URL(fileURLWithPath: path))
                print("Created 384x288 PNG test pattern: \(path). No Bluetooth access or paper movement.")
            }
        } catch let error as CLIError {
            fail("[\(error.code)] \(error.localizedDescription)", code: error.exitCode)
        } catch is CancellationError {
            fail("[interrupted] Operation cancelled. No automatic retry.", code: 130)
        } catch {
            fail("[unexpected_error] \(error.localizedDescription)", code: 1)
        }
    }

    private static func fail(_ message: String, code: Int32) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(code)
    }
}
