import Foundation
import ImageIO

public struct SourceAttachment: Codable, Equatable, Sendable {
    public var file: String
    public var raw: String
    public init(file: String, raw: String = "") { self.file = file; self.raw = raw }
    public var isValid: Bool { file.range(of: "^attachments/[0-9a-f]{64}\\.(png|jpg)\\z", options: .regularExpression) != nil && raw.count <= 12000 }
    public static func inspect(_ data: Data, png: Bool) throws {
        guard !data.isEmpty, data.count <= 4 * 1024 * 1024,
              png ? data.starts(with: [137,80,78,71,13,10,26,10]) : data.starts(with: [255,216,255]),
              let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 4096, height <= 4096 else { throw LibraryFailure.invalidFile }
    }
}

extension LibraryRepository {
    public func attachment(_ book: MobileBook, item: SourceAttachment) throws -> Data {
        guard item.isValid else { throw LibraryFailure.invalidFile }
        let url = try file(book, name: item.file)
        let info = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true, (info.fileSize ?? 0) <= 4 * 1024 * 1024,
              try TransferManifest.hash(url) == url.deletingPathExtension().lastPathComponent else { throw LibraryFailure.invalidFile }
        let data = try Data(contentsOf: url); try SourceAttachment.inspect(data, png: url.pathExtension == "png")
        return data
    }
}
