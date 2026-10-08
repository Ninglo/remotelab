import Foundation
import AppKit
import AVFoundation
import IOKit.hid

struct HostSettings {
    let mode: String
    let root: URL
    let cli: String
    let node: String
    let snapshot: String?
    let environment: [String: String]

    init() {
        let args = Array(CommandLine.arguments.dropFirst())
        func option(_ key: String) -> String? {
            guard let index = args.firstIndex(of: key), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let env = ProcessInfo.processInfo.environment
        let config = env["REMOTELAB_CONFIG_DIR"] ?? home.appendingPathComponent(".config/remotelab-hardware-recording").path
        mode = args.first.flatMap { $0.hasPrefix("--") ? nil : $0 } ?? "serve"
        root = URL(fileURLWithPath: option("--root") ?? config + "/recording")
        cli = option("--cli") ?? Bundle.main.object(forInfoDictionaryKey: "RemoteLabCLIPath") as? String ?? home.appendingPathComponent(".remotelab/apps/hardware-recording/cli.js").path
        node = option("--node") ?? Bundle.main.object(forInfoDictionaryKey: "RemoteLabNodePath") as? String ?? "/usr/local/bin/node"
        snapshot = option("--snapshot")
        var childEnv = env
        childEnv["REMOTELAB_CONFIG_DIR"] = config
        childEnv["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment = childEnv
    }
}

func accessStatus() -> [String: Any] {
    ["inputAccessRaw": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent).rawValue,
     "audioAccessRaw": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
     "bundleId": Bundle.main.bundleIdentifier ?? "unbundled"]
}
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}

final class LaneControls {
    let id: String
    let button: NSButton
    let detail: NSTextField
    let elapsed: NSTextField
    var state: RecordingPanelState?
    var busy = false
    var actionError: String?
    init(id: String, button: NSButton, detail: NSTextField, elapsed: NSTextField) {
        self.id = id; self.button = button; self.detail = detail; self.elapsed = elapsed
    }
}

