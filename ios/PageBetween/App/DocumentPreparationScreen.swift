import SwiftUI
import PDFKit

struct DocumentPreparationScreen: View {
    @Environment(\.dismiss) private var dismiss
    let book: MobileBook
    @ObservedObject var store: LibraryStore
    @ObservedObject private var preparation: PDFPreparationStore
    @State private var total = 0
    @State private var pageRange = ""
    @State private var enabled = true
    @State private var error: String?
    @State private var settings = false
    @State private var cloudConsent: [Int]?
    @State private var resubmit = false
    @State private var cloudFresh = false
    init(book: MobileBook, store: LibraryStore) { self.book = book; self.store = store; preparation = store.preparation }
    private var task: PDFPreparationTask? { preparation.jobs[book.id] }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(book.title, value: "\(total) 页")
                    Toggle("文档解析", isOn: $enabled).onChange(of: enabled) {
                        Task {
                            do { try await store.repository.setParsing(book.id, enabled: enabled); if !enabled { preparation.pause(book.id) }; await store.refresh() }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                }
                Section("划词准备") {
                    if let task {
                        ProgressView(value: Double(task.completed.count), total: Double(max(1, task.pages.count)))
                        LabeledContent(status(task), value: "\(task.completed.count) / \(task.pages.count)")
                        if !task.message.isEmpty { Text(task.message).font(.footnote).foregroundStyle(.secondary) }
                        if task.state == "running" { Button("暂停") { preparation.pause(book.id) } }
                        else if task.state != "done" { Button("继续准备") { preparation.start(book, pages: task.pages) }.disabled(!enabled) }
                    }
                    if task?.state != "running" {
                        Button("准备整本") { preparation.start(book, pages: Array(1...max(1, total))) }.disabled(!enabled || total == 0)
                        TextField("页段，例如 1-20,35", text: $pageRange).keyboardType(.numbersAndPunctuation)
                        Button("准备所选页") { do { preparation.start(book, pages: try PDFPageRange.parse(pageRange, total: total)) } catch { self.error = "请填写本书的 PDF 文件页序。" } }.disabled(!enabled || total == 0)
                        Button("重新准备所选页") { do { preparation.start(book, pages: try PDFPageRange.parse(pageRange, total: total), fresh: true) } catch { self.error = "请填写本书的 PDF 文件页序。" } }.disabled(!enabled || total == 0 || pageRange.isEmpty)
                    }
                }
                Section("MinerU 增强") {
                    if let task = preparation.mineruJobs[book.id] {
                        ProgressView(value: Double(task.completed.count), total: Double(max(1, task.pages.count)))
                        LabeledContent(status(task), value: "\(task.completed.count) / \(task.pages.count)")
                        if !task.message.isEmpty { Text(task.message).font(.footnote).foregroundStyle(.secondary) }
                        if task.state == "running" { Button("暂停云解析") { preparation.pauseMinerU(book.id) } }
                        else if !task.pages.isEmpty && task.state != "done" { Button("继续云解析") { requestCloud(task.pages) } }
                    }
                    if preparation.mineruJobs[book.id]?.state != "running" {
                        Button("解析整本") { requestCloud(Array(1...max(1, total))) }.disabled(!enabled || total == 0)
                        Button("补全未解析页") { Task { await missingPages() } }.disabled(!enabled || total == 0)
                        TextField("云解析页段，例如 1-20,35", text: $pageRange).keyboardType(.numbersAndPunctuation)
                        Toggle("重新提交所选页", isOn: $resubmit)
                        Button("解析所选页") { do { requestCloud(try PDFPageRange.parse(pageRange, total: total), fresh: resubmit) } catch { self.error = "请填写本书的 PDF 文件页序。" } }.disabled(!enabled || total == 0)
                    }
                    Button("服务设置", systemImage: "gearshape") { settings = true }
                }
                if let error { Section { Text(error).foregroundStyle(.secondary) } }
            }
            .navigationTitle("文档处理").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { dismiss() } }
            .sheet(isPresented: $settings) { MobileSettingsScreen() }
            .confirmationDialog("将所选 \(cloudConsent?.count ?? 0) 页发送至 MinerU？", isPresented: Binding(get: { cloudConsent != nil }, set: { if !$0 { cloudConsent = nil } })) {
                Button("开始解析") { if let pages = cloudConsent { preparation.startMinerU(book, pages: pages, fresh: cloudFresh) }; cloudConsent = nil }
            } message: { Text("所选页将上传至 MinerU。") }
            .task {
                enabled = (store.books.first(where: { $0.id == book.id }) ?? book).shouldPrepare
                do { let source = try await store.repository.file(book, name: book.originalName); total = PDFDocument(url: source)?.pageCount ?? 0; await preparation.restore(book) }
                catch { self.error = error.localizedDescription }
            }
        }.tint(MobilePalette.accent)
    }
    private func status(_ task: PDFPreparationTask) -> String { ["running": "正在准备", "paused": "已暂停", "failed": "准备未完成", "done": "已完成"][task.state] ?? "等待准备" }
    private func requestCloud(_ pages: [Int], fresh: Bool = false) {
        guard enabled else { return }
        if SecureKeys.read("mineru").isEmpty { settings = true; return }
        cloudFresh = fresh; cloudConsent = pages
    }
    private func missingPages() async {
        do {
            var missing: [Int] = []
            for page in 1...max(1, total) { if try await store.repository.pdfPage(book.id, page: page)?.mineruCompleted != true { missing.append(page) } }
            if missing.isEmpty { error = "本书已全部解析。" } else { requestCloud(missing) }
        } catch { self.error = error.localizedDescription }
    }
}
