import Foundation
import PDFKit
import CoreText
import ImageIO

@main struct PDFOCRFixture {
    static func verify(_ condition: Bool, _ message: String) { if !condition { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) } }
    static func main() async throws {
        let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let original = folder.appendingPathComponent("original-scan.pdf")
        let manager = FileManager.default
        let root = folder.appendingPathComponent("Library-" + UUID().uuidString)
        defer { try? manager.removeItem(at: root) }
        var bounds = CGRect(x: 0, y: 0, width: 600, height: 800)
        let bitmap = CGContext(data: nil, width: 1200, height: 1600, bitsPerComponent: 8, bytesPerRow: 4800, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        bitmap.setFillColor(CGColor(gray: 1, alpha: 1)); bitmap.fill(CGRect(x: 0, y: 0, width: 1200, height: 1600))
        for (index, text) in ["Original mathematics paragraph.", "A function maps a set to another set."].enumerated() {
            let font = CTFontCreateWithName("TimesNewRomanPSMT" as CFString, 42, nil)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
            bitmap.textPosition = CGPoint(x: 100, y: 1400 - index * 100); CTLineDraw(line, bitmap)
        }
        let png = CGImageDestinationCreateWithURL(folder.appendingPathComponent("source.png") as CFURL, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(png, bitmap.makeImage()!, nil); CGImageDestinationFinalize(png)
        let data = NSMutableData(), consumer = CGDataConsumer(data: data as CFMutableData)!
        let context = CGContext(consumer: consumer, mediaBox: &bounds, nil)!
        context.beginPDFPage(nil); context.draw(bitmap.makeImage()!, in: bounds); context.endPDFPage(); context.closePDF()
        try (data as Data).write(to: original)
        verify(PDFDocument(url: original)?.page(at: 0)?.numberOfCharacters == 0, "Fixture must contain only a scanned image")
        let repo = try LibraryRepository(root: root)
        let book = try await repo.importFile(original)
        let worker = PDFTextPreparation(repository: repo)
        let prepared = try await worker.prepare(book, page: 1)
        verify(prepared.ocrCompleted && !prepared.hasNativeText && prepared.text.contains("Original"), "OCR did not recognize original text")
        let selectionPDF = try await repo.file(book, name: "selection/page-1.pdf")
        let recognized = PDFDocument(url: selectionPDF)!.page(at: 0)!
        let text = recognized.string! as NSString
        let range = text.range(of: "mathematics")
        verify(range.location != NSNotFound, "Searchable PDF omitted OCR text")
        let selected = recognized.selection(for: range)!.bounds(for: recognized)
        FileHandle.standardError.write(Data("Selected geometry: \(selected); OCR: \(prepared.words.filter { $0.text.contains("mathematics") })\n".utf8))
        verify(selected.minX > 20 && selected.maxX < 580 && selected.minY > 600 && selected.maxY < 760, "OCR selection geometry is outside the printed line")
        let sourcePage = CGPDFDocument(original as CFURL)!.page(at: 1)!
        let outputPage = CGPDFDocument(selectionPDF as CFURL)!.page(at: 1)!
        let before = try PDFTextPreparation.render(sourcePage, size: bounds.size, maximum: 1200)
        let after = try PDFTextPreparation.render(outputPage, size: bounds.size, maximum: 1200)
        let beforeData = before.dataProvider!.data!, afterData = after.dataProvider!.data!
        let a = CFDataGetBytePtr(beforeData)!, b = CFDataGetBytePtr(afterData)!
        var maximumDifference = 0
        withExtendedLifetime((beforeData, afterData)) {
            for pixel in 0..<(before.width * before.height) { for channel in 0..<3 { maximumDifference = max(maximumDifference, abs(Int(a[pixel * 4 + channel]) - Int(b[pixel * 4 + channel]))) } }
        }
        verify(maximumDifference <= 1, "Invisible OCR modified original page appearance")
        let modified = try selectionPDF.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        _ = try await worker.prepare(book, page: 1)
        let reusedDate = try selectionPDF.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        verify(reusedDate == modified, "Prepared page was unnecessarily regenerated")
        print("Production OCR passed: scanned image → persistent words → searchable PDF; selection geometry, identical page pixels, and cache reuse verified.")
    }
}
