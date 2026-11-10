#if canImport(PDFKit)
import Foundation
import PDFKit

public enum AnnotatedPDF {
    public enum Failure: LocalizedError {
        case tooLarge
        public var errorDescription: String? { "注释 PDF 超过 200 MB 或记录较多，请减少导出范围。" }
    }
    public static func point(_ x: Double, _ y: Double, on page: PDFPage) throws -> CGPoint {
        let crop = page.bounds(for: .cropBox)
        guard !crop.isEmpty, [crop.minX, crop.minY, crop.width, crop.height].allSatisfy(\.isFinite), x.isFinite, y.isFinite else { throw LibraryFailure.invalidFile }
        let coordinate: (Double, Double)
        switch (page.rotation % 360 + 360) % 360 {
        case 0: coordinate = (x, 1 - y)
        case 90: coordinate = (y, x)
        case 180: coordinate = (1 - x, y)
        case 270: coordinate = (1 - y, 1 - x)
        default: throw LibraryFailure.invalidFile
        }
        return CGPoint(x: crop.minX + coordinate.0 * crop.width, y: crop.minY + coordinate.1 * crop.height)
    }
    public static func data(original: URL, excerpts: [SavedExcerpt]) throws -> Data {
        let limit = 200 * 1024 * 1024
        guard (try original.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? limit + 1) <= limit else { throw Failure.tooLarge }
        guard excerpts.count <= 10000, excerpts.allSatisfy(\.isValid), let document = PDFDocument(url: original), !document.isLocked, !document.isEncrypted, document.pageCount > 0 else { throw LibraryFailure.invalidFile }
        var textSize = 0, annotationCount = 0
        for item in excerpts where item.deletedAt == nil {
            var rects = item.rects ?? []
            if rects.isEmpty { rects = item.objects.map { PDFSelectionRect(page: $0.page, box: $0.box) } }
            var grouped = Dictionary(grouping: rects, by: \.page)
            let locator = (try? JSONSerialization.jsonObject(with: Data(item.locator.utf8))) as? [String: Any]
            let locations = locator?["locations"] as? [String: Any]
            let fragments = locations?["fragments"] as? [String] ?? []
            if grouped.isEmpty {
                guard let page = locations?["position"] as? Int, (1...document.pageCount).contains(page) else { throw LibraryFailure.invalidFile }
                grouped[page] = []
            }
            textSize += (item.quote.utf8.count + item.note.utf8.count + (item.answer?.utf8.count ?? 0) + 100) * grouped.count
            annotationCount += grouped.count
            guard textSize <= limit, annotationCount <= 100000 else { throw Failure.tooLarge }
            for (number, rects) in grouped {
                guard (1...document.pageCount).contains(number), let page = document.page(at: number - 1) else { throw LibraryFailure.invalidFile }
                var content = item.quote
                if !item.note.isEmpty { content += "\n\n笔记\n" + item.note }
                if let answer = item.answer, !answer.isEmpty { content += "\n\n译文或答疑\n" + answer }
                let annotation: PDFAnnotation
                if !rects.isEmpty {
                    var points: [CGPoint] = []
                    for rect in rects {
                        let box = rect.box
                        points += try [(box.left, box.top), (box.right, box.top), (box.left, box.bottom), (box.right, box.bottom)].map { try point($0.0, $0.1, on: page) }
                    }
                    let left = points.map(\.x).min()!, bottom = points.map(\.y).min()!
                    let bounds = CGRect(x: left, y: bottom, width: points.map(\.x).max()! - left, height: points.map(\.y).max()! - bottom)
                    annotation = PDFAnnotation(bounds: bounds, forType: .highlight, withProperties: nil)
                    annotation.color = .init(red: 0.51, green: 0.66, blue: 0.59, alpha: 0.28)
                    annotation.quadrilateralPoints = points.map {
                        let point = CGPoint(x: $0.x - left, y: $0.y - bottom)
                        #if os(macOS)
                        return NSValue(point: point)
                        #else
                        return NSValue(cgPoint: point)
                        #endif
                    }
                    annotation.shouldPrint = true
                } else {
                    let y = fragments.first(where: { $0.hasPrefix("y=") }).flatMap { Double($0.dropFirst(2)) } ?? 0
                    guard y.isFinite, (0...1).contains(y) else { throw LibraryFailure.invalidFile }
                    let anchor = try point(0.96, y, on: page), crop = page.bounds(for: .cropBox)
                    annotation = PDFAnnotation(bounds: CGRect(x: max(crop.minX, min(anchor.x, crop.maxX - 16)), y: max(crop.minY, min(anchor.y, crop.maxY - 16)), width: 16, height: 16), forType: .text, withProperties: nil)
                }
                annotation.contents = content
                annotation.userName = "页间"
                annotation.modificationDate = item.createdAt
                annotation.setValue("page-between-" + item.id.uuidString + "-\(number)", forAnnotationKey: .name)
                page.addAnnotation(annotation)
            }
        }
        guard let data = document.dataRepresentation() else { throw LibraryFailure.invalidFile }
        guard data.count <= limit else { throw Failure.tooLarge }
        return data
    }
}
#endif
