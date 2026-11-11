import Foundation
import ReadiumZIPFoundation

enum TransferArchive {
    static func read(_ url: URL, into staging: URL) async throws -> TransferManifest {
        let archive = try await Archive(url: url, accessMode: .read), entries = try await archive.entries()
        guard entries.count <= 60001, Set(entries.map(\.path)).count == entries.count, let metadata = entries.first(where: { $0.path == "manifest.json" }), metadata.type == .file, metadata.uncompressedSize <= 4 * 1024 * 1024 else { throw LibraryFailure.invalidFile }
        let meta = staging.appendingPathComponent("manifest.json")
        guard try await archive.extract(metadata, to: meta) == metadata.checksum else { throw LibraryFailure.invalidFile }
        var manifest = try JSONDecoder().decode(TransferManifest.self, from: Data(contentsOf: meta)); try manifest.validate()
        var expected = Set(["manifest.json"] + manifest.books.map(\.file))
        let records = Dictionary(manifest.books.compactMap(\.records).map { ($0.file, $0) }, uniquingKeysWith: { a, _ in a })
        let imageFiles = Dictionary(uniqueKeysWithValues: (manifest.images ?? []).map { ($0.file, $0) })
        expected.formUnion(records.keys); expected.formUnion(imageFiles.keys)
        guard Set(entries.map(\.path)) == expected else { throw LibraryFailure.invalidFile }
        let indexed = Dictionary(uniqueKeysWithValues: entries.map { ($0.path, $0) })
        var total: UInt64 = 0
        for name in expected where name != "manifest.json" {
            guard let entry = indexed[name], entry.type == .file, entry.uncompressedSize > 0 else { throw LibraryFailure.invalidFile }
            let resource = records[name] ?? imageFiles[name]
            guard resource.map({ UInt64($0.size) == entry.uncompressedSize }) ?? (entry.uncompressedSize <= 200 * 1024 * 1024) else { throw LibraryFailure.invalidFile }
            total += entry.uncompressedSize; guard total <= 1024 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
        }
        for name in expected.sorted() where name != "manifest.json" {
            let entry = indexed[name]!
            let target = name.hasPrefix("books/") ? staging.appendingPathComponent(URL(fileURLWithPath: name).lastPathComponent) : staging.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard try await archive.extract(entry, to: target) == entry.checksum, try TransferManifest.hash(target) == target.deletingPathExtension().lastPathComponent else { throw LibraryFailure.invalidFile }
            if name.hasPrefix("images/") { try SourceAttachment.inspect(Data(contentsOf: target), png: target.pathExtension == "png") }
        }
        var images = Set<String>()
        for index in manifest.books.indices {
            if let record = manifest.books[index].records {
                let value = try JSONDecoder().decode(TransferRecords.self, from: Data(contentsOf: staging.appendingPathComponent(record.file)))
                try value.validate()
                images.formUnion(value.images.map(\.file))
                manifest.books[index].recordsData = value
            }
        }
        guard images == Set(manifest.images?.map(\.file) ?? []) else { throw LibraryFailure.invalidFile }
        return manifest
    }
}
