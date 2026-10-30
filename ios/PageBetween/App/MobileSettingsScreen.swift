import SwiftUI

struct MobileSettingsScreen: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var services = MobileServices()
    @State private var aiKey = SecureKeys.read("ai")
    @State private var translationKey = SecureKeys.read("translation")
    @State private var mineruKey = SecureKeys.read("mineru")
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("AI 答疑") {
                    profile($services.ai, key: $aiKey)
                    Toggle("支持图像输入", isOn: Binding(get: { services.ai.supportsImages == true }, set: { services.ai.supportsImages = $0 }))
                }
                Section("划词翻译") {
                    Picker("默认服务", selection: $services.provider) { Text("Google").tag("google"); Text("AI").tag("ai") }
                    Toggle("单独配置翻译模型", isOn: $services.separateTranslation)
                    if services.separateTranslation { profile($services.translation, key: $translationKey) }
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
            .alert("设置未保存", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("好") { error = nil } } message: { Text(error ?? "") }
        }.tint(MobilePalette.accent)
    }
    private func profile(_ value: Binding<ServiceProfile>, key: Binding<String>) -> some View {
        Group { TextField("API 地址", text: value.baseURL).keyboardType(.URL); TextField("模型名称", text: value.model); SecureField("API Key", text: key) }.textInputAutocapitalization(.never).autocorrectionDisabled()
    }
}
