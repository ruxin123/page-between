import Foundation
import CryptoKit
import ReadiumZIPFoundation

@main struct TransferFixture {
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let good = root.appendingPathComponent("good.pbtransfer")
        let extracted = root.appendingPathComponent("native-read")
        try FileManager.default.createDirectory(at: extracted, withIntermediateDirectories: true)
        var manifest = try await TransferArchive.read(good, into: extracted)
        precondition(manifest.books.count == 1 && manifest.books[0].position.progress == 0.4)
        precondition(manifest.books[0].bookmarks.count == 1)
        let legacyFolder = root.appendingPathComponent("legacy-native")
        try FileManager.default.createDirectory(at: legacyFolder, withIntermediateDirectories: true)
        let legacy = try await TransferArchive.read(root.appendingPathComponent("legacy.pbtransfer"), into: legacyFolder)
        precondition(legacy.schema == 1 && legacy.books.first?.position.progress == 0.4 && legacy.books.first?.recordsData == nil)
        let output = try await Archive(url: root.appendingPathComponent("native.pbtransfer"), accessMode: .create)
        let records = manifest.books[0].recordsData!
        precondition(records.excerpts.first?.note == "原创笔记" && records.translations.first?.translation.contains("$x^2$") == true)
        precondition(records.conversations.first?.messages.last?.references?.first?.number == 3 && records.appearance?.theme == "night")
        let encoded = try JSONEncoder().encode(records)
        let sha = SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
        let record = "records/" + sha + ".json", recordFile = root.appendingPathComponent("native-records.json")
        try encoded.write(to: recordFile)
        manifest.books[0].records = TransferFile(file: record, sha256: sha, size: encoded.count)
        try await output.addEntry(with: record, fileURL: recordFile)
        for image in manifest.images ?? [] { try await output.addEntry(with: image.file, fileURL: extracted.appendingPathComponent(image.file)) }
        let metadata = root.appendingPathComponent("native-manifest.json")
        try JSONEncoder().encode(manifest).write(to: metadata)
        try await output.addEntry(with: "manifest.json", fileURL: metadata)
        for book in manifest.books { try await output.addEntry(with: book.file, fileURL: extracted.appendingPathComponent(URL(fileURLWithPath: book.file).lastPathComponent)) }
        for name in ["tampered", "asset", "record", "extra", "duplicate", "symlink", "traversal"] {
            let target = root.appendingPathComponent("reject-" + name)
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            do { _ = try await TransferArchive.read(root.appendingPathComponent(name + ".pbtransfer"), into: target); fatalError("Accepted invalid archive: " + name) }
            catch { }
        }
        print("Native transfer reader/writer, integrity and unsafe-archive rejection passed")
    }
}
