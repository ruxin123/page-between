import Foundation
import PDFKit
import ImageIO

enum PDFSourceContent {
    static func glyphs(_ selection: PDFSelection, page: PDFPage) -> [PDFSourceGlyph]? {
        guard let text = page.string, (text as NSString).length <= 120000, let reference = page.pageRef else { return nil }
        let string = text as NSString
        guard string.length <= page.numberOfCharacters else { return nil }
        let crop = reference.getBoxRect(.cropBox), rotated = reference.rotationAngle % 180 != 0
        let size = CGSize(width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height)
        guard size.width > 0, size.height > 0 else { return nil }
        let transform = reference.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true)
        let selected = (0..<selection.numberOfTextRanges(on: page)).map { selection.range(at: $0, on: page) }
        var result: [PDFSourceGlyph] = [], offset = 0
        while offset < string.length {
            let range = string.rangeOfComposedCharacterSequence(at: offset)
            var rectangle = CGRect.null
            for character in range.location..<NSMaxRange(range) {
                let box = page.characterBounds(at: character)
                if !box.isEmpty, !box.isNull { rectangle = rectangle.union(box) }
            }
            let box = rectangle.isNull ? nil : PDFTextPreparation.box(rectangle.applying(transform), size: size, bottomOrigin: true)
            result.append(PDFSourceGlyph(text: string.substring(with: range), box: box, selected: selected.contains { NSIntersectionRange($0, range).length > 0 }))
            offset = NSMaxRange(range)
        }
        return result
    }
    static func box(_ page: PDFPage, rectangle: CGRect) -> PDFBox? {
        guard let reference = page.pageRef else { return nil }
        let crop = reference.getBoxRect(.cropBox), rotated = reference.rotationAngle % 180 != 0
        let size = CGSize(width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height)
        return PDFTextPreparation.box(rectangle.applying(reference.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true)), size: size, bottomOrigin: true)
    }
    static func rectangle(_ box: PDFBox, on page: PDFPage) -> CGRect? {
        guard box.isValid, let reference = page.pageRef else { return nil }
        let crop = reference.getBoxRect(.cropBox), rotated = reference.rotationAngle % 180 != 0
        let size = CGSize(width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height)
        let oriented = CGRect(x: box.left * size.width, y: (1 - box.bottom) * size.height, width: (box.right - box.left) * size.width, height: (box.bottom - box.top) * size.height)
        return oriented.applying(reference.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true).inverted())
    }
    static func image(_ object: PDFSourceObject, original: URL) throws -> Data {
        guard object.isValid, let document = CGPDFDocument(original as CFURL), object.page <= document.numberOfPages, let page = document.page(at: object.page) else { throw LibraryFailure.invalidFile }
        let crop = page.getBoxRect(.cropBox), rotated = page.rotationAngle % 180 != 0
        let size = CGSize(width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height)
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { throw LibraryFailure.invalidFile }
        let source = try PDFTextPreparation.render(page, size: size, maximum: 2400), box = object.box
        let rectangle = CGRect(x: box.left * Double(source.width), y: box.top * Double(source.height), width: (box.right - box.left) * Double(source.width), height: (box.bottom - box.top) * Double(source.height)).insetBy(dx: -2, dy: -2).integral.intersection(CGRect(x: 0, y: 0, width: source.width, height: source.height))
        guard let image = source.cropping(to: rectangle) else { throw LibraryFailure.invalidFile }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { throw LibraryFailure.invalidFile }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), data.length <= 6 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
        return data as Data
    }
}
