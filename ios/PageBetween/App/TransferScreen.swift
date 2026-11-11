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
    @State private var sharing = false
    @State private var message = ""
    @State private var exported: URL?
    @State private var folder = FileManager.default.temporaryDirectory.appendingPathComponent("transfer-" + UUID().uuidString)
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button("导出迁移包") { perform { exported = nil; exported = try await exportBooks(); message = "" } }.disabled(busy || store.importing)
                    if exported != nil { Button("发送或存储迁移包") { sharing = true } }
                    Button("导入迁移包") { choosing = true }.disabled(busy || store.importing)
                } footer: { Text("合并书籍和阅读记录，保留已有进度与排版。服务密钥不会迁移。") }
                if busy { ProgressView() }
                if !message.isEmpty { Text(message) }
            }.navigationTitle("设备迁移").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("完成") { dismiss() }.disabled(busy) }
                .fileImporter(isPresented: $choosing, allowedContentTypes: [UTType("local.pagebetween.transfer") ?? .item]) { result in
                    switch result { case .success(let url): perform { try await importBooks(url) }; case .failure(let error): message = error.localizedDescription }
                }
                .task { if let incoming { perform { try await importBooks(incoming) } } }
                .sheet(isPresented: $sharing) { if let exported { TransferShare(url: exported, presented: $sharing) } }
                .onDisappear { if !sharing { try? FileManager.default.removeItem(at: folder) } }
        }.tint(MobilePalette.accent).interactiveDismissDisabled(busy)
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true; message = ""
        Task { @MainActor in defer { busy = false }; do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true); try await action() } catch { message = error.localizedDescription } }
    }
    private func exportBooks() async throws -> URL {
        let target = folder.appendingPathComponent("页间迁移.pbtransfer")
        try? FileManager.default.removeItem(at: target)
        let archive = try await Archive(url: target, accessMode: .create)
        let writer = TransferWriter(archive: archive, folder: folder)
        var books: [TransferBook] = []
        let selected = await store.repository.books()
        for (offset, book) in selected.enumerated() {
            message = "正在导出 \(offset + 1) / \(selected.count) 本"
            let source = try await store.repository.file(book, name: book.originalName)
            let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= 200 * 1024 * 1024 else { throw ServiceError.message("单书超过 200 MB 或文件为空。") }
            let publication = try await store.open(book)
            let locations = try await TransferLocations.load(book, publication: publication, original: source)
            let name = "books/" + book.sourceHash + "." + book.format
            try await writer.add(source, as: name, size: size)
            let marks = book.bookmarks.map { item in
                var mark = TransferBookmark(title: item.title, position: locations.portable(item.locator))
                mark.id = TransferRecords.id(item.id); mark.createdAt = item.createdAt.timeIntervalSince1970
                return mark
            }
            var item = TransferBook(title: book.title, author: book.author, file: name, sha256: book.sourceHash, position: locations.portable(book.locator, stored: book.transferredPosition), bookmarks: marks)
            let records = try await locations.export(store.repository, original: source, writer: writer)
            item.records = try await writer.add(JSONEncoder().encode(records), prefix: "records", suffix: "json")
            books.append(item)
        }
        var manifest = TransferManifest(books: books); manifest.images = writer.images.values.sorted { $0.file < $1.file }; try manifest.validate()
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
        var added = 0, duplicates = 0, merged = 0, failed: [String] = []
        for (offset, item) in manifest.books.enumerated() {
            message = "正在导入 \(offset + 1) / \(manifest.books.count) 本"
            let existing = await store.repository.books(includingDeleted: true).first(where: { $0.sourceHash == item.sha256 })
            if existing != nil { duplicates += 1; if manifest.schema == 1 { continue } }
            do {
                var book: MobileBook
                if let existing { book = existing }
                else {
                    let source = staging.appendingPathComponent(URL(fileURLWithPath: item.file).lastPathComponent)
                    store.error = nil
                    let namedFolder = staging.appendingPathComponent(UUID().uuidString)
                    try FileManager.default.createDirectory(at: namedFolder, withIntermediateDirectories: true)
                    let title = item.title.unicodeScalars.prefix(40).map { String($0) }.joined().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: "\0", with: "_")
                    let named = namedFolder.appendingPathComponent((title.isEmpty ? "书籍" : title) + "." + source.pathExtension)
                    try FileManager.default.copyItem(at: source, to: named)
                    await store.importFiles([named])
                    guard let imported = await store.repository.books().first(where: { $0.sourceHash == item.sha256 }) else { failed.append(item.title); continue }
                    book = imported
                }
                let publication = try await store.open(book), original = try await store.repository.file(book, name: book.originalName)
                let locations = try await TransferLocations.load(book, publication: publication, original: original)
                let incoming = try locations.imported(item, staging: staging, isNew: existing == nil)
                if existing == nil {
                    if !item.title.isEmpty { book.title = item.title }
                    if !item.author.isEmpty { book.author = item.author }
                    book.locator = try locations.locator(item.position); book.progress = item.position.progress
                    try await store.repository.update(book); added += 1
                }
                merged += try await store.repository.mergeReadingRecords(book.id, incoming: incoming)
            } catch { failed.append(item.title + "：" + error.localizedDescription) }
        }
        await store.refresh()
        message = "已导入 \(added) 本，保留 \(duplicates) 本已有书籍。" + (merged > 0 ? "合并 \(merged) 条阅读记录。" : "") + (failed.isEmpty ? "" : "\n未完成：" + failed.joined(separator: "、"))
    }
}

private struct TransferShare: UIViewControllerRepresentable {
    let url: URL
    @Binding var presented: Bool
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in Task { @MainActor in presented = false } }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
