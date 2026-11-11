import Foundation
import CryptoKit
import ReadiumShared
import ReadiumZIPFoundation
import UIKit

struct TransferLocations {
    let book: MobileBook
    let publication: Publication
    let text: [TextChapter]
    static func load(_ book: MobileBook, publication: Publication, original: URL) async throws -> Self {
        let text = book.format == "txt" ? try await Task.detached {
            try TextChapters.parse(TextChapters.decode(Data(contentsOf: original)), detectHeadings: book.shouldPrepare)
        }.value : []
        return Self(book: book, publication: publication, text: text)
    }
    func portable(_ raw: String?, quote: String? = nil, rects: [PDFSelectionRect] = [], stored: TransferPosition? = nil) -> TransferPosition {
        if let stored { return stored }
        guard let raw, let locator = try? Locator(jsonString: raw) else { return TransferPosition() }
        let href = locator.href.description
        let index = book.format == "pdf" ? locator.locations.position ?? 1 : (publication.readingOrder.firstIndex(where: { $0.href == href }) ?? 0) + 1
        let y = locator.locations.fragments.first(where: { $0.hasPrefix("y=") }).flatMap { Double($0.dropFirst(2)) } ?? 0
        let fraction = min(1, max(0, locator.locations.progression ?? 0))
        var result = TransferPosition(index: index, progress: min(1, max(0, locator.locations.totalProgression ?? book.progress)), chapterFraction: fraction, pdfY: min(1, max(0, y)))
        result.readium = raw
        if book.format == "epub" { result.href = href }
        if book.format == "pdf", let end = rects.map(\.page).max(), end > index { result.endIndex = end }
        if text.indices.contains(index - 1) {
            let chapter = text[index - 1], body = chapter.body as NSString
            var offset = Int(fraction * Double(body.length))
            if let quote, !quote.isEmpty {
                let first = body.range(of: quote)
                if first.location != NSNotFound, body.range(of: quote, options: .backwards).location == first.location { offset = first.location }
            }
            result.sourceOffset = chapter.sourceOffset + offset
        }
        return result
    }
    func locator(_ position: TransferPosition) throws -> String {
        if let raw = position.readium, let locator = try? Locator(jsonString: raw),
           (book.format == "pdf" && locator.locations.position == position.index) || (book.format == "epub" && publication.readingOrder.contains(where: { $0.href == locator.href.description })) { return raw }
        var index = min(max(0, position.index - 1), max(0, publication.readingOrder.count - 1))
        var fraction = position.chapterFraction
        if let offset = position.sourceOffset, let match = text.lastIndex(where: { $0.sourceOffset <= offset }), publication.readingOrder.indices.contains(match) {
            index = match
            fraction = min(1, max(0, Double(offset - text[match].sourceOffset) / Double(max(1, text[match].body.utf16.count))))
        }
        if book.format == "epub", let href = position.href,
           let match = publication.readingOrder.firstIndex(where: { ($0.href.removingPercentEncoding ?? $0.href) == (href.removingPercentEncoding ?? href) }) { index = match }
        let href = publication.readingOrder.indices.contains(index) ? publication.readingOrder[index].href : "original.pdf"
        var locations: [String: Any] = book.format == "pdf" ? ["position":position.index, "fragments":["page=\(position.index)", "y=\(position.pdfY)"], "totalProgression":position.progress] : ["progression":fraction, "totalProgression":position.progress]
        if book.format == "epub", let raw = position.nativeMac, let data = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any], let fragment = data["fragment"] as? String, !fragment.isEmpty { locations["fragments"] = [fragment] }
        let mediaType = publication.readingOrder.indices.contains(index) ? publication.readingOrder[index].mediaType?.string : nil
        let value: [String: Any] = ["href":href, "type":mediaType ?? (book.format == "pdf" ? "application/pdf" : "application/xhtml+xml"), "locations":locations]
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: .sortedKeys), as: UTF8.self)
    }
}

