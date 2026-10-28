import AppKit
import Carbon
import Darwin
import UniformTypeIdentifiers
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKUIDelegate, WKScriptMessageHandler
{
  var window: NSWindow!
  var web: WKWebView!
  var engine: Process?
  var output: Pipe?
  var base: URL?
  var palm: PalmDelegate?
  var translator: TranslationWindow?
  var tutorWindow: NSWindow?
  var tutorWeb: WKWebView?
  var tutorReady = false
  var tutorBook: String?
  var pendingTutor: [String: Any]?
  var quitting = false
  var restarting = false
  var pendingFiles: [URL] = []
  var importing = false
  var ready = false
  var outputBuffer = Data()
  var quitReplied = false
  var terminationSignal: DispatchSourceSignal?
  var hotkey: EventHotKeyRef?
  var hotkeyHandler: EventHandlerRef?
  var hotkeyHandlerStatus: OSStatus = -1
  var hotkeyRegistrationStatus: OSStatus = -1
  let demo =
    CommandLine.arguments.contains("--demo")
    || Bundle.main.object(forInfoDictionaryKey: "PageBetweenDemo") as? Bool == true
  let session =
    UUID().uuidString.replacingOccurrences(of: "-", with: "")
    + UUID().uuidString.replacingOccurrences(of: "-", with: "")
  let supported = [
    "epub", "pdf", "txt", "mobi", "azw", "azw3", "fb2", "md", "markdown", "html", "htm", "docx",
    "odt", "rtf", "cbz",
  ]
  var support: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Page Between/" + (demo ? "Review Demo" : "Personal"))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if let identity = Bundle.main.bundleIdentifier,
      let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identity).first(
        where: {
          $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated
        })
    {
      existing.activate(options: [])
      NSApp.terminate(nil)
      return
    }
    signal(SIGTERM, SIG_IGN)
    terminationSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminationSignal?.setEventHandler {
      // AppKit's deferred termination must start outside a GCD main-queue callback.
      RunLoop.main.perform { NSApp.terminate(nil) }
    }
    terminationSignal?.resume()
    NSApp.setActivationPolicy(.regular)
    buildMenu()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(self, name: "appNative")
    web = WKWebView(frame: .zero, configuration: configuration)
    web.navigationDelegate = self
    web.uiDelegate = self
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = "页间" + (demo ? " · 演示" : "")
    window.minSize = NSSize(width: 820, height: 620)
    window.center()
    window.setFrameAutosaveName(demo ? "PageBetweenDemoMain" : "PageBetweenMain")
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = web
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    web.loadHTMLString(
      "<html><body style='background:#f4f6f4;color:#294137;font:16px -apple-system;display:grid;place-items:center;height:90vh'><p>正在打开书库…</p></body></html>",
      baseURL: nil)
    registerHotkey()
    startEngine()
  }

  func startEngine() {
    ready = false
    translator?.shutdown()
    translator = nil
    base = nil
    tutorWindow?.orderOut(nil)
    tutorWeb?.configuration.userContentController.removeScriptMessageHandler(forName: "tutorNative")
    tutorWeb?.loadHTMLString("", baseURL: nil)
    tutorWindow = nil
    tutorWeb = nil
    tutorReady = false
    tutorBook = nil
    pendingTutor = nil
    if let palm = palm {
      palm.stopHotkeys()
      palm.panel?.orderOut(nil)
      palm.web?.configuration.userContentController.removeScriptMessageHandler(
        forName: "readerNative")
      palm.web?.loadHTMLString("", baseURL: nil)
    }
    palm = nil
    let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS")
    let executable = helper.appendingPathComponent("page-between-engine")
    let native = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/native")
    guard FileManager.default.isExecutableFile(atPath: executable.path) else {
      showFailure("应用组件不完整，请重新安装页间。", retry: false)
      return
    }
    do {
      try FileManager.default.createDirectory(
        at: support.appendingPathComponent("Logs"), withIntermediateDirectories: true)
      let log = support.appendingPathComponent("Logs/engine.log")
      if !FileManager.default.fileExists(atPath: log.path) {
        FileManager.default.createFile(atPath: log.path, contents: nil)
      }
      let errorLog = try FileHandle(forWritingTo: log)
      try errorLog.seekToEnd()
      let process = Process()
      let pipe = Pipe()
      var environment = ProcessInfo.processInfo.environment
      environment["PAGE_BETWEEN_SESSION"] = session
      environment["PAGE_BETWEEN_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
      environment["PAGE_BETWEEN_APP"] = "1"
      environment["PAGE_BETWEEN_NATIVE_DIR"] = native.path
      environment["PATH"] =
        Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks/bin").path
        + ":/usr/bin:/bin"
      environment["TESSDATA_PREFIX"] =
        Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/tessdata").path
      environment["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"
      process.environment = environment
      process.executableURL = executable
      process.currentDirectoryURL = support
      process.arguments = ["--port", "0"] + (demo ? ["--demo"] : [])
      process.standardOutput = pipe
      process.standardError = errorLog
      self.engine = process
      self.output = pipe
      outputBuffer = Data()
      pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
        let data = handle.availableData
        if data.isEmpty {
          handle.readabilityHandler = nil
          return
        }
        DispatchQueue.main.async {
          guard let self = self, self.engine === process else { return }
          self.outputBuffer.append(data)
          guard self.outputBuffer.count < 16384 else { return }
          while let newline = self.outputBuffer.firstIndex(of: 10) {
            let line = self.outputBuffer[..<newline]
            self.outputBuffer.removeSubrange(...newline)
            if let value = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              value["ready"] as? Bool == true, let port = value["port"] as? Int,
              (1...65535).contains(port)
            {
              self.engineReady(port, process: process)
            }
          }
        }
      }
      process.terminationHandler = { [weak self] stopped in
        DispatchQueue.main.async {
          guard let self = self, self.engine === stopped, !self.quitting else { return }
          self.ready = false
          self.showFailure("阅读服务已停止。书籍和已保存的位置仍在本机，可以重新启动。", retry: true)
        }
      }
      try process.run()
      DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in
        guard let self = self, self.engine === process, self.base == nil, !self.quitting else {
          return
        }
        self.engine = nil
        self.stopEngine(process)
        self.showFailure("阅读服务未能启动，请重试。", retry: true)
      }
    } catch { showFailure("无法启动本机阅读服务，请检查应用与本机存储后重试。", retry: true) }
  }

  func engineReady(_ port: Int, process: Process) {
    guard engine === process, base == nil else { return }
    base = URL(string: "http://127.0.0.1:\(port)/")!
    loadMain("/library")
    writeRuntime()
  }

  func request(_ url: URL) -> URLRequest {
    var request = URLRequest(url: url)
    request.setValue(session, forHTTPHeaderField: "X-Page-Between-Session")
    return request
  }

  func loadMain(_ route: String) {
    guard let base = base, var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)
    else { return }
    parts.fragment = route
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if ready && web.url?.host == base.host && web.url?.port == base.port {
      Task { @MainActor [weak self] in
        guard let self = self else { return }
        _ = try? await self.web.callAsyncJavaScript(
          "if(window.readerFlush) await window.readerFlush(); window.location.hash=route;",
          arguments: ["route": "#" + route], in: nil, contentWorld: .page)
      }
    } else if let url = parts.url {
      web.load(request(url))
    }
  }

  func showFailure(_ message: String, retry: Bool) {
    let alert = NSAlert()
    alert.messageText = "暂时无法打开页间"
    alert.informativeText = message
    alert.addButton(withTitle: retry ? "重新启动" : "退出")
    if retry { alert.addButton(withTitle: "退出") }
    if alert.runModal() == .alertFirstButtonReturn && retry {
      startEngine()
    } else {
      RunLoop.main.perform { NSApp.terminate(nil) }
    }
  }

  func writeRuntime() {
    let data: [String: Any] = [
      "appPID": ProcessInfo.processInfo.processIdentifier,
      "enginePID": engine?.processIdentifier ?? 0,
      "port": base?.port ?? 0, "ready": ready, "demo": demo,
      "hotkeyHandlerStatus": hotkeyHandlerStatus, "hotkeyRegistrationStatus": hotkeyRegistrationStatus,
    ]
    if let bytes = try? JSONSerialization.data(withJSONObject: data) {
      try? bytes.write(to: support.appendingPathComponent("runtime.json"), options: .atomic)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let base = base, let url = webView.url, url.scheme == "http", url.host == base.host,
      url.port == base.port
    else { return }
    writeRuntime()
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if url.scheme == "about"
      || (url.host == base?.host && url.port == base?.port && url.scheme == "http")
    {
      decisionHandler(.allow)
    } else {
      if navigationAction.navigationType == .linkActivated
        && ["https", "http"].contains(url.scheme ?? "")
      {
        NSWorkspace.shared.open(url)
      }
      decisionHandler(.cancel)
    }
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    guard frame.isMainFrame else {
      completionHandler(nil)
      return
    }
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.allowedContentTypes = (supported + ["pbbackup"]).compactMap {
      UTType(filenameExtension: $0)
    }
    panel.beginSheetModal(for: window) { response in
      completionHandler(response == .OK ? panel.urls : nil)
    }
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == base?.host,
      message.frameInfo.securityOrigin.port == base?.port,
      let body = message.body as? [String: Any], let action = body["action"] as? String
    else { return }
    if message.webView === tutorWeb {
      if action == "ready" { tutorReady = true; deliverTutor() }
      if action == "close" { tutorWindow?.performClose(nil) }
      if action == "settings" { loadMain("/settings/ai") }
      if action == "source", let book = body["book"] as? String,
        validBookID(book), let position = body["position"] as? [String: Any],
        let index = position["index"] as? Int, index > 0
      {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor [weak self] in
          guard let self = self else { return }
          _ = try? await self.web.callAsyncJavaScript(
            "await window.readerOpenTutorSource(book, position);",
            arguments: ["book": book, "position": position], in: nil, contentWorld: .page)
        }
      }
      return
    }
    if action == "translate" { showTranslation(body, from: message.webView); return }
    if action == "tutor" { showTutor(body); return }
    if action == "ready" {
      ready = true
      writeRuntime()
      importPendingFiles()
      return
    }
    if action == "saveExport", let path = body["path"] as? String,
      let name = body["name"] as? String
    {
      saveExport(path: path, name: name)
      return
    }
    if action == "revealLibrary" {
      NSWorkspace.shared.open(support)
      return
    }
    if action == "restartLibrary" {
      restartLibrary()
      return
    }
    if action == "palm", let book = body["book"] as? String,
      book.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$", options: .regularExpression) != nil,
      let base = base, var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)
    {
      parts.queryItems = [
        URLQueryItem(name: "mode", value: "palm"), URLQueryItem(name: "book", value: book),
      ]
      guard let url = parts.url else { return }
      if palm == nil {
        palm = PalmDelegate(
          address: url, statusFile: support.appendingPathComponent("Library/palm-window.json"),
          standalone: false, session: session)
        palm?.showMainSettings = { [weak self] section in self?.loadMain("/settings/" + section) }
        palm?.showTutor = { [weak self] request in self?.showTutor(request) }
        palm?.showTranslation = { [weak self] request, view in self?.showTranslation(request, from: view) }
      }
      palm?.configureHotkeys(body["keys"] as? String ?? "arrows")
      palm?.show(url)
    }
  }

  func validBookID(_ book: String) -> Bool {
    book.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$", options: .regularExpression) != nil
  }

  func showTranslation(_ request: [String: Any], from view: WKWebView?) {
    guard let base = base else { return }
    if translator == nil {
      translator = TranslationWindow(base: base, session: session, dataStore: web.configuration.websiteDataStore)
      translator?.action = { [weak self] body in
        guard let self = self, let action = body["action"] as? String else { return }
        if action == "settings" { self.loadMain("/settings/translation") }
        if action == "tutor" { self.showTutor(body) }
        if action == "source", let book = body["book"] as? String, self.validBookID(book),
          let position = body["position"] as? [String: Any], let index = position["index"] as? Int, index > 0 {
          self.window.makeKeyAndOrderFront(nil)
          NSApp.activate(ignoringOtherApps: true)
          Task { @MainActor [weak self] in
            guard let self = self else { return }
            _ = try? await self.web.callAsyncJavaScript("await window.readerOpenTutorSource(book, position);",
              arguments: ["book": book, "position": position], in: nil, contentWorld: .page)
          }
        }
      }
    }
    translator?.show(request, from: view)
  }

  func showTutor(_ request: [String: Any]) {
    guard let base = base, let context = request["context"] as? [String: Any],
      let book = context["book"] as? String, validBookID(book),
      context["source"] is [String: Any], JSONSerialization.isValidJSONObject(context),
      let bytes = try? JSONSerialization.data(withJSONObject: context), bytes.count <= 12 * 1024 * 1024
    else { return }
    if tutorWindow?.isVisible == false, tutorReady, tutorBook == book,
      request["history"] as? Bool == true
    {
      tutorWindow?.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    tutorBook = book
    pendingTutor = ["context": context, "history": request["history"] as? Bool ?? false]
    if tutorWindow == nil {
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = web.configuration.websiteDataStore
      configuration.userContentController.add(self, name: "tutorNative")
      let view = WKWebView(frame: .zero, configuration: configuration)
      view.navigationDelegate = self
      view.uiDelegate = self
      let panel = NSWindow(
        contentRect: NSRect(x: window.frame.maxX - 80, y: window.frame.minY + 60, width: 500, height: 720),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
      panel.title = "书内答疑 · 页间"
      panel.minSize = NSSize(width: 360, height: 480)
      panel.isMovable = true
      panel.isReleasedWhenClosed = false
      panel.contentView = view
      panel.setFrameAutosaveName(demo ? "PageBetweenDemoTutor" : "PageBetweenTutor")
      let restored = panel.setFrameUsingName(demo ? "PageBetweenDemoTutor" : "PageBetweenTutor")
      if !restored, let screen = window.screen?.visibleFrame {
        let origin = NSPoint(x: max(screen.minX, min(panel.frame.minX, screen.maxX - panel.frame.width)),
                             y: max(screen.minY, min(panel.frame.minY, screen.maxY - panel.frame.height)))
        panel.setFrameOrigin(origin)
      }
      tutorWindow = panel
      tutorWeb = view
      tutorReady = false
      var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
      parts.queryItems = [URLQueryItem(name: "mode", value: "tutor")]
      view.load(self.request(parts.url!))
    }
    tutorWindow?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    deliverTutor()
  }

  func deliverTutor() {
    guard tutorReady, let request = pendingTutor, let view = tutorWeb else { return }
    pendingTutor = nil
    Task { @MainActor in
      _ = try? await view.callAsyncJavaScript("window.readerTutorReceive(request);",
        arguments: ["request": request], in: nil, contentWorld: .page)
    }
  }

  func saveExport(path: String, name: String) {
    guard
      path.range(of: "^/api/downloads/[0-9a-f]{32}\\.(epub|pbbackup)$", options: .regularExpression)
        != nil,
      base != nil
    else { return }
    let panel = NSSavePanel()
    panel.title = "保存导出文件"
    panel.nameFieldStringValue = URL(fileURLWithPath: name).lastPathComponent
    panel.canCreateDirectories = true
    panel.beginSheetModal(for: window) { [weak self] response in
      guard response == .OK, let destination = panel.url, let self = self else { return }
      Task { @MainActor in
        do {
          try await self.writeExport(path: path, destination: destination)
          _ = try? await self.web.evaluateJavaScript(
            "window.dispatchEvent(new Event('native-file-saved'))")
        } catch {
          let alert = NSAlert()
          alert.messageText = "文件未能保存"
          alert.informativeText = "请选择可写入的位置后重新导出；书库中的原文件保留。"
          await alert.beginSheetModal(for: self.window)
        }
      }
    }
  }

  func writeExport(path: String, destination: URL) async throws {
    guard destination.isFileURL,
      path.range(of: "^/api/downloads/[0-9a-f]{32}\\.(epub|pbbackup)$", options: .regularExpression)
        != nil,
      let base = base, let url = URL(string: path, relativeTo: base)?.absoluteURL
    else {
      throw NSError(domain: "Export", code: 0)
    }
    var request = self.request(url)
    request.timeoutInterval = 300
    let (temporary, response) = try await URLSession.shared.download(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw NSError(domain: "Export", code: 1)
    }
    let staged = destination.deletingLastPathComponent().appendingPathComponent(
      "." + UUID().uuidString + ".download")
    defer { try? FileManager.default.removeItem(at: staged) }
    try FileManager.default.copyItem(at: temporary, to: staged)
    if FileManager.default.fileExists(atPath: destination.path) {
      _ = try FileManager.default.replaceItemAt(destination, withItemAt: staged)
    } else {
      try FileManager.default.moveItem(at: staged, to: destination)
    }
  }

  func stopEngine(_ process: Process?) {
    guard let process = process, process.isRunning else { return }
    let pid = process.processIdentifier
    if getpgid(pid) == pid { kill(-pid, SIGTERM) } else { process.terminate() }
  }

  func restartLibrary() {
    guard !restarting, !quitting else { return }
    restarting = true
    Task { @MainActor [weak self] in
      guard let self = self, !self.quitting else { return }
      defer { self.restarting = false }
      for view in [self.web, self.palm?.web].compactMap({ $0 }) {
        _ = try? await view.callAsyncJavaScript(
          "if(window.readerFlush) await window.readerFlush();", arguments: [:], in: nil,
          contentWorld: .page)
      }
      let process = self.engine
      self.engine = nil
      self.ready = false
      self.base = nil
      self.output?.fileHandleForReading.readabilityHandler = nil
      self.stopEngine(process)
      self.web.loadHTMLString(
        "<html><body style='background:#f4f6f4;color:#294137;font:16px -apple-system;display:grid;place-items:center;height:90vh'><p>正在重新打开并校验书库…</p></body></html>",
        baseURL: nil)
      for _ in 0..<50 {
        if process?.isRunning != true { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      if let process = process, process.isRunning {
        let pid = process.processIdentifier
        if getpgid(pid) == pid { kill(-pid, SIGKILL) } else { kill(pid, SIGKILL) }
      }
      if !self.quitting { self.startEngine() }
    }
  }

  func application(_ sender: NSApplication, openFiles filenames: [String]) {
    pendingFiles += filenames.map { URL(fileURLWithPath: $0) }.filter {
      supported.contains($0.pathExtension.lowercased())
    }
    sender.reply(toOpenOrPrint: .success)
    importPendingFiles()
  }

  func importPendingFiles() {
    guard ready, !importing, !pendingFiles.isEmpty, let base = base else { return }
    importing = true
    let files = pendingFiles
    pendingFiles = []
    Task { @MainActor [weak self] in
      guard let self = self else { return }
      do {
        for file in files {
          guard file.isFileURL,
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0,
            size <= 200 * 1024 * 1024
          else {
            throw NSError(domain: "Import", code: 1)
          }
          var parts = URLComponents(
            url: base.appendingPathComponent("api/import"), resolvingAgainstBaseURL: false)!
          parts.queryItems = [
            URLQueryItem(name: "name", value: file.lastPathComponent),
            URLQueryItem(
              name: "parse",
              value: ["pdf", "txt"].contains(file.pathExtension.lowercased()) ? "1" : "0"),
          ]
          var request = self.request(parts.url!)
          request.httpMethod = "POST"
          request.timeoutInterval = 180
          request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
          self.window.title = "页间 · 正在导入书籍…"
          let (_, response) = try await URLSession.shared.upload(for: request, fromFile: file)
          guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "Import", code: 2)
          }
        }
        self.loadMain("/library")
      } catch {
        let alert = NSAlert()
        alert.messageText = "部分文件未能导入"
        alert.informativeText = "已完成的书籍会保留。请检查文件格式、大小和可访问性后，从书库重新导入。"
        await alert.beginSheetModal(for: self.window)
      }
      self.window.title = "页间" + (self.demo ? " · 演示" : "")
      self.importing = false
      self.importPendingFiles()
    }
  }

  func buildMenu() {
    let menu = NSMenu()
    let app = NSMenu()
    let file = NSMenu()
    let edit = NSMenu()
    let view = NSMenu()
    let windows = NSMenu()
    func add(_ title: String, _ submenu: NSMenu) {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.submenu = submenu
      menu.addItem(item)
    }
    func action(_ menu: NSMenu, _ title: String, _ selector: Selector, _ key: String = "") {
      let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
      item.target = self
      menu.addItem(item)
    }
    add("页间", app)
    add("文件", file)
    add("编辑", edit)
    add("显示", view)
    add("窗口", windows)
    app.addItem(
      withTitle: "关于页间", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: "")
    app.addItem(.separator())
    action(app, "设置…", #selector(openSettings), ",")
    app.addItem(.separator())
    app.addItem(withTitle: "隐藏页间", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    app.addItem(.separator())
    app.addItem(
      withTitle: "退出页间", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    action(file, "导入书籍…", #selector(openImport), "o")
    file.addItem(.separator())
    file.addItem(
      withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    for (title, selector, key) in [
      ("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"),
      ("全选", "selectAll:", "a"),
    ] {
      edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
    }
    action(view, "书库", #selector(openLibrary), "1")
    action(view, "掌上阅读", #selector(openPalm))
    windows.addItem(
      withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windows.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    NSApp.mainMenu = menu
    NSApp.windowsMenu = windows
  }

  @objc func openLibrary() { loadMain("/library") }
  @objc func openSettings() { loadMain("/settings") }
  @objc func openImport() {
    window.makeKeyAndOrderFront(nil)
    web.evaluateJavaScript("window.dispatchEvent(new Event('app-import'))")
  }
  @objc func openPalm() {
    if palm?.panel?.isVisible == true {
      palm?.panel.performClose(nil)
    } else if let palm = palm {
      palm.show()
    } else {
      web.evaluateJavaScript("window.dispatchEvent(new Event('app-palm'))")
    }
  }

  func registerHotkey() {
    var type = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    hotkeyHandlerStatus = InstallEventHandler(
      GetEventDispatcherTarget(),
      { next, event, context in
        guard let event = event, let context = context else { return noErr }
        var identity = EventHotKeyID()
        let result = GetEventParameter(
          event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
          MemoryLayout<EventHotKeyID>.size, nil, &identity)
        guard result == noErr, identity.signature == 0x594A_4150, identity.id == 1 else { return CallNextEventHandler(next, event) }
        let delegate = Unmanaged<AppDelegate>.fromOpaque(context).takeUnretainedValue()
        DispatchQueue.main.async { delegate.openPalm() }
        return noErr
      }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &hotkeyHandler)
    guard hotkeyHandlerStatus == noErr, hotkeyHandler != nil else { return }
    hotkeyRegistrationStatus = RegisterEventHotKey(
      49, UInt32(controlKey | optionKey | cmdKey), EventHotKeyID(signature: 0x594A_4150, id: 1),
      GetEventDispatcherTarget(), 0, &hotkey)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if window == nil { return .terminateNow }
    if quitting { return .terminateNow }
    quitting = true
    Task { @MainActor [weak self] in
      guard let self = self else {
        sender.reply(toApplicationShouldTerminate: true)
        return
      }
      for view in [self.web, self.palm?.web].compactMap({ $0 }) {
        _ = try? await view.callAsyncJavaScript(
          "if(window.readerFlush) await window.readerFlush();", arguments: [:], in: nil,
          contentWorld: .page)
      }
      self.finishQuit(sender)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.finishQuit(sender) }
    return .terminateLater
  }

  func finishQuit(_ sender: NSApplication) {
    guard !quitReplied else { return }
    quitReplied = true
    palm?.stopHotkeys()
    stopEngine(engine)
    output?.fileHandleForReading.readabilityHandler = nil
    sender.reply(toApplicationShouldTerminate: true)
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let key = hotkey { UnregisterEventHotKey(key) }
    if let handler = hotkeyHandler { RemoveEventHandler(handler) }
    stopEngine(engine)
    try? FileManager.default.removeItem(at: support.appendingPathComponent("runtime.json"))
  }
}

@main struct PageBetweenApplication {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}
