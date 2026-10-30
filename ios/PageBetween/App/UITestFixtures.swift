#if DEBUG
import SwiftUI
import PDFKit

enum UITestFixtures {
    @MainActor static func prepare(_ store: LibraryStore) async {
        let environment = ProcessInfo.processInfo.environment
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
