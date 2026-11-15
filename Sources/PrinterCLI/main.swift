import Foundation
import PrinterCLIKit

@main
struct PrinterCLI {
    @MainActor
    static func main() async {
        do {
            let options = try CLIOptions.parse(Array(CommandLine.arguments.dropFirst()))
            switch options.command {
            case .help:
                print(CLIOptions.usage)
            case .printPNG(let path):
                let bitmap = try RasterImage.loadPNG(at: URL(fileURLWithPath: path))
                let job = try PrintJob.image(bitmap)
                if options.dryRun {
                    print("Image: \(bitmap.width)x\(bitmap.height), hard threshold 160, transparency on white.")
                    print(job.summary)
                } else {
                    try options.requirePaperApproval()
                    guard let deviceID = options.device else { throw CLIError.paperApprovalRequired }
                    let client = try PrinterClient.native(timeout: options.timeout)
                    print(try await client.submit(job, deviceID: deviceID))
                }
            case .feed(let dots):
                let job = try PrintJob.feed(dots: dots)
                if options.dryRun {
                    print(job.summary)
                } else {
                    try options.requirePaperApproval()
                    guard let deviceID = options.device else { throw CLIError.paperApprovalRequired }
                    let client = try PrinterClient.native(timeout: options.timeout)
                    print(try await client.submit(job, deviceID: deviceID))
                }
            case .status:
                let client = try PrinterClient.native(timeout: options.timeout)
                print(try await client.status(deviceID: options.device, connect: options.connect))
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