@MainActor final class TransferWriter {
    let archive: Archive
    let folder: URL
    var bytes = 0
    var images: [String: TransferFile] = [:]
    private var files: Set<String> = []
    private var recordBytes = 0
    init(archive: Archive, folder: URL) { self.archive = archive; self.folder = folder }
    func add(_ source: URL, as name: String, size: Int) async throws {
        guard !files.contains(name) else { return }
        bytes += size
        guard size > 0, bytes <= 1024 * 1024 * 1024 else { throw ServiceError.message("迁移包合计超过 1 GB。") }
        try await archive.addEntry(with: name, fileURL: source, compressionMethod: .deflate)
        files.insert(name)
    }
    func add(_ body: Data, prefix: String, suffix: String) async throws -> TransferFile {
        let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let name = prefix + "/" + hash + "." + suffix
        let item = TransferFile(file: name, sha256: hash, size: body.count)
        try item.validate(image: prefix == "images")
        if !files.contains(name) {
            if prefix == "records" {
                recordBytes += body.count
                guard recordBytes <= TransferManifest.maxRecordBytes else { throw ServiceError.message("阅读记录超过 64 MB。") }
            }
            let file = folder.appendingPathComponent(hash + "." + suffix)
            try body.write(to: file, options: .atomic); defer { try? FileManager.default.removeItem(at: file) }
            try await add(file, as: name, size: body.count)
        }
        if prefix == "images" { images[name] = item }
        return item
    }
    func source(_ value: TransferSource, attachments: [SourceAttachment], original: URL, repository: LibraryRepository, book: MobileBook) async throws -> TransferSource {
        var result = value
        for item in attachments {
            let data = try await repository.attachment(book, item: item)
            let file = try await add(data, prefix: "images", suffix: URL(fileURLWithPath: item.file).pathExtension)
            result.images.append(TransferImage(file: file.file, raw: item.raw))
        }
        if attachments.isEmpty, !value.objects.isEmpty, book.format == "pdf" {
            for object in value.objects {
                let png = try await Task.detached { try PDFSourceContent.image(object, original: original) }.value
                let body: Data, suffix: String
                if png.count <= 4 * 1024 * 1024 { body = png; suffix = "png" }
                else if let jpg = UIImage(data: png)?.jpegData(compressionQuality: 0.88) { body = jpg; suffix = "jpg" }
                else { throw LibraryFailure.invalidFile }
                let file = try await add(body, prefix: "images", suffix: suffix)
                result.images.append(TransferImage(file: file.file, raw: object.text))
            }
        }
        return result
    }
}

