import Foundation
import PDFKit
import Vision
import CoreText

actor PDFTextPreparation {
    let repository: LibraryRepository
    init(repository: LibraryRepository) { self.repository = repository }

    func prepare(_ book: MobileBook, page number: Int, fresh: Bool = false) async throws -> PDFPreparedPage {
        try Task.checkCancellation()
        if !fresh, let cached = try await repository.pdfPage(book.id, page: number), cached.ocrCompleted {
            let file = try await repository.file(book, name: "selection/page-\(number).pdf")
            if cached.hasNativeText || cached.words.isEmpty || FileManager.default.fileExists(atPath: file.path) { return cached }
        }
        let original = try await repository.file(book, name: book.originalName)
        guard let source = CGPDFDocument(original as CFURL), number >= 1, number <= source.numberOfPages, let page = source.page(at: number) else { throw LibraryFailure.invalidFile }
        let crop = page.getBoxRect(.cropBox)
        let rotated = page.rotationAngle % 180 != 0
        let size = CGSize(width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height)
        var result = PDFPreparedPage(page: number, sourceHash: book.sourceHash, width: size.width, height: size.height)
        try result.validate()
        if let document = PDFDocument(url: original), let native = document.page(at: number - 1), let text = native.string, text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 4 {
            result.hasNativeText = true
            let transform = page.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true)
            for (line, selection) in (native.selection(for: NSRange(location: 0, length: native.numberOfCharacters))?.selectionsByLine() ?? []).enumerated() {
                guard let text = selection.string, !text.isEmpty else { continue }
                let rectangle = selection.bounds(for: native).applying(transform)
                if let box = Self.box(rectangle, size: size, bottomOrigin: true) { result.words.append(PDFWord(text: text, box: box, confidence: 1, line: line)) }
            }
        } else {
            let image = try Self.render(page, size: size, maximum: 2400)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US", "zh-Hans"]
            request.automaticallyDetectsLanguage = true
            request.usesLanguageCorrection = false
            request.minimumTextHeight = 0.003
            try VNImageRequestHandler(cgImage: image).perform([request])
            let observations = (request.results ?? []).sorted {
                if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.008 { return $0.boundingBox.midY > $1.boundingBox.midY }
                return $0.boundingBox.minX < $1.boundingBox.minX
            }
            for (line, observation) in observations.enumerated() {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let text = candidate.string
                let expression = try NSRegularExpression(pattern: #"\S+"#)
                let tokens = expression.matches(in: text, range: NSRange(text.startIndex..., in: text))
                var words: [PDFWord] = []
                for token in tokens {
                    guard let range = Range(token.range, in: text), let rectangle = try candidate.boundingBox(for: range)?.boundingBox,
                          let box = Self.box(rectangle, size: CGSize(width: 1, height: 1), bottomOrigin: true) else { words = []; break }
                    words.append(PDFWord(text: String(text[range]), box: box, confidence: Double(candidate.confidence), line: line))
                }
                if words.isEmpty, let box = Self.box(observation.boundingBox, size: CGSize(width: 1, height: 1), bottomOrigin: true) { words = [PDFWord(text: text, box: box, confidence: Double(candidate.confidence), line: line)] }
                result.words += words
            }
            if !result.words.isEmpty {
                let output = try await repository.file(book, name: "selection/page-\(number).pdf")
                try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Self.searchablePage(page, size: size, words: result.words).write(to: output, options: .atomic)
            }
        }
        result.ocrCompleted = true
        result.ocrRevision = UUID()
        try await repository.savePDFPage(book.id, page: result)
        return result
    }

    static func box(_ rectangle: CGRect, size: CGSize, bottomOrigin: Bool) -> PDFBox? {
        let left = max(0, Double(rectangle.minX / size.width)), right = min(1, Double(rectangle.maxX / size.width))
        let top = max(0, bottomOrigin ? 1 - Double(rectangle.maxY / size.height) : Double(rectangle.minY / size.height))
        let bottom = min(1, bottomOrigin ? 1 - Double(rectangle.minY / size.height) : Double(rectangle.maxY / size.height))
        let result = PDFBox(left, top, right, bottom)
        return result.isValid ? result : nil
    }

    static func render(_ page: CGPDFPage, size: CGSize, maximum: CGFloat) throws -> CGImage {
        let scale = min(maximum / max(size.width, size.height), 3)
        let width = max(1, Int((size.width * scale).rounded())), height = max(1, Int((size.height * scale).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw LibraryFailure.invalidFile }
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: CGFloat(width) / size.width, y: CGFloat(height) / size.height)
        context.concatenate(page.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true))
        context.drawPDFPage(page)
        guard let image = context.makeImage() else { throw LibraryFailure.invalidFile }
        return image
    }

    static func searchablePage(_ page: CGPDFPage, size: CGSize, words: [PDFWord]) throws -> Data {
        let output = NSMutableData()
        var media = CGRect(origin: .zero, size: size)
        guard let consumer = CGDataConsumer(data: output as CFMutableData), let context = CGContext(consumer: consumer, mediaBox: &media, nil) else { throw LibraryFailure.invalidFile }
        context.beginPDFPage(nil)
        context.saveGState()
        context.concatenate(page.getDrawingTransform(.cropBox, rect: media, rotate: 0, preserveAspectRatio: true))
        context.drawPDFPage(page)
        context.restoreGState()
        for word in words {
            let box = word.box
            let rectangle = CGRect(x: box.left * size.width, y: (1 - box.bottom) * size.height, width: (box.right - box.left) * size.width, height: (box.bottom - box.top) * size.height)
            let font = CTFontCreateWithName("TimesNewRomanPSMT" as CFString, rectangle.height, nil)
            let string = NSAttributedString(string: word.text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
            let line = CTLineCreateWithAttributedString(string)
            var ascent: CGFloat = 0, descent: CGFloat = 0
            let width = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
            guard width > 0, ascent + descent > 0 else { continue }
            let scaleY = rectangle.height / (ascent + descent)
            context.saveGState()
            context.setTextDrawingMode(.invisible)
            context.textMatrix = CGAffineTransform(scaleX: rectangle.width / width, y: scaleY)
            context.textPosition = CGPoint(x: rectangle.minX, y: rectangle.minY + descent * scaleY)
            CTLineDraw(line, context)
            context.restoreGState()
        }
        context.endPDFPage(); context.closePDF()
        return output as Data
    }
}
