import CardRendererKit
import Foundation

@main
struct CardRendererCLI {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--help"] {
            print("Usage: card-renderer <template.json|-> <new.png>\nOffline JSON-to-PNG renderer. No helper, Bluetooth or paper. JSON layout report on stdout.")
            return
        }
        do {
            guard args.count == 2 else { throw CardError.invalid("Usage: card-renderer <template.json|-> <new.png>") }
            let handle: FileHandle
            if args[0] == "-" {
                handle = .standardInput
            } else {
                let url = URL(fileURLWithPath: args[0])
                guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
                    throw CardError.invalid("Template must be a regular file.")
                }
                handle = try FileHandle(forReadingFrom: url)
            }
            var data = Data()
            while data.count <= CardRenderer.maximumInputBytes {
                let chunk = try handle.read(upToCount: CardRenderer.maximumInputBytes + 1 - data.count) ?? Data()
                if chunk.isEmpty { break }
                data.append(chunk)
            }
            if args[0] != "-" { try handle.close() }
            let result = try CardRenderer.render(data)
            try result.png.write(to: URL(fileURLWithPath: args[1]), options: .withoutOverwriting)
            let report = try JSONEncoder().encode(result.report)
            FileHandle.standardOutput.write(report + Data("\n".utf8))
        } catch let error as CardError {
            fail(error.localizedDescription)
        } catch {
            // Do not echo input, filenames or provider content into diagnostics.
            fail("Could not read template or write PNG; existing files are never overwritten.")
        }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("[invalid_card] \(message)\n".utf8))
        exit(2)
    }
}