extension TransferLocations {
    func imported(_ item: TransferBook, staging: URL, isNew: Bool) throws -> ImportedReadingRecords {
        var result = ImportedReadingRecords()
        if isNew { result.position = item.position }
        for mark in item.bookmarks {
            let raw = try locator(mark.position)
            if mark.id == nil, book.bookmarks.contains(where: { $0.title == mark.title && (try? Locator(jsonString: $0.locator)) == (try? Locator(jsonString: raw)) }) { continue }
            var bookmark = ReadingBookmark(title: mark.title, locator: raw)
            if let id = mark.id { bookmark.id = try TransferRecords.uuid(id) }
            if let time = mark.createdAt { bookmark.createdAt = Date(timeIntervalSince1970: time) }
            result.bookmarks.append(bookmark)
        }
        guard let data = item.recordsData else { return result }
        func attachments(_ source: TransferSource) -> [SourceAttachment] {
            source.images.map { image in
                let name = URL(fileURLWithPath: image.file).lastPathComponent, path = "attachments/" + name
                result.attachments[path] = staging.appendingPathComponent(image.file)
                return SourceAttachment(file: path, raw: image.raw)
            }
        }
        func excerpt(_ source: TransferSource, id: String, createdAt: Double) throws -> SavedExcerpt {
            var value = SavedExcerpt(quote: source.quote, markdown: source.markdown, locator: try locator(source.position), chapter: source.chapter, objects: source.objects, rects: source.rects)
            value.id = try TransferRecords.uuid(id); value.createdAt = Date(timeIntervalSince1970: createdAt)
            value.attachments = attachments(source); value.transferredPosition = source.position
            value.sourceContext = source.context; value.sourceContextBefore = source.contextBefore
            return value
        }
        for item in data.excerpts {
            var value = try excerpt(item.source, id: item.id, createdAt: item.createdAt)
            value.note = item.note; value.answer = item.answer; value.translation = item.translation
            value.deletedAt = item.deletedAt.map(Date.init(timeIntervalSince1970:))
            result.excerpts.append(value)
        }
        for item in data.translations {
            var value = try excerpt(item.source, id: item.id, createdAt: item.createdAt)
            var details = TranslationDetails()
            details.provider = item.provider; details.model = item.model; details.explanation = item.explanation
            details.sourceLanguage = item.sourceLanguage; details.targetLanguage = item.targetLanguage; details.detectedLanguage = item.detectedLanguage
            details.originalText = item.text
            value.translation = item.translation; value.translationDetails = details
            result.excerpts.append(value)
        }
        for item in data.conversations {
            var value = MobileConversation(book: book.id, quote: item.source.quote, locator: try locator(item.source.position))
            value.id = try TransferRecords.uuid(item.id); value.createdAt = Date(timeIntervalSince1970: item.createdAt); value.updatedAt = Date(timeIntervalSince1970: item.updatedAt)
            value.previewQuote = item.source.markdown; value.sourceObjects = item.source.objects; value.sourceRects = item.source.rects
            value.sourceAttachments = attachments(item.source); value.transferredPosition = item.source.position
            value.sourceContext = item.source.context; value.sourceContextBefore = item.source.contextBefore
            value.turns = try item.messages.map { message in
                var turn = MobileTurn(role: message.role, content: message.content)
                turn.id = try TransferRecords.uuid(message.id); turn.status = message.status == "generating" ? "stopped" : message.status; turn.imageAttached = message.imageAttached
                turn.error = message.error; turn.nearbyText = message.nearbyText; turn.citationWarning = message.citationWarning
                turn.references = try message.references?.map { MobileCitation(number: $0.number, citation: $0.citation, text: $0.text, locator: try locator($0.position), transferredPosition: $0.position) }
                return turn
            }
            result.conversations.append(value)
        }
        if let p = data.appearance {
            let font = ["", "Songti SC", "PingFang SC", "Georgia"].contains(p.fontFamily) ? p.fontFamily : ""
            result.appearance = ReadingAppearance(fontScale: max(70, p.fontScale), lineHeight: min(2.2, p.lineHeight), pageMargins: p.pageMargins, fontFamily: font, theme: ["paper", "night", "sepia"].contains(p.theme) ? p.theme : "paper", scroll: p.scroll)
            result.portableAppearance = p
        }
        return result
    }
    @MainActor func export(_ repository: LibraryRepository, original: URL, writer: TransferWriter) async throws -> TransferRecords {
        var data = TransferRecords()
        func source(quote: String, markdown: String?, locator: String, chapter: String, objects: [PDFSourceObject], rects: [PDFSelectionRect], stored: TransferPosition?) -> TransferSource {
            let kind = quote.isEmpty ? "image" : objects.count == 1 && objects[0].text == quote ? objects[0].type : "text"
            return TransferSource(quote: quote, markdown: markdown, position: portable(locator, quote: quote, rects: rects, stored: stored), kind: kind, chapter: chapter, objects: objects, rects: rects)
        }
        for item in book.excerpts ?? [] {
            if item.translationDetails != nil, item.deletedAt != nil { continue }
            var origin = source(quote: item.quote, markdown: item.markdown, locator: item.locator, chapter: item.chapter, objects: item.objects, rects: item.rects ?? [], stored: item.transferredPosition)
            origin.context = item.sourceContext; origin.contextBefore = item.sourceContextBefore
            let portable = try await writer.source(origin, attachments: item.attachments ?? [], original: original, repository: repository, book: book)
            if let details = item.translationDetails, let translation = item.translation {
                if item.deletedAt == nil { data.translations.append(TransferTranslation(id: TransferRecords.id(item.id), source: portable, text: details.originalText ?? item.quote, translation: translation, explanation: details.explanation, provider: details.provider, model: details.model, sourceLanguage: details.sourceLanguage, targetLanguage: details.targetLanguage, detectedLanguage: details.detectedLanguage, createdAt: item.createdAt.timeIntervalSince1970)) }
            } else {
                data.excerpts.append(TransferExcerpt(id: TransferRecords.id(item.id), source: portable, note: item.note, answer: item.answer, translation: item.translation, createdAt: item.createdAt.timeIntervalSince1970, deletedAt: item.deletedAt?.timeIntervalSince1970))
            }
        }
        var offset = 0
        while true {
            let group = try await repository.conversations(book.id, offset: offset)
            for item in group {
                var origin = source(quote: item.quote, markdown: item.previewQuote, locator: item.locator, chapter: book.chapter, objects: item.sourceObjects ?? [], rects: item.sourceRects ?? [], stored: item.transferredPosition)
                origin.context = item.sourceContext; origin.contextBefore = item.sourceContextBefore
                let portable = try await writer.source(origin, attachments: item.sourceAttachments ?? [], original: original, repository: repository, book: book)
                let turns = item.turns.map { turn in
                    TransferTurn(id: TransferRecords.id(turn.id), role: turn.role, content: turn.content, status: turn.status, imageAttached: turn.imageAttached, error: turn.error, nearbyText: turn.nearbyText, citationWarning: turn.citationWarning, references: turn.references?.map { TransferReference(number: $0.number, citation: $0.citation, text: $0.text, position: self.portable($0.locator, quote: $0.text, stored: $0.transferredPosition)) })
                }
                data.conversations.append(TransferConversation(id: TransferRecords.id(item.id), source: portable, messages: turns, createdAt: item.createdAt.timeIntervalSince1970, updatedAt: item.updatedAt.timeIntervalSince1970))
            }
            offset += group.count
            if group.count < 30 { break }
            guard offset <= 10000 else { throw LibraryFailure.tooLarge }
        }
        data.appearance = book.transferredAppearance ?? book.appearance.map { TransferAppearance(fontScale: $0.fontScale, lineHeight: $0.lineHeight, pageMargins: $0.pageMargins, fontFamily: $0.fontFamily, theme: $0.theme, scroll: $0.scroll) }
        try data.validate()
        return data
    }
}
