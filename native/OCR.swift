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
    let width = fast ? 720 : 1900
    let bounds = page.bounds(for: .mediaBox)
    let height = Int(Double(width) * bounds.height / bounds.width)
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: CGFloat(width) / bounds.width, y: CGFloat(width) / bounds.width)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: context)
    let image = context.makeImage()!
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    request.usesLanguageCorrection = !fast
    request.minimumTextHeight = fast ? 0.008 : 0.003
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let pattern = try NSRegularExpression(pattern: "\\p{Han}+|[\\p{L}\\p{N}]+|[^\\s]")
    var lines: [[String: Any]] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        var segments: [[String: Any]] = []
        if !fast && !arguments.contains("--layout") {
            let matches = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
            for (index, match) in matches.enumerated() {
                guard let range = Range(match.range, in: text), let rectangle = try? candidate.boundingBox(for: range) else { continue }
                let end = index + 1 < matches.count ? matches[index + 1].range.location : (text as NSString).length
                let value = (text as NSString).substring(with: NSRange(location: match.range.location, length: end - match.range.location))
                segments.append(["text": value, "bbox": box(rectangle.boundingBox)])
            }
        }
        lines.append(["text": text, "bbox": box(observation.boundingBox), "confidence": candidate.confidence, "segments": segments])
    }
    let result: [String: Any] = ["page": number, "width": width, "height": height, "engine": "apple-vision", "lines": lines]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
