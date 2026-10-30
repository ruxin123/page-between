#if DEBUG
import SwiftUI
import PDFKit

enum UITestFixtures {
    @MainActor static func prepare(_ store: LibraryStore) async {
        let environment = ProcessInfo.processInfo.environment
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
}
#endif
