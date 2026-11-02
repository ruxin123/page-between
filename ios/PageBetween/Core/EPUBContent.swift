import Foundation

public struct EPUBHeading: Sendable {
    public var title: String
    public var anchor: String
    public var children: [EPUBHeading]
    public init(title: String, anchor: String, children: [EPUBHeading] = []) { self.title = title; self.anchor = anchor; self.children = children }
}
public struct EPUBChapter: Sendable {
    public var title: String
    public var body: String
    public var anchor: String?
    public var headings: [EPUBHeading]
    public init(title: String, body: String, anchor: String? = nil, headings: [EPUBHeading] = []) { self.title = title; self.body = body; self.anchor = anchor; self.headings = headings }
}
public struct EPUBResource: Sendable {
    public var name: String
    public var mediaType: String
    public var data: Data
    public init(name: String, mediaType: String, data: Data) { self.name = name; self.mediaType = mediaType; self.data = data }
}
public struct EPUBContent: Sendable {
    public var title: String
    public var author: String
    public var language: String
    public var chapters: [EPUBChapter]
    public var resources: [EPUBResource]
    public var cover: String?
    public init(title: String, author: String = "", language: String = "und", chapters: [EPUBChapter], resources: [EPUBResource] = [], cover: String? = nil) {
        self.title = title; self.author = author; self.language = language; self.chapters = chapters; self.resources = resources; self.cover = cover
    }
}
