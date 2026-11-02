import Foundation

public struct BookImport: Identifiable, Sendable {
    public let id = UUID()
    public let url: URL
    public var parseEnabled: Bool
    public init(_ url: URL) { self.url = url; self.parseEnabled = ["pdf", "txt"].contains(url.pathExtension.lowercased()) }
}