final class RecordingHost: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let settings: HostSettings
    let io = DispatchQueue(label: "remotelab.recording-panel.files")
    var window: NSWindow!
    var footer: NSTextField!
    var controls = [String: LaneControls]()
    var service: Process?
    var watcher: DispatchSourceFileSystemObject?
    var signals = [DispatchSourceSignal]()
    var timer: Timer?
    var shuttingDown = false
    var quitWhenStopped = false
    var serviceError: String?
    var lastSnapshot: [String: Any]?
    var readError: String?
    var config = [String: Any]()
    var lastRenderKey = ""
    let dateParser = ISO8601DateFormatter()

    init(settings: HostSettings) { self.settings = settings; super.init() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        io.async {
            do {
                try FileManager.default.createDirectory(at: self.settings.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let data = try Data(contentsOf: self.settings.root.appendingPathComponent("config.json"))
                guard let config = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let lanes = config["lanes"] as? [[String: Any]], !lanes.isEmpty else { throw NSError(domain: "Recording", code: 1, userInfo: [NSLocalizedDescriptionKey: "请先绑定麦克风和录音通道"] ) }
                DispatchQueue.main.async { self.config = config; self.buildWindow(lanes); self.startService() }
            } catch {
                DispatchQueue.main.async {
                    self.serviceError = "无法读取录音配置：\(error.localizedDescription)"
                    self.buildWindow([["id": "unconfigured", "label": "录音"]]); self.render()
                }
            }
        }
    }

    func text(_ value: String, size: CGFloat, color: NSColor = .labelColor) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.font = .systemFont(ofSize: size); label.textColor = color
        return label
    }

    func buildWindow(_ lanes: [[String: Any]]) {
        let width: CGFloat = 820
        let height = min(CGFloat(lanes.count) * 228 + 156, NSScreen.main.map { $0.visibleFrame.height - 80 } ?? 700)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = settings.mode == "preview" ? "录音窗口预览（不会录音）" : "RemoteLab Recording"
        window.minSize = NSSize(width: 580, height: 360); window.isReleasedWhenClosed = false
        window.delegate = self; window.backgroundColor = .windowBackgroundColor; window.level = .floating
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 18
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 28, bottom: 24, right: 28)
        let header = NSStackView(); header.orientation = .horizontal; header.alignment = .centerY
        let title = text("录音状态", size: 30); title.font = .boldSystemFont(ofSize: 30)
        let pin = NSButton(checkboxWithTitle: "保持窗口置顶", target: self, action: #selector(pinChanged(_:)))
        pin.state = .on
        header.addArrangedSubview(title); header.addArrangedSubview(NSView()); header.addArrangedSubview(pin)
        stack.addArrangedSubview(header)
        for lane in lanes {
            guard let id = lane["id"] as? String else { continue }
            let card = NSStackView(); card.orientation = .vertical; card.alignment = .leading; card.spacing = 8
            let label = text(lane["label"] as? String ?? id, size: 24)
            let button = NSButton(title: "正在确认状态", target: self, action: #selector(lanePressed(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(id); button.isBordered = false
            button.wantsLayer = true; button.layer?.cornerRadius = 14; button.font = .boldSystemFont(ofSize: 44)
            button.setButtonType(.momentaryPushIn); button.isEnabled = false
            let detail = text("等待录音服务", size: 18, color: .secondaryLabelColor)
            let elapsed = text("", size: 22)
            elapsed.font = .monospacedDigitSystemFont(ofSize: 22, weight: .medium)
            let info = NSStackView(views: [detail, NSView(), elapsed]); info.orientation = .horizontal; info.alignment = .centerY
            card.addArrangedSubview(label); card.addArrangedSubview(button); card.addArrangedSubview(info)
            stack.addArrangedSubview(card)
            for view in [button, info] { view.translatesAutoresizingMaskIntoConstraints = false; view.widthAnchor.constraint(equalTo: card.widthAnchor).isActive = true }
            button.heightAnchor.constraint(equalToConstant: 122).isActive = true
            card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -56).isActive = true
            controls[id] = LaneControls(id: id, button: button, detail: detail, elapsed: elapsed)
        }
        footer = text("红色表示正在保存音频。可点击按钮，也可使用已绑定的小键盘。", size: 16, color: .secondaryLabelColor)
        stack.addArrangedSubview(footer)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -56).isActive = true
        footer.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -56).isActive = true
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = true
        scroll.backgroundColor = .windowBackgroundColor
        scroll.documentView = stack; window.contentView = scroll
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor).isActive = true
        stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor).isActive = true
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu(); let item = NSMenuItem(); menu.addItem(item)
        let submenu = NSMenu(); submenu.addItem(withTitle: "退出录音程序", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); item.submenu = submenu; NSApp.mainMenu = menu
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.renderElapsed() }
        render()
    }

    @objc func pinChanged(_ sender: NSButton) { window.level = sender.state == .on ? .floating : .normal }

    func startService() {
        if settings.mode == "preview" { observeDirectory(); refresh(); return }
        guard config["enabled"] as? Bool == true else { serviceError = "录音未启用，请先完成配置"; render(); return }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { serviceError = "需要为 RemoteLab Recording 允许麦克风权限"; render(); return }
        if !(config["bindings"] as? [Any] ?? []).isEmpty && IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
            serviceError = "需要为 RemoteLab Recording 允许输入监控权限"; render(); return
        }
        let process = Process(); process.executableURL = URL(fileURLWithPath: settings.node)
        process.arguments = [settings.cli, "recording", "serve", "--root", settings.root.path]; process.environment = settings.environment
        let output = Pipe(); process.standardOutput = output; process.standardError = output
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            // The daemon emits only its readiness and launch errors here, never upload credentials.
            FileHandle.standardError.write(data)
        }
        process.terminationHandler = { process in
            DispatchQueue.main.async {
                self.serviceError = process.terminationStatus == 0 ? "录音服务已停止，原音保留在本机" : "录音服务异常退出，请查看录音日志"
                self.render()
                if self.quitWhenStopped { NSApp.reply(toApplicationShouldTerminate: true) }
            }
        }
        do {
            try process.run(); service = process; observeDirectory(); refresh()
            for signalNumber in [SIGTERM, SIGINT] {
                signal(signalNumber, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
                source.setEventHandler { NSApp.terminate(nil) }; source.resume(); signals.append(source)
            }
        } catch { serviceError = "无法启动录音服务：\(error.localizedDescription)"; render() }
    }

    func observeDirectory() {
        let fd = open(settings.root.path, O_EVTONLY)
        guard fd >= 0 else { readError = "无法监听录音状态文件"; render(); return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: io)
        source.setEventHandler { [weak self] in self?.readSnapshot() }
        source.setCancelHandler { close(fd) }; source.resume(); watcher = source
    }

    func refresh() { io.async { self.readSnapshot() } }
    func readSnapshot() {
        do {
            let data = try Data(contentsOf: settings.root.appendingPathComponent("status.json"))
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NSError(domain: "Recording", code: 2) }
            DispatchQueue.main.async { self.lastSnapshot = value; self.readError = nil; self.render() }
        } catch {
            DispatchQueue.main.async { self.readError = "尚未读到本次服务的状态"; self.render() }
        }
    }

    func render() {
        let preview = settings.mode == "preview"
        let running = preview || (service?.isRunning == true && !shuttingDown)
        let pid = preview ? (lastSnapshot?["pid"] as? NSNumber)?.int32Value : service?.processIdentifier
        for lane in controls.values {
            let state = RecordingPanelState.project(laneID: lane.id, snapshot: lastSnapshot, servicePID: pid, serviceRunning: running, error: serviceError ?? readError)
            lane.state = state
            lane.button.title = lane.busy ? (state.tone == "recording" || state.tone == "starting" ? "正在停止并保存" : "正在处理") : state.title
            lane.button.isEnabled = !preview && !lane.busy && state.action != nil
            let red = state.tone == "recording"
            let color: NSColor = red ? .systemRed : ["warning", "starting", "unknown"].contains(state.tone) ? .systemOrange.withAlphaComponent(0.16) : .controlBackgroundColor
            lane.button.layer?.backgroundColor = color.cgColor
            lane.button.contentTintColor = red ? .white : .labelColor
            lane.detail.stringValue = lane.actionError ?? state.detail
        }
        footer?.stringValue = preview ? "界面预览：没有启动录音服务，按钮不会开始录音。" : serviceError ?? (shuttingDown ? "正在保存并退出，请稍候…" : "红色表示正在保存音频。可点击按钮，也可使用已绑定的小键盘。")
        renderElapsed()
        let projection = controls.values.sorted { $0.id < $1.id }.map {
            ["laneId": $0.id, "title": $0.button.title, "detail": $0.detail.stringValue,
             "tone": $0.state?.tone ?? "unknown", "enabled": $0.button.isEnabled,
             "action": $0.state?.action ?? ""] as [String: Any]
        }
        let viewState: [String: Any] = ["lanes": projection, "serviceRunning": running, "preview": preview]
        let bytes = (try? JSONSerialization.data(withJSONObject: viewState, options: [.sortedKeys])) ?? Data()
        let key = String(data: bytes, encoding: .utf8) ?? ""
        if key != lastRenderKey {
            lastRenderKey = key; emit(viewState)
            if let path = settings.snapshot { saveSnapshot(path) }
        }
    }

    func renderElapsed() {
        dateParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for lane in controls.values {
            guard lane.state?.tone == "recording", let start = lane.state?.startedAt,
                  let date = dateParser.date(from: start) else { lane.elapsed.stringValue = ""; continue }
            let seconds = max(0, Int(Date().timeIntervalSince(date)))
            lane.elapsed.stringValue = String(format: "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
        }
    }

    @objc func lanePressed(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, let lane = controls[id], !lane.busy,
              let action = lane.state?.action, service?.isRunning == true else { return }
        lane.busy = true; lane.actionError = nil; render()
        let process = Process(); process.executableURL = URL(fileURLWithPath: settings.node)
        process.arguments = [settings.cli, "recording", action, "--lane", id, "--root", settings.root.path]; process.environment = settings.environment
        let output = Pipe(); process.standardOutput = output; process.standardError = output
        // Drain in a worker: a saved manifest can exceed pipe capacity. Never wait on the UI thread.
        do {
            try process.run()
            io.async {
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                DispatchQueue.main.async {
                    lane.busy = false
                    if process.terminationStatus != 0 {
                        lane.actionError = "操作失败，请重试：" + String((String(data: data, encoding: .utf8) ?? "录音服务未响应").suffix(500))
                    }
                    self.refresh()
                }
            }
        } catch { lane.busy = false; lane.actionError = error.localizedDescription; render() }
    }

    func saveSnapshot(_ path: String) {
        guard let view = window?.contentView else { return }
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        if let png = bitmap.representation(using: .png, properties: [:]) { io.async { try? png.write(to: URL(fileURLWithPath: path), options: .atomic) } }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if service?.isRunning == true {
            if !shuttingDown { shuttingDown = true; quitWhenStopped = true; render(); service?.terminate() }
            return .terminateLater
        }
        watcher?.cancel(); timer?.invalidate(); return .terminateNow
    }
}

@main
struct Main {
    static func main() {
        let settings = HostSettings()
        if settings.mode == "check" { emit(accessStatus()); return }
        if settings.mode == "permissions" {
            emit(["inputRequestGranted": IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)])
            AVCaptureDevice.requestAccess(for: .audio) { granted in emit(accessStatus()); exit(granted ? 0 : 1) }
            NSApplication.shared.run(); return
        }
        guard ["serve", "preview"].contains(settings.mode) else { emit(["error": "Use serve, preview, check or permissions"]); exit(1) }
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        app.appearance = NSAppearance(named: .aqua)
        let host = RecordingHost(settings: settings); app.delegate = host
        withExtendedLifetime(host) { app.run() }
    }
}
