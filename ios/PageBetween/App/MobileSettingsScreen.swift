import SwiftUI

struct MobileSettingsScreen: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var services = MobileServices()
    @State private var aiKey = ""
    @State private var translationKey = ""
    @State private var mineruKey = ""
    @State private var error: String?
    @State private var models: [String: [String]] = [:]
    @State private var loadingModels: Set<String> = []
    var body: some View {
        NavigationStack {
            Form {
                NavigationLink("全局阅读默认") { ReadingDefaultsForm() }
                Section("AI 答疑") {
                    profile($services.ai, key: $aiKey, service: "ai")
                    Toggle("支持图像输入", isOn: Binding(get: { services.ai.supportsImages == true }, set: { services.ai.supportsImages = $0 }))
                    prompt($services.ai)
                }
                Section("划词翻译") {
                    Picker("默认服务", selection: $services.provider) { Text("Google").tag("google"); Text("AI").tag("ai") }
                    Toggle("单独配置翻译模型", isOn: $services.separateTranslation)
                    if services.separateTranslation { profile($services.translation, key: $translationKey, service: "translation") }
                    if services.provider == "ai" { prompt($services.translation) }
                }
                Section("MinerU") {
                    TextField("解析服务地址", text: $services.mineru.baseURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("MinerU Token", text: $mineruKey).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("解析模型", selection: $services.mineru.model) { Text("VLM").tag("vlm"); Text("Pipeline").tag("pipeline") }
                    Picker("文档语言", selection: $services.mineru.language) { Text("中文").tag("ch"); Text("英文").tag("en"); Text("自动").tag("auto") }
                }
                Section { LabeledContent("版本", value: "0.1.0") }
            }
            .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("保存") { do { try services.save(aiKey: aiKey, translationKey: translationKey, mineruKey: mineruKey); dismiss() } catch { self.error = error.localizedDescription } } } }
            .alert("操作未完成", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("好") { error = nil } } message: { Text(error ?? "") }
        }.tint(MobilePalette.accent)
        .task {
            do {
                aiKey = try LocalCredentials.read("ai")
                translationKey = try LocalCredentials.read("translation")
                mineruKey = try LocalCredentials.read("mineru")
            } catch { self.error = error.localizedDescription }
        }
    }
    private func prompt(_ value: Binding<ServiceProfile>) -> some View {
        DisclosureGroup("自定义提示词") {
            TextField("回答或翻译偏好", text: Binding(get: { value.wrappedValue.customPrompt ?? "" }, set: { value.wrappedValue.customPrompt = $0 }), axis: .vertical).lineLimit(3...8)
        }
    }
    private func profile(_ value: Binding<ServiceProfile>, key: Binding<String>, service: String) -> some View {
        Group {
            TextField("API 地址", text: value.baseURL).keyboardType(.URL)
            TextField("模型名称", text: value.model)
            SecureField("API Key", text: key)
            Button(loadingModels.contains(service) ? "读取中…" : "读取模型") {
                loadingModels.insert(service)
                Task {
                    defer { loadingModels.remove(service) }
                    do {
                        let snapshot = value.wrappedValue
                        let found = try await services.models(profile: snapshot, key: key.wrappedValue)
                        guard value.wrappedValue.baseURL == snapshot.baseURL else { return }
                        models[service] = found
                        if found.isEmpty { error = "服务中暂无可用模型。" }
                    } catch { self.error = error.localizedDescription }
                }
            }.disabled(loadingModels.contains(service))
            if let found = models[service], !found.isEmpty {
                Picker("选择模型", selection: value.model) {
                    Text(found.contains(value.wrappedValue.model) ? value.wrappedValue.model : "手动填写").tag(value.wrappedValue.model)
                    ForEach(found.filter { $0 != value.wrappedValue.model }, id: \.self) { Text($0).tag($0) }
                }
            }
        }.textInputAutocapitalization(.never).autocorrectionDisabled()
        .onChange(of: value.wrappedValue.baseURL) { models[service] = nil }
    }
}

private struct ReadingDefaultsForm: View {
    @AppStorage("reading.fontScale") private var fontScale = 100.0
    @AppStorage("reading.lineHeight") private var lineHeight = 1.85
    @AppStorage("reading.pageMargins") private var pageMargins = 1.0
    @AppStorage("reading.fontFamily") private var fontFamily = ""
    @AppStorage("reading.theme") private var theme = "paper"
    @AppStorage("reading.pdfScroll") private var pdfScroll = true
    @AppStorage("reading.textScroll") private var textScroll = false

    var body: some View {
        Form {
            Picker("文字阅读", selection: $textScroll) { Text("左右翻页").tag(false); Text("连续滚动").tag(true) }
            Picker("PDF 阅读", selection: $pdfScroll) { Text("单页翻阅").tag(false); Text("连续滚动").tag(true) }
            Picker("纸张", selection: $theme) { Text("纸白").tag("paper"); Text("暖纸").tag("sepia"); Text("夜间").tag("night") }
            Picker("字体", selection: $fontFamily) { Text("原书").tag(""); Text("宋体").tag("Songti SC"); Text("苹方").tag("PingFang SC"); Text("Georgia").tag("Georgia") }
            LabeledContent("字号", value: "\(Int(fontScale))%")
            Slider(value: $fontScale, in: 70...200, step: 10).accessibilityLabel("字号")
            LabeledContent("行距", value: lineHeight.formatted(.number.precision(.fractionLength(2))))
            Slider(value: $lineHeight, in: 1.4...2.2, step: 0.05).accessibilityLabel("行距")
            LabeledContent("页边距", value: pageMargins.formatted(.number.precision(.fractionLength(1))))
            Slider(value: $pageMargins, in: 0.5...2, step: 0.1).accessibilityLabel("页边距")
        }.navigationTitle("全局阅读默认")
    }
}
