import SwiftUI
import WebKit

struct MarkdownSourceImage: Equatable {
    let raw: String
    let data: Data
    var json: [String: String] { ["raw": raw, "src": "data:image/png;base64," + data.base64EncodedString()] }
}

struct MarkdownView: View {
    let text: String
    var images: [MarkdownSourceImage] = []
    @State private var height: CGFloat = 80
    @State private var failed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MarkdownWebView(text: text, images: images, height: $height, failed: $failed).frame(height: failed ? 0 : height).accessibilityHidden(failed)
            if failed { Text(text).font(.body).textSelection(.enabled) }
        }
    }
}

private struct MarkdownWebView: UIViewRepresentable {
    private static let dataStore = WKWebsiteDataStore.nonPersistent()
    let text: String
    let images: [MarkdownSourceImage]
    @Binding var height: CGFloat
    @Binding var failed: Bool
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = Self.dataStore
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.accessibilityIdentifier = "markdown.preview"
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        if let page = Bundle.main.url(forResource: "markdown", withExtension: "html", subdirectory: "Web") {
            view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        } else { DispatchQueue.main.async { context.coordinator.parent.failed = true } }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.parent = self; context.coordinator.render(view) }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: MarkdownWebView
        var loaded = false
        var revision = 0
        var lastText: String?
        var lastImages: [MarkdownSourceImage] = []
        init(_ parent: MarkdownWebView) { self.parent = parent }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true; lastText = nil; render(webView) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.failed = true }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.failed = true }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loaded = false; parent.failed = true }
        func render(_ view: WKWebView) {
            guard loaded, parent.text != lastText || parent.images != lastImages else { return }
            lastText = parent.text
            lastImages = parent.images
            revision += 1; let generation = revision
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let value = try? await view.callAsyncJavaScript("return await window.renderMarkdown(text, images)", arguments: ["text": self.parent.text, "images": self.parent.images.map(\.json)], in: nil, contentWorld: .page), generation == self.revision, let size = value as? Double {
                    let height = max(40, CGFloat(size))
                    self.parent.failed = false
                    if abs(self.parent.height - height) > 1 { self.parent.height = height }
                } else if generation == self.revision { self.parent.failed = true }
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated {
                if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
            } else { decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel) }
        }
    }
}
