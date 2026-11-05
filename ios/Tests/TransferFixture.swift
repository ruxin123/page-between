import Foundation
import ReadiumZIPFoundation

@main struct TransferFixture {
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let good = root.appendingPathComponent("good.pbtransfer")
        let extracted = root.appendingPathComponent("native-read")
        try FileManager.default.createDirectory(at: extracted, withIntermediateDirectories: true)
        let manifest = try await TransferArchive.read(good, into: extracted)
        precondition(manifest.books.count == 1 && manifest.books[0].position.progress == 0.4)
        precondition(manifest.books[0].bookmarks.count == 1)
        let output = try await Archive(url: root.appendingPathComponent("native.pbtransfer"), accessMode: .create)
        let metadata = root.appendingPathComponent("native-manifest.json")
        try JSONEncoder().encode(manifest).write(to: metadata)
        try await output.addEntry(with: "manifest.json", fileURL: metadata)
        for book in manifest.books { try await output.addEntry(with: book.file, fileURL: extracted.appendingPathComponent(URL(fileURLWithPath: book.file).lastPathComponent)) }
        for name in ["tampered", "extra", "duplicate", "symlink", "traversal"] {
            let target = root.appendingPathComponent("reject-" + name)
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            do { _ = try await TransferArchive.read(root.appendingPathComponent(name + ".pbtransfer"), into: target); fatalError("Accepted invalid archive: " + name) }
            catch { }
        }
        print("Native transfer reader/writer, integrity and unsafe-archive rejection passed")
    }
}
