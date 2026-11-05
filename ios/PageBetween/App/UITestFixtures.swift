#if DEBUG
import SwiftUI
import PDFKit
import ReadiumZIPFoundation

enum UITestFixtures {
    @MainActor static func prepare(_ store: LibraryStore) async {
        let environment = ProcessInfo.processInfo.environment
        if environment["PAGE_BETWEEN_TRANSFER_UI_TEST"] == "1" {
            do {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("transfer-fixture-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let original = folder.appendingPathComponent("original.txt")
                try Data(("第一章 Transfer start\n\nOriginal transferred paragraph.\n第二章 Transfer continue\n\nOriginal transferred second paragraph.\n" + UUID().uuidString).utf8).write(to: original)
                let hash = try TransferManifest.hash(original), path = "books/" + hash + ".txt"
                let mark = TransferBookmark(title: "Transfer bookmark", position: TransferPosition(index: 1))
                let book = TransferBook(title: "Original transfer sample " + String(repeating: "长标题", count: 35), author: "Original Author", file: path, sha256: hash, position: TransferPosition(index: 2, progress: 0.4, chapterFraction: 0.3), bookmarks: [mark])
                let meta = folder.appendingPathComponent("manifest.json")
                try JSONEncoder().encode(TransferManifest(books: [book])).write(to: meta)
                let file = folder.appendingPathComponent("original.pbtransfer")
                let archive = try await Archive(url: file, accessMode: .create)
                try await archive.addEntry(with: "manifest.json", fileURL: meta)
                try await archive.addEntry(with: path, fileURL: original)
                store.incomingTransfer = file
            } catch { store.error = error.localizedDescription }
        }
        if environment["PAGE_BETWEEN_IMPORT_UI_TEST"] == "1" {
            do {
                let folder = FileManager.default.temporaryDirectory
                let text = folder.appendingPathComponent("Import options sample.txt"), fb2 = folder.appendingPathComponent("Original FB2 sample.fb2")
                try Data(("第一章 开篇\n\nOriginal unparsed text.\n第二章 继续\n\nAnother original paragraph.\n" + UUID().uuidString).utf8).write(to: text)
                let svg = ##"<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#537d68"/></svg>"##
                let image = Data(svg.utf8).base64EncodedString()
                let xml = ##"<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Original FB2 sample</book-title><lang>en</lang></title-info></description><body><section id="first"><title><p>第一章 FB2 开篇</p></title><p>Original illustrated FB2 paragraph.</p><image l:href="#picture"/><p><a l:href="#second">Next chapter link</a></p><section><title><p>Nested FB2 section</p></title><p>Nested original content.</p></section></section><section id="second"><title><p>Second FB2 chapter</p></title><p>Second original FB2 paragraph.</p></section></body><binary id="picture" content-type="image/svg+xml">"## + image + "</binary></FictionBook>"
                try Data(xml.utf8).write(to: fb2)
                store.reviewImport([text, fb2])
            } catch { store.error = error.localizedDescription }
        }
        if environment["PAGE_BETWEEN_PDF_OBJECT_UI_TEST"] == "1" { await objects(store) }
        if environment["PAGE_BETWEEN_UI_TEST"] == "1" {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("Mobile reading sample.txt")
            let text = "第一章 开始\n\n" + String(repeating: "First original paragraph for mobile reading.\n\n", count: 30) + "第二章 继续\n\nSecond original paragraph for chapter navigation.\n\nEnd of the original sample."
            do { try Data(text.utf8).write(to: file); await store.importFiles([file]); try? FileManager.default.removeItem(at: file) }
            catch { store.error = error.localizedDescription }
        }
        if environment["PAGE_BETWEEN_PDF_UI_TEST"] == "1" {
            if let existing = await store.repository.books(includingDeleted: true).first(where: { $0.title == "Original scan sample" && $0.format == "pdf" }) { await store.remove(existing, deleted: false); return }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("Original scan sample.pdf")
            let bounds = CGRect(x: 0, y: 0, width: 600, height: 800)
            let format = UIGraphicsPDFRendererFormat()
            format.documentInfo = [kCGPDFContextTitle as String: "Original scan sample"]
            let bytes = UIGraphicsPDFRenderer(bounds: bounds, format: format).pdfData { context in
                for index in 1...2 {
                    context.beginPage()
                    let image = UIGraphicsImageRenderer(size: bounds.size).image { image in
                        UIColor.white.setFill(); image.fill(bounds)
                        let first = index == 1 ? "Original scanned page one." : "Second original scanned page."
                        let second = index == 1 ? "Original mathematics paragraph." : "Read page two and return safely."
                        for (line, text) in [first, second].enumerated() {
                            (text as NSString).draw(at: CGPoint(x: 50, y: 80 + line * 70), withAttributes: [.font: UIFont(name: "TimesNewRomanPSMT", size: 24)!, .foregroundColor: UIColor.black])
                        }
                    }
                    image.draw(in: bounds)
                }
            }
            do { try bytes.write(to: file); await store.importFiles([file]); try? FileManager.default.removeItem(at: file) }
            catch { store.error = error.localizedDescription }
        }
    }
    @MainActor private static func objects(_ store: LibraryStore) async {
        do {
            var book = await store.repository.books(includingDeleted: true).first(where: { $0.title == "Original object sample" && $0.format == "pdf" })
            if let existing = book { await store.remove(existing, deleted: false) }
            else {
                let file = FileManager.default.temporaryDirectory.appendingPathComponent("Original object sample.pdf")
                let bounds = CGRect(x: 0, y: 0, width: 600, height: 800)
                let data = UIGraphicsPDFRenderer(bounds: bounds).pdfData { context in
                    context.beginPage()
                    func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat) { (value as NSString).draw(at: CGPoint(x: x, y: y), withAttributes: [.font: UIFont(name: "TimesNewRomanPSMT", size: size)!, .foregroundColor: UIColor.black]) }
                    text("Original object sample", 40, 30, 24)
                    text("An original function maps A to B.", 40, 85, 20)
                    text("g(x) = x2", 100, 170, 32)
                    text("a + b", 100, 260, 32)
                    text("x                f(x)", 100, 360, 24); text("1                   1", 100, 405, 24)
                    context.cgContext.setStrokeColor(UIColor.black.cgColor)
                    context.cgContext.stroke(CGRect(x: 85, y: 345, width: 430, height: 105))
                    text("Original diagram", 100, 490, 18)
                    context.cgContext.stroke(CGRect(x: 100, y: 530, width: 390, height: 160))
                    context.cgContext.move(to: CGPoint(x: 140, y: 655)); context.cgContext.addLine(to: CGPoint(x: 280, y: 550)); context.cgContext.addLine(to: CGPoint(x: 440, y: 655)); context.cgContext.closePath(); context.cgContext.strokePath()
                }
                try data.write(to: file); await store.importFiles([file]); try? FileManager.default.removeItem(at: file)
                book = await store.repository.books().first(where: { $0.title == "Original object sample" && $0.format == "pdf" })
            }
            guard let book else { throw LibraryFailure.missingBook }
            var page = PDFPreparedPage(page: 1, sourceHash: book.sourceHash, width: 600, height: 800)
            page.mineruCompleted = true
            page.blocks = [
                PDFContentBlock(id: "p1-text", type: "text", text: "An original function maps $A$ to $B$.", box: PDFBox(0.05,0.1,0.9,0.15), order: 0),
                PDFContentBlock(id: "p1-equation", type: "equation", text: "g(x)=x^2", box: PDFBox(0.14,0.205,0.8,0.26), order: 1),
                PDFContentBlock(id: "p1-damaged", type: "equation", text: #"\overline{a"#, box: PDFBox(0.14,0.32,0.8,0.375), order: 2),
                PDFContentBlock(id: "p1-table", type: "table", text: "<table><tr><th>x</th><th>f(x)</th></tr><tr><td>1</td><td>1</td></tr></table>", box: PDFBox(0.13,0.425,0.87,0.57), order: 3),
                PDFContentBlock(id: "p1-image", type: "image", text: "", box: PDFBox(0.16,0.65,0.83,0.875), order: 4)
            ]
            try await store.repository.savePDFPage(book.id, page: page)
            await store.refresh()
        } catch { store.error = error.localizedDescription }
    }
}
#endif
