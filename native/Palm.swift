import AppKit
import WebKit
import Carbon

final class ReaderPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class PalmDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var panel: ReaderPanel!
    var web: WKWebView!
    var hotkeys: [EventHotKeyRef?] = []
    var eventHandler: EventHandlerRef?
    var hotkeyHandlerStatus: OSStatus = -1
    var hotkeyRegistration: [String: OSStatus] = [:]
    private(set) var shortcutPreset = "arrows"
    var receivedHotkeys = 0
    var lastHotkeyAt: TimeInterval = 0
    var hotkeyDispatchError = ""
    var loaded = false
    var closing = false
    var address: URL
    let statusFile: URL
    var commandNonce = ""
    var readerState: [String:Any] = [:]
    var lastHotkeyWasBackground = false
    let standalone: Bool
    let session: String
    var showMainSettings: ((String) -> Void)?
    var showTranslation: (([String:Any], WKWebView?) -> Void)?
    var showTutor: (([String:Any]) -> Void)?

    init(address: URL, statusFile: URL, standalone: Bool = true, session: String = "") {
        self.address=address;self.statusFile=statusFile;self.standalone=standalone;self.session=session
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        show()
    }

    func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if !session.isEmpty { request.setValue(session, forHTTPHeaderField: "X-Page-Between-Session") }
        return request
    }

    func show(_ url: URL? = nil) {
        if let panel = panel {
            closing=false
            if let url=url, url != address { stopHotkeys();readerState=[:];address=url;loaded=false;web.load(request(url)) }
            else { web.evaluateJavaScript("window.dispatchEvent(new Event('palm-resume'))") }
            panel.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
            writeStatus();return
        }
        if let url=url { address=url }
        if standalone { NSApp.setActivationPolicy(.accessory) }
        let screen=NSScreen.main?.visibleFrame ?? NSRect(x:0,y:0,width:1400,height:900)
        let frame=NSRect(x:screen.maxX-364,y:screen.minY+24,width:344,height:560)
        panel=ReaderPanel(contentRect:frame,styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false)
        panel.title="页间 · 掌上阅读"
        panel.titleVisibility = .visible
        panel.isMovable = true
        panel.titlebarAppearsTransparent=true
        panel.isFloatingPanel=true
        panel.hidesOnDeactivate=false
        panel.level = .floating
        panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary]
        panel.minSize=NSSize(width:224,height:280)
        panel.maxSize=NSSize(width:760,height:1100)
        panel.isReleasedWhenClosed=false
        panel.delegate=self
        panel.setFrameAutosaveName("PageBetweenPalm" + (standalone ? "Standalone" : "App"))
        panel.setFrameUsingName("PageBetweenPalm" + (standalone ? "Standalone" : "App"))
        let configuration=WKWebViewConfiguration()
        if showTranslation != nil {
            configuration.userContentController.addUserScript(WKUserScript(source:"window.readerDetachedTranslation=true;",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        }
        if showTutor != nil {
            configuration.userContentController.addUserScript(WKUserScript(source:"window.readerDetachedTutor=true;",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        }
        configuration.userContentController.add(self,name:"readerNative")
        web=WKWebView(frame:panel.contentView!.bounds,configuration:configuration)
        web.autoresizingMask=[.width,.height]
        web.navigationDelegate=self
        web.setValue(false,forKey:"drawsBackground")
        panel.contentView=web
        web.load(request(address))
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(web)
        NSApp.activate(ignoringOtherApps:true)
        writeStatus()
        if standalone { Timer.scheduledTimer(withTimeInterval:0.5,repeats:true) { [weak self] _ in self?.readCommand() } }
    }

    func configureHotkeys(_ preset: String) {
        guard ["arrows", "letters", "off"].contains(preset) else { return }
        if preset != shortcutPreset { stopHotkeys(); shortcutPreset = preset }
        if panel?.isVisible == true && !closing { registerHotkeys() }
    }

    func registerHotkeys() {
        if shortcutPreset == "off" { return }
        if !hotkeys.isEmpty { return }
        if let handler = eventHandler { RemoveEventHandler(handler); eventHandler = nil }
        hotkeyRegistration.removeAll()
        var type=EventTypeSpec(eventClass:OSType(kEventClassKeyboard),eventKind:UInt32(kEventHotKeyPressed))
        // Receive global shortcuts at the dispatcher before AppKit routes events by focus.
        hotkeyHandlerStatus = InstallEventHandler(GetEventDispatcherTarget(), { next,event,context in
            guard let event=event,let context=context else { return noErr }
            var identity=EventHotKeyID()
            let result = GetEventParameter(event,EventParamName(kEventParamDirectObject),EventParamType(typeEventHotKeyID),nil,MemoryLayout<EventHotKeyID>.size,nil,&identity)
            guard result == noErr, identity.signature == 0x594A504D, (1...2).contains(identity.id) else { return CallNextEventHandler(next, event) }
            let delegate=Unmanaged<PalmDelegate>.fromOpaque(context).takeUnretainedValue()
            delegate.flip(identity.id==1 ? 1 : -1)
            return noErr
        },1,&type,Unmanaged.passUnretained(self).toOpaque(),&eventHandler)
        guard hotkeyHandlerStatus == noErr, eventHandler != nil else { writeStatus(); return }
        let nextKey = UInt32(shortcutPreset == "letters" ? kVK_ANSI_N : kVK_RightArrow)
        let previousKey = UInt32(shortcutPreset == "letters" ? kVK_ANSI_P : kVK_LeftArrow)
        for (id,key) in [(UInt32(1), nextKey), (UInt32(2), previousKey)] {
            var reference: EventHotKeyRef?
            let result=RegisterEventHotKey(key,UInt32(controlKey|optionKey|cmdKey),EventHotKeyID(signature:0x594A504D,id:id),GetEventDispatcherTarget(),0,&reference)
            hotkeyRegistration[id == 1 ? "next" : "previous"] = result
            if result==noErr, reference != nil { hotkeys.append(reference) }
        }
    }

    func flip(_ direction:Int) {
        receivedHotkeys += 1
        lastHotkeyWasBackground = !NSApp.isActive
        lastHotkeyAt = Date().timeIntervalSince1970
        hotkeyDispatchError = ""
        writeStatus()
        DispatchQueue.main.async { [weak self] in
            self?.web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('palm-flip',{detail:\(direction)}))") { [weak self] _, error in
                self?.hotkeyDispatchError = error?.localizedDescription ?? ""
                self?.writeStatus()
            }
        }
    }

    func readCommand() {
        let file=statusFile.deletingLastPathComponent().appendingPathComponent("palm-command.json")
        guard let data=try? Data(contentsOf:file),let values=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let nonce=values["nonce"] as? String,nonce != commandNonce,
              let text=values["url"] as? String,let url=URL(string:text),url.host=="127.0.0.1",url.scheme=="http" else { return }
        commandNonce=nonce
        closing=false
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        guard address != url else {
            web.evaluateJavaScript("window.dispatchEvent(new Event('palm-resume'))")
            return
        }
        Task { @MainActor [weak self] in
            guard let self=self else { return }
            self.stopHotkeys();self.readerState=[:];self.address=url;self.loaded=false;self.web.load(self.request(url));self.writeStatus()
        }
    }

    func writeStatus() {
        guard let panel=panel else { return }
        let content=panel.contentView?.bounds.size ?? panel.frame.size
        let values:[String:Any] = ["visible":panel.isVisible,"loaded":loaded,"width":content.width,"height":content.height,
                                  "x":panel.frame.minX,"y":panel.frame.minY,"alwaysOnTop":panel.level == .floating,
                                  "registeredHotkeys":hotkeys.count,"shortcutPreset":shortcutPreset,"hotkeyHandlerStatus":hotkeyHandlerStatus,"hotkeyRegistration":hotkeyRegistration,"receivedHotkeys":receivedHotkeys,"lastHotkeyAt":lastHotkeyAt,"hotkeyDispatchError":hotkeyDispatchError,"url":address.absoluteString,"pid":ProcessInfo.processInfo.processIdentifier,"reader":readerState,"lastHotkeyWasBackground":lastHotkeyWasBackground]
        if let data=try? JSONSerialization.data(withJSONObject:values,options:.sortedKeys) { try? data.write(to:statusFile,options:.atomic) }
    }

    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) { loaded=true;writeStatus() }
    func windowDidResize(_ notification:Notification) { writeStatus() }
    func windowDidMove(_ notification:Notification) { writeStatus() }
    func windowShouldClose(_ sender:NSWindow)->Bool {
        if closing { return true }
        closing=true
        stopHotkeys()
        Task { @MainActor [weak self] in
            guard let self=self else { return }
            _ = try? await self.web.callAsyncJavaScript("if(window.readerFlush) await window.readerFlush();",arguments:[:],in:nil,contentWorld:.page)
            guard self.closing else { return }
            self.panel.orderOut(nil);self.stopHotkeys();self.writeStatus()
            if self.standalone { NSApp.terminate(nil) }
        }
        return false
    }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == address.host,
              message.frameInfo.securityOrigin.port == address.port else { return }
        guard let body=message.body as? [String:Any],let action=body["action"] as? String else { return }
        if action=="translate" { showTranslation?(body, message.webView);return }
        if action=="tutor" { showTutor?(body);return }
        if action=="close" { panel.performClose(nil) }
        if action=="settings" {
            let section = body["section"] as? String == "translation" ? "translation" : "ai"
            if let showMainSettings=showMainSettings { showMainSettings(section) }
            else if var parts=URLComponents(url:address,resolvingAgainstBaseURL:false) {
                parts.query=nil;parts.fragment="/settings/"+section
                if let url=parts.url { NSWorkspace.shared.open(url) }
            }
        }
        if action=="reader-state",let state=body["reader"] as? [String:Any] { readerState=state;configureHotkeys(state["keys"] as? String ?? "arrows");writeStatus() }
        if action=="resize",let compact=body["compact"] as? Bool {
            let size=compact ? NSSize(width:280,height:440) : NSSize(width:344,height:560)
            let origin=panel.frame.origin
            let right=panel.frame.maxX
            panel.setContentSize(size)
            panel.setFrameOrigin(NSPoint(x:right-panel.frame.width,y:origin.y))
            writeStatus()
        }
        if action=="pin" {
            panel.level=panel.level == .floating ? .normal : .floating
            web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('palm-pin',{detail:\(panel.level == .floating ? "true" : "false")}))")
            writeStatus()
        }
    }
    func applicationWillTerminate(_ notification:Notification) {
        stopHotkeys()
    }
    func stopHotkeys() {
        for reference in hotkeys { if let reference=reference { UnregisterEventHotKey(reference) } }
        hotkeys=[]
        hotkeyRegistration.removeAll()
        hotkeyHandlerStatus = -1
        if let eventHandler=eventHandler { RemoveEventHandler(eventHandler) }
        eventHandler=nil
    }
}

#if PALM_STANDALONE
@main struct PalmApplication {
    static func main() {
        let arguments=CommandLine.arguments
        let address=URL(string:arguments.count>1 ? arguments[1] : "http://127.0.0.1:8778/?mode=palm")!
        let status=URL(fileURLWithPath:arguments.count>2 ? arguments[2] : NSTemporaryDirectory()+"page-between-palm.json")
        let delegate=PalmDelegate(address:address,statusFile:status)
        let app=NSApplication.shared
        app.delegate=delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
#endif
