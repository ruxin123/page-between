import SwiftUI
import UniformTypeIdentifiers
import ReadiumShared
import ReadiumZIPFoundation

struct TransferScreen: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: LibraryStore
    var incoming: URL? = nil
    @State private var choosing = false
    @State private var busy = false
    @State private var message = ""
    @State private var exported: URL?
    @State private var folder = FileManager.default.temporaryDirectory.appendingPathComponent("transfer-" + UUID().uuidString)
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("迁移书籍、进度与书签。已有同书保留本机记录，服务密钥不迁移。").font(.callout)
                    Button("导出迁移包") { perform { exported = nil; exported = try await exportBooks(); message = "" } }.disabled(busy || store.importing)
                    if let exported { ShareLink("发送或存储迁移包", item: exported) }
                    Button("导入迁移包") { choosing = true }.disabled(busy || store.importing)
                } footer: { Text("通过隔空投送或文件传输。文本按章节与进度恢复，排版不同可能略有偏移。") }
                if busy { ProgressView() }
                if !message.isEmpty { Text(message) }
            }.navigationTitle("设备迁移").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("完成") { dismiss() }.disabled(busy) }
                .fileImporter(isPresented: $choosing, allowedContentTypes: [UTType("local.pagebetween.transfer") ?? .item]) { result in
                    switch result { case .success(let url): perform { try await importBooks(url) }; case .failure(let error): message = error.localizedDescription }
                }
                .task { if let incoming { perform { try await importBooks(incoming) } } }
                .onDisappear { try? FileManager.default.removeItem(at: folder) }
        }.tint(MobilePalette.accent).interactiveDismissDisabled(busy)
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true; message = ""
        Task { @MainActor in defer { busy = false }; do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true); try await action() } catch { message = error.localizedDescription } }
    }
    private func portable(_ raw: String?, book: MobileBook, publication: Publication) throws -> TransferPosition {
        guard let raw, let locator = try? Locator(jsonString: raw) else { return TransferPosition() }
        let index = book.format == "pdf" ? locator.locations.position ?? 1 : (publication.readingOrder.firstIndex(where: { $0.href == locator.href.description }) ?? 0) + 1
        let y = locator.locations.fragments.first(where: { $0.hasPrefix("y=") }).flatMap { Double($0.dropFirst(2)) } ?? 0
        return TransferPosition(index: index, progress: locator.locations.totalProgression ?? book.progress, chapterFraction: locator.locations.progression ?? 0, pdfY: y)
    }
    private func locator(_ position: TransferPosition, book: MobileBook, publication: Publication) throws -> String {
        let index = min(max(0, position.index - 1), max(0, publication.readingOrder.count - 1))
        let href = publication.readingOrder.indices.contains(index) ? publication.readingOrder[index].href : "original.pdf"
        let locations: [String: Any] = book.format == "pdf" ? ["position":position.index, "fragments":["page=\(position.index)", "y=\(position.pdfY)"], "totalProgression":position.progress] : ["progression":position.chapterFraction, "totalProgression":position.progress]
        let value: [String: Any] = ["href":href, "type":book.format == "pdf" ? "application/pdf" : "application/xhtml+xml", "locations":locations]
        return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
    private func exportBooks() async throws -> URL {
        let target = folder.appendingPathComponent("页间迁移.pbtransfer")
        try? FileManager.default.removeItem(at: target)
        let archive = try await Archive(url: target, accessMode: .create)
        var books: [TransferBook] = [], total = 0
        let selected = await store.repository.books()
        for (offset, book) in selected.enumerated() {
            message = "正在导出 \(offset + 1) / \(selected.count) 本"
            let source = try await store.repository.file(book, name: book.originalName)
            let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            total += size
            guard size > 0, size <= 200 * 1024 * 1024, total <= 1024 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
            let publication = try await store.open(book)
            let name = "books/" + book.sourceHash + "." + book.format
            try await archive.addEntry(with: name, fileURL: source, compressionMethod: .deflate)
            let marks = try book.bookmarks.map { TransferBookmark(title: $0.title, position: try portable($0.locator, book: book, publication: publication)) }
            books.append(TransferBook(title: book.title, author: book.author, file: name, sha256: book.sourceHash, position: try portable(book.locator, book: book, publication: publication), bookmarks: marks))
        }
        let manifest = TransferManifest(books: books); try manifest.validate()
        let meta = folder.appendingPathComponent("manifest.json")
        let encoded = try JSONEncoder().encode(manifest)
        guard encoded.count <= 4 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
        try encoded.write(to: meta)
        try await archive.addEntry(with: "manifest.json", fileURL: meta, compressionMethod: .deflate)
        return target
    }
    private func importBooks(_ url: URL) async throws {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        let staging = folder.appendingPathComponent(UUID().uuidString); try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        let manifest = try await TransferArchive.read(url, into: staging)
        var added = 0, duplicates = 0, failed: [String] = []
        for (offset, item) in manifest.books.enumerated() {
            message = "正在导入 \(offset + 1) / \(manifest.books.count) 本"
            if await store.repository.books(includingDeleted: true).contains(where: { $0.sourceHash == item.sha256 }) { duplicates += 1; continue }
            let source = staging.appendingPathComponent(URL(fileURLWithPath: item.file).lastPathComponent)
            store.error = nil
            let namedFolder = staging.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: namedFolder, withIntermediateDirectories: true)
            let title = String(item.title.prefix(120)).replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: "\0", with: "_")
            let named = namedFolder.appendingPathComponent((title.isEmpty ? "书籍" : title) + "." + source.pathExtension)
            try FileManager.default.copyItem(at: source, to: named)
            await store.importFiles([named])
            guard var book = await store.repository.books().first(where: { $0.sourceHash == item.sha256 }) else { failed.append(item.title); continue }
            book.title = item.title; book.author = item.author
            let publication = try await store.open(book)
            book.locator = try locator(item.position, book: book, publication: publication)
            book.progress = item.position.progress
            book.bookmarks = try item.bookmarks.map { ReadingBookmark(title: $0.title, locator: try locator($0.position, book: book, publication: publication)) }
            try await store.repository.update(book); added += 1
        }
        await store.refresh()
        message = "已导入 \(added) 本，保留 \(duplicates) 本已有书籍。" + (failed.isEmpty ? "" : "未导入：" + failed.joined(separator: "、"))
    }
}
