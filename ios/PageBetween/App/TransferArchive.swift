import Foundation
import ReadiumZIPFoundation

enum TransferArchive {
    static func read(_ url: URL, into staging: URL) async throws -> TransferManifest {
        let archive = try await Archive(url: url, accessMode: .read), entries = try await archive.entries()
        guard entries.count <= 5001, Set(entries.map(\.path)).count == entries.count, let metadata = entries.first(where: { $0.path == "manifest.json" }), metadata.type == .file, metadata.uncompressedSize <= 4 * 1024 * 1024 else { throw LibraryFailure.invalidFile }
        let meta = staging.appendingPathComponent("manifest.json")
        guard try await archive.extract(metadata, to: meta) == metadata.checksum else { throw LibraryFailure.invalidFile }
        let manifest = try JSONDecoder().decode(TransferManifest.self, from: Data(contentsOf: meta)); try manifest.validate()
        guard Set(entries.map(\.path)) == Set(["manifest.json"] + manifest.books.map(\.file)) else { throw LibraryFailure.invalidFile }
        var total: UInt64 = 0
        for book in manifest.books {
            guard let entry = entries.first(where: { $0.path == book.file }), entry.type == .file, entry.uncompressedSize > 0, entry.uncompressedSize <= 200 * 1024 * 1024 else { throw LibraryFailure.invalidFile }
            total += entry.uncompressedSize; guard total <= 1024 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
            let target = staging.appendingPathComponent(URL(fileURLWithPath: book.file).lastPathComponent)
            guard try await archive.extract(entry, to: target) == entry.checksum, try TransferManifest.hash(target) == book.sha256 else { throw LibraryFailure.invalidFile }
        }
        return manifest
    }
}
