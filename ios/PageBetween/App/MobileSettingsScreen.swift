import SwiftUI

struct MobileSettingsScreen: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var services = MobileServices()
    @State private var aiKey = SecureKeys.read("ai")
    @State private var translationKey = SecureKeys.read("translation")
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("AI 答疑") { profile($services.ai, key: $aiKey) }
                Section("划词翻译") {
                    Picker("默认服务", selection: $services.provider) { Text("Google").tag("google"); Text("AI").tag("ai") }
                    Toggle("单独配置翻译模型", isOn: $services.separateTranslation)
                    if services.separateTranslation { profile($services.translation, key: $translationKey) }
                }
                Section { LabeledContent("版本", value: "0.1.0"); Text("书籍和阅读进度保存在手机；服务密钥保存在本机钥匙串。").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("保存") { do { try services.save(aiKey: aiKey, translationKey: translationKey); dismiss() } catch { self.error = error.localizedDescription } } } }
            .alert("设置未保存", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("好") { error = nil } } message: { Text(error ?? "") }
        }.tint(MobilePalette.accent)
    }
    private func profile(_ value: Binding<ServiceProfile>, key: Binding<String>) -> some View {
        Group { TextField("API 地址", text: value.baseURL).keyboardType(.URL); TextField("模型名称", text: value.model); SecureField("API Key", text: key) }.textInputAutocapitalization(.never).autocorrectionDisabled()
    }
}
