import Foundation
import PDFKit
import Vision
import ImageIO

func box(_ rectangle: CGRect) -> [Double] {
    [Double(rectangle.minX), Double(1 - rectangle.maxY), Double(rectangle.maxX), Double(1 - rectangle.minY)]
}

do {
    let arguments = CommandLine.arguments
    guard arguments.count >= 3, let number = Int(arguments[2]), number > 0,
          let document = PDFDocument(url: URL(fileURLWithPath: arguments[1])),
          let page = document.page(at: number - 1) else {
        throw NSError(domain: "OCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取指定 PDF 页"])
    }
    let fast = arguments.contains("--fast")
    guard let pdfPage = page.pageRef else {
        throw NSError(domain: "OCR", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法读取 PDF 页面图像"])
    }
    let bounds = pdfPage.getBoxRect(.cropBox).intersection(pdfPage.getBoxRect(.mediaBox))
    let rotation = (pdfPage.rotationAngle % 360 + 360) % 360
    let sideways = rotation == 90 || rotation == 270
    let pageWidth = sideways ? bounds.height : bounds.width
    let pageHeight = sideways ? bounds.width : bounds.height
    guard pageWidth.isFinite, pageHeight.isFinite, pageWidth > 0, pageHeight > 0 else {
        throw NSError(domain: "OCR", code: 3, userInfo: [NSLocalizedDescriptionKey: "PDF 页面尺寸无效"])
    }
    let scale = min(CGFloat(fast ? 720 : 1900) / pageWidth,
                    sqrt(CGFloat(fast ? 2_000_000 : 8_000_000) / (pageWidth * pageHeight)),
                    8192 / max(pageWidth, pageHeight))
    let width = max(1, Int(pageWidth * scale))
    let height = max(1, Int(pageHeight * scale))
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: CGFloat(width) / pageWidth, y: CGFloat(height) / pageHeight)
    context.concatenate(pdfPage.getDrawingTransform(.cropBox,
        rect: CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight), rotate: 0, preserveAspectRatio: true))
    context.drawPDFPage(pdfPage)
    let image = context.makeImage()!
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    request.usesLanguageCorrection = !fast
    request.minimumTextHeight = fast ? 0.008 : 0.003
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    var lines: [[String: Any]] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        var segments: [[String: Any]] = []
        if !fast && !arguments.contains("--layout") {
            for index in text.indices {
                let end = text.index(after: index), value = String(text[index..<end])
                if value.allSatisfy({ $0.isWhitespace }), let last = segments.indices.last {
                    segments[last]["text"] = (segments[last]["text"] as! String) + value
                    continue
                }
                guard let rectangle = try? candidate.boundingBox(for: index..<end) else { continue }
                let bounds = box(rectangle.boundingBox)
                // Vision sometimes reports one box for a whole word; never stack identical hit regions.
                if let last = segments.indices.last, let previous = segments[last]["bbox"] as? [Double],
                   zip(previous, bounds).allSatisfy({ abs($0 - $1) < 0.000001 }) {
                    segments[last]["text"] = (segments[last]["text"] as! String) + value
                } else {
                    segments.append(["text": value, "bbox": bounds])
                }
            }
        }
        lines.append(["text": text, "bbox": box(observation.boundingBox), "confidence": candidate.confidence, "segments": segments])
    }
    let result: [String: Any] = ["page": number, "width": width, "height": height, "engine": "apple-vision", "coordinateSpace": "crop-rotated-v1", "lines": lines]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
