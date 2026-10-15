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
    var loaded = false
    var closing = false
    var address: URL
    let statusFile: URL
    var commandNonce = ""
    var readerState: [String:Any] = [:]
    var lastHotkeyWasBackground = false

    init(address: URL, statusFile: URL) { self.address=address;self.statusFile=statusFile }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let screen=NSScreen.main?.visibleFrame ?? NSRect(x:0,y:0,width:1400,height:900)
        let frame=NSRect(x:screen.maxX-364,y:screen.minY+24,width:344,height:560)
        panel=ReaderPanel(contentRect:frame,styleMask:[.titled,.closable,.resizable,.miniaturizable,.fullSizeContentView],backing:.buffered,defer:false)
        panel.title="页间 · 掌上阅读"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent=true
        panel.isFloatingPanel=true
        panel.hidesOnDeactivate=false
        panel.level = .floating
        panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary]
        panel.minSize=NSSize(width:224,height:280)
        panel.maxSize=NSSize(width:760,height:1100)
        panel.isReleasedWhenClosed=false
        panel.delegate=self
        panel.setFrameAutosaveName("PageBetweenPalm")
        let configuration=WKWebViewConfiguration()
        configuration.userContentController.add(self,name:"readerNative")
        web=WKWebView(frame:panel.contentView!.bounds,configuration:configuration)
        web.autoresizingMask=[.width,.height]
        web.navigationDelegate=self
        web.setValue(false,forKey:"drawsBackground")
        panel.contentView=web
        web.load(URLRequest(url:address))
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(web)
        NSApp.activate(ignoringOtherApps:true)
        registerHotkeys()
        writeStatus()
        Timer.scheduledTimer(withTimeInterval:0.5,repeats:true) { [weak self] _ in self?.readCommand() }
    }

    func registerHotkeys() {
        var type=EventTypeSpec(eventClass:OSType(kEventClassKeyboard),eventKind:UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _,event,context in
            guard let event=event,let context=context else { return noErr }
            var identity=EventHotKeyID()
            GetEventParameter(event,EventParamName(kEventParamDirectObject),EventParamType(typeEventHotKeyID),nil,MemoryLayout<EventHotKeyID>.size,nil,&identity)
            let delegate=Unmanaged<PalmDelegate>.fromOpaque(context).takeUnretainedValue()
            delegate.flip(identity.id==1 ? 1 : -1)
            return noErr
        },1,&type,Unmanaged.passUnretained(self).toOpaque(),&eventHandler)
        for (id,key) in [(UInt32(1),UInt32(124)),(UInt32(2),UInt32(123))] {
            var reference: EventHotKeyRef?
            let result=RegisterEventHotKey(key,UInt32(controlKey|optionKey|cmdKey),EventHotKeyID(signature:0x594A504D,id:id),GetApplicationEventTarget(),0,&reference)
            if result==noErr { hotkeys.append(reference) }
        }
    }

    func flip(_ direction:Int) {
        lastHotkeyWasBackground = !NSApp.isActive
        DispatchQueue.main.async { [weak self] in
            self?.web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('palm-flip',{detail:\(direction)}))")
            self?.writeStatus()
        }
    }

    func readCommand() {
        let file=statusFile.deletingLastPathComponent().appendingPathComponent("palm-command.json")
        guard let data=try? Data(contentsOf:file),let values=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let nonce=values["nonce"] as? String,nonce != commandNonce,
              let text=values["url"] as? String,let url=URL(string:text),url.host=="127.0.0.1",url.scheme=="http" else { return }
        commandNonce=nonce
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        guard address != url else {
            web.evaluateJavaScript("window.dispatchEvent(new Event('palm-resume'))")
            return
        }
        Task { @MainActor [weak self] in
            guard let self=self else { return }
            self.address=url;self.loaded=false;self.web.load(URLRequest(url:url));self.writeStatus()
        }
    }

    func writeStatus() {
        guard let panel=panel else { return }
        let content=panel.contentView?.bounds.size ?? panel.frame.size
        let values:[String:Any] = ["visible":panel.isVisible,"loaded":loaded,"width":content.width,"height":content.height,
                                  "x":panel.frame.minX,"y":panel.frame.minY,"alwaysOnTop":panel.level == .floating,
                                  "registeredHotkeys":hotkeys.count,"url":address.absoluteString,"pid":ProcessInfo.processInfo.processIdentifier,"reader":readerState,"lastHotkeyWasBackground":lastHotkeyWasBackground]
        if let data=try? JSONSerialization.data(withJSONObject:values,options:.sortedKeys) { try? data.write(to:statusFile,options:.atomic) }
    }

    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) { loaded=true;writeStatus() }
    func windowDidResize(_ notification:Notification) { writeStatus() }
    func windowDidMove(_ notification:Notification) { writeStatus() }
    func windowShouldClose(_ sender:NSWindow)->Bool {
        if closing { return true }
        closing=true
        Task { @MainActor [weak self] in
            guard let self=self else { return }
            _ = try? await self.web.callAsyncJavaScript("if(window.readerFlush) await window.readerFlush();",arguments:[:],in:nil,contentWorld:.page)
            self.panel.orderOut(nil);self.writeStatus();NSApp.terminate(nil)
        }
        return false
    }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage) {
        guard let body=message.body as? [String:Any],let action=body["action"] as? String else { return }
        if action=="close" { panel.performClose(nil) }
        if action=="reader-state",let state=body["reader"] as? [String:Any] { readerState=state;writeStatus() }
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
        for reference in hotkeys { if let reference=reference { UnregisterEventHotKey(reference) } }
        if let eventHandler=eventHandler { RemoveEventHandler(eventHandler) }
    }
}

let arguments=CommandLine.arguments
let address=URL(string:arguments.count>1 ? arguments[1] : "http://127.0.0.1:8778/?mode=palm")!
let status=URL(fileURLWithPath:arguments.count>2 ? arguments[2] : NSTemporaryDirectory()+"page-between-palm.json")
let delegate=PalmDelegate(address:address,statusFile:status)
let app=NSApplication.shared
app.delegate=delegate
app.run()
