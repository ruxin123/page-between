import SwiftUI
import ReadiumShared
import ReadiumStreamer
import ReadiumZIPFoundation

@MainActor final class LibraryStore: ObservableObject {
    @Published var books: [MobileBook] = []
    @Published var error: String?
    @Published var importing = false
    let repository: LibraryRepository
    private let retriever: AssetRetriever
    private let opener: PublicationOpener
    private var pendingImports: [URL] = []

    init() throws {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("PageBetween", isDirectory: true)
        repository = try LibraryRepository(root: root)
        let http = DefaultHTTPClient()
        retriever = AssetRetriever(httpClient: http)
        opener = PublicationOpener(parser: DefaultPublicationParser(httpClient: http, assetRetriever: retriever, pdfFactory: DefaultPDFDocumentFactory()))
    }

    func refresh() async { books = await repository.books(includingDeleted: true) }

    func open(_ book: MobileBook) async throws -> Publication {
        let url = try await repository.file(book)
        let asset = try await retriever.retrieve(url: url.anyURL.absoluteURL!).get()
        return try await opener.open(asset: asset, allowUserInteraction: false).get()
    }

    func importFiles(_ urls: [URL]) async {
        pendingImports.append(contentsOf: urls)
        guard !importing else { return }
        importing = true
        defer { importing = false }
        while !pendingImports.isEmpty {
            let url = pendingImports.removeFirst()
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let previousIDs = Set(await repository.books(includingDeleted: true).map(\.id))
            var newImport: UUID?
            do {
                if ["epub", "cbz"].contains(url.pathExtension.lowercased()) { try await Self.checkArchive(url) }
                var book = try await repository.importFile(url)
                if !previousIDs.contains(book.id) { newImport = book.id }
                if book.format == "txt", book.readingFile == book.originalName {
                    let original = try await repository.file(book, name: book.originalName)
                    let destination = try await repository.file(book, name: "reading.epub")
                    let title = book.title
                    try await Task.detached(priority: .userInitiated) { try await TextEPUB.create(original: original, title: title, destination: destination) }.value
                    book.readingFile = "reading.epub"
                }
                let publication = try await open(book)
                book.title = publication.metadata.title ?? book.title
                book.author = publication.metadata.authors.map(\.name).joined(separator: "、")
                let cover = try await repository.file(book, name: "cover.jpg")
                if !FileManager.default.fileExists(atPath: cover.path), case .success(let image) = await publication.coverFitting(maxSize: CGSize(width: 480, height: 680)), let data = image?.jpegData(compressionQuality: 0.82) {
                    try? data.write(to: cover, options: .atomic)
                }
                try await repository.update(book)
            } catch {
                let failure = error.localizedDescription
                if let newImport { try? await repository.discardFailedImport(newImport) }
                self.error = url.lastPathComponent + "：" + failure
            }
        }
        await refresh()
    }

    func coverURL(_ book: MobileBook) -> URL { repository.root.appendingPathComponent("books/" + book.id.uuidString + "/cover.jpg") }

    private static func checkArchive(_ url: URL) async throws {
        let archive = try await Archive(url: url, accessMode: .read)
        var total: UInt64 = 0, count = 0
        for entry in try await archive.entries() {
            total += UInt64(entry.uncompressedSize); count += 1
            guard count <= 15000, total <= 600 * 1024 * 1024, entry.uncompressedSize <= 64 * 1024 * 1024,
                  !entry.path.hasPrefix("/"), !entry.path.contains("\\"), !entry.path.split(separator: "/").contains(".."), entry.type != .symlink else { throw LibraryFailure.invalidFile }
        }
    }

    func save(_ book: MobileBook) async {
        do { try await repository.update(book); await refresh() }
        catch { self.error = error.localizedDescription }
    }

    func remove(_ book: MobileBook, deleted: Bool) async {
        do { try await repository.markDeleted(book.id, deleted: deleted); await refresh() }
        catch { self.error = error.localizedDescription }
    }
}
