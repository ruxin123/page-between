import AppKit
import WebKit

/// A separate quick-lookup panel, shared by the main reader and Palm.
final class TranslationWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
  let panel: ReaderPanel
  let web: WKWebView
  let base: URL
  let session: String
  var action: (([String: Any]) -> Void)?
  private var ready = false
  private var pending: [String: Any]?
  private var pinned = false
  private weak var sourceView: WKWebView?
  private var mouseMonitor: Any?
  private var deactivateObserver: NSObjectProtocol?

  init(base: URL, session: String, dataStore: WKWebsiteDataStore) {
    self.base = base
    self.session = session
    let config = WKWebViewConfiguration()
    config.websiteDataStore = dataStore
    web = WKWebView(frame: .zero, configuration: config)
    panel = ReaderPanel(contentRect: NSRect(x: 200, y: 200, width: 400, height: 480),
      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    super.init()
    panel.title = "划词翻译 · 页间"
    panel.minSize = NSSize(width: 320, height: 300)
    panel.isMovable = true
    panel.isReleasedWhenClosed = false
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.contentView = web
    panel.delegate = self
    web.navigationDelegate = self
    config.userContentController.add(self, name: "translationNative")
    var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
    parts.queryItems = [URLQueryItem(name: "mode", value: "translation")]
    var request = URLRequest(url: parts.url!)
    request.setValue(session, forHTTPHeaderField: "X-Page-Between-Session")
    web.load(request)
    mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
      if let self = self, self.panel.isVisible, !self.pinned,
        let window = event.window, window !== self.panel, window.level < .popUpMenu {
        self.dismiss()
      }
      return event
    }
    deactivateObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      if let self = self, !self.pinned { self.dismiss() }
    }
  }

  deinit {
    if let monitor = mouseMonitor { NSEvent.removeMonitor(monitor) }
    if let observer = deactivateObserver { NotificationCenter.default.removeObserver(observer) }
  }

  func show(_ request: [String: Any], from view: WKWebView?) {
    guard let context = request["context"] as? [String: Any],
      let book = context["book"] as? String,
      book.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$", options: .regularExpression) != nil,
      JSONSerialization.isValidJSONObject(context),
      let bytes = try? JSONSerialization.data(withJSONObject: context), bytes.count <= 128 * 1024
    else { return }
    sourceView = view
    pending = ["context": context, "history": request["history"] as? Bool ?? false]
    if !pinned || !panel.isVisible {
      let screen = view?.window?.screen ?? NSScreen.main
      let bounds = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
      let size = NSSize(width: min(panel.frame.width, bounds.width - 16), height: min(panel.frame.height, bounds.height * 0.8))
      var point = NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2)
      if let view = view, let owner = view.window, let rect = request["rect"] as? [String: Any],
        let left = rect["left"] as? Double, let bottom = rect["bottom"] as? Double,
        left.isFinite, bottom.isFinite {
        let local = NSPoint(x: left, y: view.isFlipped ? bottom : view.bounds.height - bottom)
        let anchor = owner.convertPoint(toScreen: view.convert(local, to: nil))
        point = NSPoint(x: anchor.x, y: anchor.y - size.height - 8)
        if point.y < bounds.minY + 8 { point.y = anchor.y + 36 }
      }
      let frame = NSRect(x: max(bounds.minX + 8, min(bounds.maxX - size.width - 8, point.x)),
                         y: max(bounds.minY + 8, min(bounds.maxY - size.height - 8, point.y)), width: size.width, height: size.height)
      panel.setFrame(frame, display: false)
    }
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    deliver()
  }

  func deliver() {
    guard ready, panel.isVisible, let request = pending else { return }
    pending = nil
    Task { @MainActor [weak self] in
      guard let self = self else { return }
      _ = try? await self.web.callAsyncJavaScript("window.readerTranslationReceive(request);",
        arguments: ["request": request], in: nil, contentWorld: .page)
    }
  }

  func dismiss() {
    let wasVisible = panel.isVisible
    pending = nil
    panel.orderOut(nil)
    if ready { web.evaluateJavaScript("window.readerTranslationDismiss?.();") }
    if wasVisible {
      sourceView?.evaluateJavaScript("window.dispatchEvent(new Event('reader-selection-resume'))")
    }
  }

  func shutdown() {
    dismiss()
    web.configuration.userContentController.removeScriptMessageHandler(forName: "translationNative")
    web.loadHTMLString("", baseURL: nil)
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, message.webView === web,
      message.frameInfo.securityOrigin.host == base.host, message.frameInfo.securityOrigin.port == base.port,
      let body = message.body as? [String: Any], let name = body["action"] as? String else { return }
    if name == "ready" { ready = true; deliver() }
    else if name == "close" { dismiss() }
    else if name == "pin", let value = body["value"] as? Bool { pinned = value }
    else if name == "resize", panel.isVisible, !panel.inLiveResize,
      let height = body["height"] as? Double, height.isFinite {
      let limit = (panel.screen?.visibleFrame.height ?? 900) * 0.8 - 28
      let desired = max(280, min(limit, height))
      if abs(web.bounds.height - desired) > 2 {
        let top = panel.frame.maxY
        panel.setContentSize(NSSize(width: web.bounds.width, height: desired))
        let bounds = panel.screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let y = max(bounds.minY + 8, min(bounds.maxY - panel.frame.height - 8, top - panel.frame.height))
        panel.setFrameOrigin(NSPoint(x: panel.frame.minX, y: y))
      }
    }
    else if ["source", "settings", "tutor"].contains(name) { action?(body) }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
    let allowed = url.scheme == "http" && url.host == base.host && url.port == base.port
    if !allowed, navigationAction.navigationType == .linkActivated,
      ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    decisionHandler(allowed ? .allow : .cancel)
  }
}
