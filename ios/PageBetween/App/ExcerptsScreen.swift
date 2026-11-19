import SwiftUI
import ReadiumZIPFoundation
import ReadiumShared

struct ExcerptsScreen: View {
    @Environment(\.dismiss) private var dismiss
    let book: MobileBook
    let repository: LibraryRepository
    let openSource: (String) -> Void
    private enum RecordType: String, CaseIterable { case all = "全部", excerpt = "选段", bookmark = "书签", translation = "译文", conversation = "答疑" }
    private struct Record: Identifiable {
        let type: RecordType
        let item: SavedExcerpt
        var id: String { type.rawValue + item.id.uuidString }
        let order: Double
        let chapterKey: String

        init(type: RecordType, item: SavedExcerpt) {
            self.type = type
            self.item = item
            let locator = try? Locator(jsonString: item.locator)
            if let locator, locator.mediaType.matches(.pdf) {
                let page = locator.locations.position ?? 1
                let y = locator.locations.fragments.first { $0.hasPrefix("y=") }.flatMap { Double($0.dropFirst(2)) } ?? 0
                order = Double(page) + min(0.9999, max(0, y))
                chapterKey = "pdf:" + String(page)
            } else {
                order = locator?.locations.totalProgression ?? locator?.locations.progression ?? 0
                chapterKey = locator?.href.description ?? item.chapter
            }
        }
    }
    private struct RecordGroup: Identifiable {
        let rows: [Record]
        var id: String { rows[0].chapterKey }
    }
    @State private var items: [Record] = []
    @State private var selected: Record?
    @State private var removed: SavedExcerpt?
    @State private var chapter = ""
    @State private var type: RecordType = .all
    private var records: [Record] { items.filter { type == .all || $0.type == type } }
    private var visibleRecords: [Record] { records.filter { chapter.isEmpty || $0.chapterKey == chapter } }
    private var visibleItems: [SavedExcerpt] { visibleRecords.map(\.item) }
    private func groups(_ records: [Record]) -> [[Record]] {
        var keys: [String] = []
        var groups: [String: [Record]] = [:]
        for record in records {
            let key = record.chapterKey
            if groups[key] == nil { keys.append(key) }
            groups[key, default: []].append(record)
        }
        return keys.compactMap { groups[$0] }
    }
    @State private var error: String?
    @State private var exported: URL?
    @State private var exporting = false
    @State private var folder = FileManager.default.temporaryDirectory.appendingPathComponent("excerpts-" + UUID().uuidString)
    var body: some View {
        NavigationStack {
            List {
                Picker("记录类型", selection: $type) {
                    ForEach(RecordType.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.accessibilityIdentifier("margins.type").onChange(of: type) { chapter = "" }
                if !records.isEmpty {
                    Picker("章节", selection: $chapter) {
                        Text("所有章节").tag("")
                        ForEach(groups(records).compactMap(\.first)) { Text($0.item.chapter).tag($0.chapterKey) }
                    }
                }
                ForEach(groups(visibleRecords).map { RecordGroup(rows: $0) }) { group in
                    Section(group.rows[0].item.chapter) {
                        ForEach(group.rows) { record in
                            Button { selected = record } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(record.type.rawValue).font(.caption).foregroundStyle(.secondary)
                                    Text(record.item.quote.isEmpty ? "原文图像" : record.item.quote).lineLimit(3).foregroundStyle(.primary)
                                    if !record.item.note.isEmpty { Text(record.item.note).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
                                }.padding(.vertical, 4)
                            }.accessibilityIdentifier("excerpt.row." + record.item.id.uuidString).swipeActions {
                                if record.type == .excerpt || record.type == .translation {
                                    Button("删除", role: .destructive) { Task { await remove(record.item) } }
                                }
                            }
                        }
                    }
                }
                if visibleItems.isEmpty { ContentUnavailableView("暂无记录", systemImage: "text.badge.plus") }
                if let removed { Button("撤销删除") { Task { var item = removed; item.deletedAt = nil; await save(item); self.removed = nil } } }
                if let error { Text(error).foregroundStyle(.secondary) }
                if let exported { ShareLink("存储或分享导出", item: exported).accessibilityValue(exported.lastPathComponent) }
            }
            .navigationTitle("页边").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu("导出", systemImage: "square.and.arrow.up") {
                        Button("Markdown") { Task { await export(markdown: true) } }
                        Button("JSON") { Task { await export(markdown: false) } }
                        if book.format == "pdf" { Button("注释 PDF") { Task { await exportPDF() } } }
                    }.disabled(exporting || visibleItems.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .task { await reload() }
            .sheet(item: $selected) { record in
                ExcerptDetail(book: book, repository: repository, item: record.item,
                    editable: record.type == .excerpt || record.type == .translation,
                    save: { value in await save(value) }, remove: { await remove(record.item); selected = nil },
                    openSource: { dismiss(); openSource(record.item.locator) })
            }
            .onDisappear { try? FileManager.default.removeItem(at: folder) }
        }.tint(MobilePalette.accent)
    }
    private func reload() async {
        guard let latest = await repository.books().first(where: { $0.id == book.id }) else { return }
        var rows = (latest.excerpts ?? []).filter { $0.deletedAt == nil }.map {
            Record(type: $0.translationDetails == nil ? .excerpt : .translation, item: $0)
        }
        func chapterOf(_ raw: String) -> String {
            guard let locator = try? Locator(jsonString: raw) else { return book.title }
            if book.format == "pdf" { return "PDF 第 \(locator.locations.position ?? 1) 页" }
            return locator.title ?? book.title
        }
        for mark in latest.bookmarks {
            var value = SavedExcerpt(quote: mark.title, markdown: nil, locator: mark.locator, chapter: chapterOf(mark.locator), objects: [])
            value.id = mark.id
            value.createdAt = mark.createdAt
            rows.append(Record(type: .bookmark, item: value))
        }
        do {
            for conversation in try await repository.conversations(book.id, limit: 10000) {
                var value = SavedExcerpt(quote: conversation.quote, markdown: conversation.previewQuote, locator: conversation.locator,
                    chapter: chapterOf(conversation.locator), objects: conversation.sourceObjects ?? [], rects: conversation.sourceRects ?? [])
                value.id = conversation.id
                value.createdAt = conversation.createdAt
                value.attachments = conversation.sourceAttachments
                value.answer = MobileConversation.marginSnapshot(conversation.turns)
                rows.append(Record(type: .conversation, item: value))
            }
        } catch { self.error = error.localizedDescription }
        items = rows.sorted { $0.order == $1.order ? $0.item.createdAt < $1.item.createdAt : $0.order < $1.order }
    }
    @discardableResult private func save(_ item: SavedExcerpt) async -> Bool {
        do { try await repository.saveExcerpt(book.id, excerpt: item); await reload(); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    private func remove(_ item: SavedExcerpt) async {
        var deleted = item
        deleted.deletedAt = Date()
        do { try await repository.saveExcerpt(book.id, excerpt: deleted); removed = item; await reload() }
        catch { self.error = error.localizedDescription }
    }
    private func exportPDF() async {
        exporting = true
        exported = nil
        defer { exporting = false }
        do {
            let original = try await repository.file(book, name: book.originalName)
            let chosen = visibleRecords.filter { $0.type != .bookmark }.map(\.item)
            let bytes = try await Task.detached { try AnnotatedPDF.data(original: original, excerpts: chosen) }.value
            let directory = folder.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let target = directory.appendingPathComponent("页边.pdf")
            try bytes.write(to: target, options: .atomic)
            exported = target
        } catch { self.error = error.localizedDescription }
    }
    private func export(markdown: Bool) async {
        exporting = true
        exported = nil
        defer { exporting = false }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let chosen = visibleItems
            var size = chosen.reduce(0) { total, item in
                let answer = item.answer?.utf8.count ?? 0
                let translation = item.translation?.utf8.count ?? 0
                return total + item.quote.utf8.count + item.note.utf8.count + answer + translation
            }
            guard size <= (markdown ? 200 : 50) * 1024 * 1024 else { throw ServiceError.message("记录较多，请按章节导出。") }
            var data = try JSONSerialization.jsonObject(with: JSONEncoder().encode(chosen)) as? [[String: Any]] ?? []
            var lines = ["# " + book.title, ""]
            let exportFolder = folder.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: exportFolder, withIntermediateDirectories: true)
            let target = exportFolder.appendingPathComponent("页边" + (markdown ? ".zip" : ".json"))
            let archive = markdown ? try await Archive(url: target, accessMode: .create) : nil
            for (index, item) in chosen.enumerated() {
                lines += ["## " + item.chapter, "", item.markdown ?? item.quote, ""]
                var images: [String] = []
                let previews = try await PDFSourceContent.previews(book: book, objects: item.objects, attachments: item.attachments ?? [], repository: repository)
                for (offset, image) in previews.enumerated() {
                    let bytes = image.data
                    size += markdown ? bytes.count : bytes.count * 4 / 3
                    guard size <= (markdown ? 200 : 50) * 1024 * 1024 else { throw ServiceError.message("原图较多，请减少导出范围或改用 Markdown 文件包。") }
                    if !markdown { images.append("data:image/png;base64," + bytes.base64EncodedString()) }
                    if let archive {
                        let name = "images/\(index)-\(offset).png"
                        let file = folder.appendingPathComponent("\(index)-\(offset).png")
                        try bytes.write(to: file, options: .atomic)
                        try await archive.addEntry(with: name, fileURL: file)
                        lines += ["![原图](\(name))", ""]
                    }
                }
                data[index]["images"] = images
                data[index]["type"] = visibleRecords[index].type.rawValue
                data[index].removeValue(forKey: "attachments")
                if !item.note.isEmpty { lines += ["### 笔记", "", item.note, ""] }
                if let input = item.translationInput ?? item.translationDetails?.originalText, input != item.quote { lines += ["### 翻译输入", "", input, ""] }
                if let translation = item.translation { lines += ["### 译文", "", translation, ""] }
                if let answer = item.answer { lines += ["### 答疑", "", answer, ""] }
            }
            if let archive {
                let file = folder.appendingPathComponent("页边.md")
                try Data(lines.joined(separator: "\n").utf8).write(to: file, options: .atomic)
                try await archive.addEntry(with: "页边.md", fileURL: file)
            } else {
                let json = try JSONSerialization.data(withJSONObject: ["schema": 1, "title": book.title, "excerpts": data], options: [.prettyPrinted, .sortedKeys])
                try json.write(to: target, options: .atomic)
            }
            exported = target
        } catch { self.error = error.localizedDescription }
    }
}

private struct ExcerptDetail: View {
    @Environment(\.dismiss) private var dismiss
    let book: MobileBook
    let repository: LibraryRepository
    @State var item: SavedExcerpt
    let editable: Bool
    let save: (SavedExcerpt) async -> Bool
    let remove: () async -> Void
    let openSource: () -> Void
    @State private var images: [MarkdownSourceImage] = []
    @State private var error: String?
    @State private var loading = true
    @State private var editing = false
    @FocusState private var noteFocused: Bool
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if loading { ProgressView() }
                    else {
                        Text(item.chapter).font(.caption).foregroundStyle(.secondary)
                        let source = item.markdown ?? item.quote
                        if !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { MarkdownView(text: source, images: images) }
                        ForEach(Array(images.enumerated()), id: \.offset) { index, entry in
                            if !(item.attachments ?? []).isEmpty || (item.objects.indices.contains(index) && item.objects[index].type == "image"), let image = UIImage(data: entry.data) { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("原文图像") }
                        }
                        if let input = item.translationInput ?? item.translationDetails?.originalText, input != item.quote {
                            Text("翻译输入").font(.caption).foregroundStyle(.secondary)
                            MarkdownView(text: input)
                        }
                        if let translation = item.translation, !translation.isEmpty { MarkdownView(text: translation, images: images) }
                        if let explanation = item.translationDetails?.explanation, !explanation.isEmpty { MarkdownView(text: explanation) }
                        if let answer = item.answer, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { MarkdownView(text: answer, images: images) }
                        Button("返回原文") { dismiss(); openSource() }.buttonStyle(.borderedProminent)
                        if editable {
                            if editing {
                                TextField("笔记", text: $item.note, axis: .vertical).lineLimit(3...8)
                                    .accessibilityIdentifier("excerpt.note").textFieldStyle(.roundedBorder).focused($noteFocused)
                                Button("保存笔记") { Task { if await save(item) { dismiss() } } }.buttonStyle(.bordered)
                            } else {
                                if !item.note.isEmpty { Text(item.note).padding(10).background(MobilePalette.note.opacity(0.1), in: RoundedRectangle(cornerRadius: 8)) }
                                Button(item.note.isEmpty ? "记一句" : "编辑笔记") { editing = true; noteFocused = true }
                            }
                        }
                        if let error { Text(error).foregroundStyle(.secondary) }
                    }
                }.padding(20)
            }
            .navigationTitle("选段").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if editable { ToolbarItem(placement: .topBarLeading) { Menu("更多", systemImage: "ellipsis") { Button("删除", role: .destructive) { Task { await remove(); dismiss() } } } } }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .task {
                defer { loading = false }
                do {
                    images = try await PDFSourceContent.previews(book: book, objects: item.objects, attachments: item.attachments ?? [], repository: repository)
                } catch { self.error = error.localizedDescription }
            }
        }
    }
}
