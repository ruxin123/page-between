import SwiftUI
import ReadiumShared

struct ReferenceReaderPane: View {
    @ObservedObject var reader: MobileReader
    let close: () -> Void
    @State private var contents = false
    @State private var appearance = false
    @State private var query = ""
    @State private var pdfZoom = 100.0
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("对照").font(.callout).foregroundStyle(.secondary)
                Spacer()
                Button("目录", systemImage: "list.bullet") { contents = true }.labelStyle(.iconOnly).disabled(reader.controller == nil)
                Button("阅读设置", systemImage: "textformat.size") {
                    if let pdf = reader.navigator as? MobilePDFNavigator { pdfZoom = pdf.zoomPercent }
                    appearance = true
                }.labelStyle(.iconOnly).disabled(reader.controller == nil)
                Button("关闭对照", systemImage: "xmark") { close() }.labelStyle(.iconOnly)
            }.buttonStyle(.plain).padding(.horizontal, 16).frame(height: 44).background(.regularMaterial)
            Group {
                if let controller = reader.controller { NavigatorHost(controller: controller) }
                else if let failure = reader.failure { ContentUnavailableView("暂时无法打开", systemImage: "book.closed", description: Text(failure)) }
                else { ProgressView() }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                Button("上一页", systemImage: "chevron.left") { Task { _ = await reader.navigator?.goBackward(options: .animated) } }.labelStyle(.iconOnly).frame(width: 44, height: 44).accessibilityIdentifier("reference.previous")
                VStack(spacing: 2) { Text(reader.chapter).lineLimit(1); Text("\(Int(reader.progress * 100))%").monospacedDigit().foregroundStyle(.secondary) }.font(.caption).frame(maxWidth: .infinity).accessibilityElement(children: .combine).accessibilityIdentifier("reference.position")
                if !reader.history.isEmpty { Button("返回原位置", systemImage: "arrow.uturn.backward") { Task { await reader.back() } }.labelStyle(.iconOnly).frame(width: 44, height: 44) }
                Button("下一页", systemImage: "chevron.right") { Task { _ = await reader.navigator?.goForward(options: .animated) } }.labelStyle(.iconOnly).frame(width: 44, height: 44).accessibilityIdentifier("reference.next")
            }.buttonStyle(.plain).disabled(reader.controller == nil).padding(.horizontal, 8).background(.regularMaterial)
        }
        .overlay(alignment: .top) { Rectangle().fill(MobilePalette.accent.opacity(0.3)).frame(height: 1) }
        .accessibilityElement(children: .contain).accessibilityIdentifier("reader.reference")
        .task { await reader.load() }
        .sheet(isPresented: $contents) {
            NavigationStack {
                List {
                    ForEach(Array(links.filter { query.isEmpty || ($0.title ?? "").localizedCaseInsensitiveContains(query) }.enumerated()), id: \.offset) { entry in
                        Button(entry.element.title ?? "章节") { Task { await reader.go(entry.element); contents = false } }
                    }
                }.searchable(text: $query, prompt: "查找章节")
                .navigationTitle("目录").navigationBarTitleDisplayMode(.inline).toolbar { Button("完成") { contents = false } }
            }
        }
        .sheet(isPresented: $appearance) {
            NavigationStack {
                Form {
                    Picker("浏览方式", selection: $reader.scroll) { Text("左右翻页").tag(false); Text("连续滚动").tag(true) }.onChange(of: reader.scroll) { reader.apply() }
                    if let pdf = reader.navigator as? MobilePDFNavigator {
                        LabeledContent("缩放", value: "\(Int(pdfZoom))%")
                        Slider(value: $pdfZoom, in: 25...400, step: 5).accessibilityLabel("缩放百分比").onChange(of: pdfZoom) { pdf.zoom(pdfZoom) }
                        Button("适合宽度") { pdf.fitWidth(); pdfZoom = pdf.zoomPercent }
                        Button("适合整页") { pdf.fitPage(); pdfZoom = pdf.zoomPercent }
                    } else {
                        LabeledContent("字号", value: "\(Int(reader.fontScale))%")
                        Slider(value: $reader.fontScale, in: 70...200, step: 10).accessibilityLabel("字号比例").onChange(of: reader.fontScale) { reader.apply() }
                        Picker("字体", selection: $reader.fontFamily) { Text("原书").tag(""); Text("宋体").tag("Songti SC"); Text("苹方").tag("PingFang SC"); Text("Georgia").tag("Georgia") }.onChange(of: reader.fontFamily) { reader.apply() }
                    }
                }.navigationTitle("阅读设置").navigationBarTitleDisplayMode(.inline).toolbar { Button("完成") { appearance = false } }
            }.presentationDetents([.medium, .large])
        }
        .sheet(item: $reader.selection) { selection in AssistantScreen(selection: selection, title: reader.book.title, repository: reader.store.repository, openSource: { raw in Task { await reader.goSource(raw) } }) }
        .alert("操作未完成", isPresented: Binding(get: { reader.failure != nil && reader.controller != nil }, set: { if !$0 { reader.failure = nil } })) { Button("好") { reader.failure = nil } } message: { Text(reader.failure ?? "") }
    }
    private var links: [ReadiumShared.Link] {
        func flatten(_ values: [ReadiumShared.Link]) -> [ReadiumShared.Link] { values.flatMap { [$0] + flatten($0.children) } }
        return flatten(reader.contents)
    }
}
