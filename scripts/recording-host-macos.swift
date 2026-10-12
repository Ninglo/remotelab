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
    let hostApp: String?
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
        hostApp = option("--host-app") ?? Bundle.main.object(forInfoDictionaryKey: "RemoteLabRecordingHostApp") as? String
        mode = args.first.flatMap { $0.hasPrefix("--") ? nil : $0 } ?? (hostApp == nil ? "serve" : "panel")
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

final class RecordingClipView: NSClipView {
    override var isFlipped: Bool { true }
}

final class WaveformView: NSView {
    // Display-only floor: leave the captured PCM and uploaded original untouched.
    static let noiseFloorDb = -52.0
    var samples = [Double]() { didSet { needsDisplay = true } }
    func update(samples raw: [Double], rmsDb: Double) {
        // A soft knee keeps quiet backgrounds small without snapping to a flat line.
        let knee = max(0, min(1, (rmsDb + 60) / 12))
        let gain = knee * knee * (3 - 2 * knee)
        samples = raw.map { value in
            let scaled = value > 0 ? max(0, min(1, (20 * log10(value) + 60) / 34)) : 0
            return pow(scaled, 0.65) * gain
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill(); bounds.fill()
        let line = NSBezierPath(); line.lineWidth = 1
        NSColor.tertiaryLabelColor.setStroke()
        line.move(to: NSPoint(x: 0, y: bounds.midY)); line.line(to: NSPoint(x: bounds.width, y: bounds.midY)); line.stroke()
        guard !samples.isEmpty else { return }
        let wave = NSBezierPath(); wave.lineWidth = 3
        NSColor.systemBlue.setStroke()
        for (i, level) in samples.enumerated() {
            let x = (CGFloat(i) + 0.5) * bounds.width / CGFloat(samples.count)
            let h = CGFloat(level) * (bounds.height / 2 - 3)
            wave.move(to: NSPoint(x: x, y: bounds.midY - h)); wave.line(to: NSPoint(x: x, y: bounds.midY + h))
        }
        wave.stroke()
    }
}

final class LaneControls {
    let id: String
    let button: NSButton
    let detail: NSTextField
    let elapsed: NSTextField
    let status: NSTextField
    let indicator: NSView
    let card: NSView
    var state: RecordingPanelState?
    let wave = WaveformView()
    let signal = NSTextField(labelWithString: "尚未采音")
    var busy = false
    var actionError: String?
    init(id: String, button: NSButton, detail: NSTextField, elapsed: NSTextField, status: NSTextField, indicator: NSView, card: NSView) {
        self.id = id; self.button = button; self.detail = detail; self.elapsed = elapsed
        self.status = status; self.indicator = indicator; self.card = card
    }
}

final class RecordingHost: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let settings: HostSettings
    let io = DispatchQueue(label: "remotelab.recording-panel.files")
    var window: NSWindow!
    var footer: NSTextField!
    var historyStack: NSStackView!
    var historyCount: NSTextField!
    var historySummary: NSTextField!
    var historyKey = ""
    var controls = [String: LaneControls]()
    var service: Process?
    var daemonPID: Int32?
    var daemonObserver: DispatchSourceProcess?
    var ownsDaemon = false
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
    var lastMeter: [String: Any]?
    var announced = Set<String>()
    var cuePlayer: AVAudioPlayer?
    var notice: NSPanel?
    var noticeText: NSTextField?
    var lastNoticeLane: String?

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
        let width: CGFloat = 920
        let height = min(max(520, CGFloat(lanes.count) * 220 + 120), NSScreen.main.map { $0.visibleFrame.height - 80 } ?? 700)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = settings.mode == "preview" ? "录音窗口预览（不会录音）" : "讨论录音"
        window.minSize = NSSize(width: 820, height: 420); window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.delegate = self; window.backgroundColor = .windowBackgroundColor; window.level = .floating
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 16, right: 20)
        let header = NSStackView(); header.orientation = .horizontal; header.alignment = .centerY
        let title = text("讨论录音", size: 20); title.font = .boldSystemFont(ofSize: 20)
        let pin = NSButton(checkboxWithTitle: "置顶", target: self, action: #selector(pinChanged(_:)))
        pin.font = .systemFont(ofSize: 12)
        pin.state = .on
        header.addArrangedSubview(title); header.addArrangedSubview(NSView()); header.addArrangedSubview(pin)
        stack.addArrangedSubview(header)
        for lane in lanes {
            guard let id = lane["id"] as? String else { continue }
            let card = NSStackView(); card.orientation = .vertical; card.alignment = .leading; card.spacing = 10
            card.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
            card.wantsLayer = true; card.layer?.cornerRadius = 12
            let label = text(lane["label"] as? String ?? id, size: 15); label.font = .boldSystemFont(ofSize: 15)
            let indicator = NSView(); indicator.wantsLayer = true; indicator.layer?.cornerRadius = 4
            indicator.widthAnchor.constraint(equalToConstant: 8).isActive = true
            indicator.heightAnchor.constraint(equalToConstant: 8).isActive = true
            let status = text("正在确认状态", size: 13, color: .secondaryLabelColor)
            let elapsed = text("", size: 14)
            elapsed.font = .monospacedDigitSystemFont(ofSize: 14, weight: .medium)
            let heading = NSStackView(views: [indicator, label, status, NSView(), elapsed])
            heading.orientation = .horizontal; heading.alignment = .centerY; heading.spacing = 8
            let button = NSButton(title: "暂不可用", target: self, action: #selector(lanePressed(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(id); button.isBordered = false
            button.wantsLayer = true; button.layer?.cornerRadius = 8; button.font = .systemFont(ofSize: 15, weight: .semibold)
            button.setButtonType(.momentaryPushIn); button.isEnabled = false
            let detail = text("等待录音服务", size: 12, color: .secondaryLabelColor)
            detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            button.setContentCompressionResistancePriority(.required, for: .horizontal)
            let info = NSStackView(views: [detail, NSView(), button]); info.orientation = .horizontal; info.alignment = .centerY; info.spacing = 12
            card.addArrangedSubview(heading); card.addArrangedSubview(info)
            stack.addArrangedSubview(card)
            for view in [heading, info] { view.translatesAutoresizingMaskIntoConstraints = false; view.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -32).isActive = true }
            button.heightAnchor.constraint(equalToConstant: 40).isActive = true
            button.widthAnchor.constraint(equalToConstant: 112).isActive = true
            card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
            let control = LaneControls(id: id, button: button, detail: detail, elapsed: elapsed, status: status, indicator: indicator, card: card)
            card.addArrangedSubview(control.wave); card.addArrangedSubview(control.signal)
            control.wave.heightAnchor.constraint(equalToConstant: 54).isActive = true
            control.wave.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -32).isActive = true
            control.signal.font = .systemFont(ofSize: 12); control.signal.textColor = .secondaryLabelColor
            controls[id] = control
        }
        footer = text("按一次开始，再按一次停止。停止后自动回传。", size: 12, color: .secondaryLabelColor)
        stack.addArrangedSubview(footer)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        footer.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        let scroll = NSScrollView(); scroll.contentView = RecordingClipView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = true
        scroll.backgroundColor = .windowBackgroundColor
        scroll.documentView = stack
        let sidebar = NSStackView(); sidebar.orientation = .vertical; sidebar.alignment = .leading; sidebar.spacing = 8
        sidebar.edgeInsets = NSEdgeInsets(top: 20, left: 16, bottom: 16, right: 16)
        sidebar.wantsLayer = true; sidebar.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        historyCount = text("录音记录", size: 18); historyCount.font = .boldSystemFont(ofSize: 18)
        historySummary = text("正在读取", size: 12, color: .secondaryLabelColor)
        sidebar.addArrangedSubview(historyCount); sidebar.addArrangedSubview(historySummary)
        let historyScroll = NSScrollView(); historyScroll.contentView = RecordingClipView(); historyScroll.hasVerticalScroller = true; historyScroll.drawsBackground = false
        historyStack = NSStackView(); historyStack.orientation = .vertical; historyStack.alignment = .leading; historyStack.spacing = 10
        historyScroll.documentView = historyStack; sidebar.addArrangedSubview(historyScroll)
        historyStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            historyStack.widthAnchor.constraint(equalTo: historyScroll.contentView.widthAnchor),
            historyStack.topAnchor.constraint(equalTo: historyScroll.contentView.topAnchor),
            historyStack.leadingAnchor.constraint(equalTo: historyScroll.contentView.leadingAnchor),
            historyScroll.widthAnchor.constraint(equalTo: sidebar.widthAnchor, constant: -32),
            historyCount.widthAnchor.constraint(equalTo: historyScroll.widthAnchor),
            historySummary.widthAnchor.constraint(equalTo: historyScroll.widthAnchor)
        ])
        historyScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        let content = NSView(); window.contentView = content
        for view in [scroll, sidebar] { content.addSubview(view); view.translatesAutoresizingMaskIntoConstraints = false }
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor), scroll.topAnchor.constraint(equalTo: content.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor), scroll.trailingAnchor.constraint(equalTo: sidebar.leadingAnchor),
            sidebar.trailingAnchor.constraint(equalTo: content.trailingAnchor), sidebar.topAnchor.constraint(equalTo: content.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: content.bottomAnchor), sidebar.widthAnchor.constraint(equalToConstant: 340)
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor).isActive = true
        stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor).isActive = true
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu(); let item = NSMenuItem(); menu.addItem(item)
        let submenu = NSMenu(); submenu.addItem(withTitle: "退出录音程序", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); item.submenu = submenu; NSApp.mainMenu = menu
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.renderElapsed(); self?.renderMeters() }
        render()
    }

    @objc func pinChanged(_ sender: NSButton) { window.level = sender.state == .on ? .floating : .normal }

    func startService() {
        if settings.mode == "preview" { observeDirectory(); refresh(); return }
        guard config["enabled"] as? Bool == true else { serviceError = "录音未启用，请先完成配置"; render(); return }
        if settings.mode == "panel" {
            guard let hostApp = settings.hostApp else { serviceError = "尚未指定已授权的录音程序"; render(); return }
            observeDirectory()
            io.async {
                let running = self.probeService()
                DispatchQueue.main.async {
                    if running { self.refresh() }
                    else { self.launchProcess("/usr/bin/open", ["-W", "-n", "-g", hostApp, "--args", "serve", "--root", self.settings.root.path]); self.ownsDaemon = true; self.refresh() }
                }
            }
            return
        }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { serviceError = "需要为 RemoteLab Recording 允许麦克风权限"; render(); return }
        if !(config["bindings"] as? [Any] ?? []).isEmpty && IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
            serviceError = "需要为 RemoteLab Recording 允许输入监控权限"; render(); return
        }
        observeDirectory()
        launchProcess(settings.node, [settings.cli, "recording", "serve", "--root", settings.root.path])
        refresh()
    }

    func launchProcess(_ executable: String, _ arguments: [String]) {
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments; process.environment = settings.environment
        let output = Pipe(); process.standardOutput = output; process.standardError = output
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            // The daemon emits only its readiness and launch errors here, never upload credentials.
            FileHandle.standardError.write(data)
        }
        process.terminationHandler = { process in
            DispatchQueue.main.async {
                if self.settings.mode == "panel", self.daemonPID != nil, !self.shuttingDown { return }
                self.serviceError = process.terminationStatus == 0 ? "录音服务已停止，原音保留在本机" : "录音服务异常退出，请查看录音日志"
                self.render()
                if self.quitWhenStopped { NSApp.reply(toApplicationShouldTerminate: true) }
            }
        }
        do {
            try process.run(); service = process
            for signalNumber in [SIGTERM, SIGINT] {
                signal(signalNumber, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
                source.setEventHandler {
                    // AppKit's terminateLater spins a nested run loop. Enter from a run-loop
                    // event so it can still deliver GCD process-exit callbacks and finish quitting.
                    RunLoop.main.perform(inModes: [.common]) { NSApp.terminate(nil) }
                }; source.resume(); signals.append(source)
            }
        } catch { serviceError = "无法启动录音服务：\(error.localizedDescription)"; render() }
    }

    // Runs on the file queue. This is a one-time socket-backed liveness check,
    // not periodic polling and not a permission-bearing audio process.
    func probeService() -> Bool {
        let process = Process(); process.executableURL = URL(fileURLWithPath: settings.node)
        process.arguments = [settings.cli, "recording", "status", "--root", settings.root.path]
        process.environment = settings.environment
        let output = Pipe(); process.standardOutput = output; process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["running"] as? Bool == true
        } catch { return false }
    }

    func adoptDaemon(_ pid: Int32) {
        if daemonPID == pid { return }
        // A recorder opened independently after the launched app exited is attached,
        // not owned by this panel. Closing the panel must leave it running.
        if ownsDaemon && service?.isRunning != true { ownsDaemon = false }
        daemonObserver?.cancel(); daemonPID = pid
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler {
            guard self.daemonPID == pid else { return }
            self.daemonPID = nil; self.serviceError = "录音服务已停止，原音保留在本机"; self.render()
            if self.quitWhenStopped { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        source.resume(); daemonObserver = source
        if shuttingDown && ownsDaemon { kill(pid, SIGTERM) }
    }

    func observeDirectory() {
        let fd = open(settings.root.path, O_EVTONLY)
        guard fd >= 0 else { readError = "无法监听录音状态文件"; render(); return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: io)
        source.setEventHandler { [weak self] in self?.readSnapshot() }
        source.setCancelHandler { close(fd) }; source.resume(); watcher = source
    }

    func refresh() { io.async { self.readSnapshot() } }
    func applicationDidBecomeActive(_ notification: Notification) {
        guard settings.mode == "panel", daemonPID != nil, !shuttingDown else { return }
        io.async { self.readSnapshot(verifyService: true) }
    }
    func readSnapshot(verifyService: Bool = false) {
        do {
            let data = try Data(contentsOf: settings.root.appendingPathComponent("status.json"))
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NSError(domain: "Recording", code: 2) }
            let meter = (try? Data(contentsOf: settings.root.appendingPathComponent("meter.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let candidate = (value["pid"] as? NSNumber)?.int32Value
            let verified = settings.mode != "panel" || (candidate != nil && candidate! > 0 && kill(candidate!, 0) == 0 && ((!verifyService && candidate == daemonPID) || probeService()))
            DispatchQueue.main.async {
                if self.lastSnapshot == nil {
                    // Reopening the status panel adopts existing capture without replaying its start cue.
                    self.announced.formUnion((value["active"] as? [[String: Any]] ?? []).compactMap { $0["recordingId"] as? String })
                }
                self.lastSnapshot = value; self.lastMeter = meter; self.readError = verified ? nil : "录音服务尚未就绪，请重新打开窗口"
                if self.settings.mode == "panel", verified, let pid = candidate {
                    // A verified live socket supersedes a previous exit/launch error.
                    self.serviceError = nil
                    self.adoptDaemon(pid)
                }
                self.render()
            }
        } catch {
            DispatchQueue.main.async { self.readError = "尚未读到本次服务的状态"; self.render() }
        }
    }

    func render() {
        let preview = settings.mode == "preview"
        let running = preview || ((settings.mode == "panel" ? daemonPID != nil || service?.isRunning == true : service?.isRunning == true) && !shuttingDown)
        let pid = preview ? (lastSnapshot?["pid"] as? NSNumber)?.int32Value : settings.mode == "panel" ? daemonPID : service?.processIdentifier
        for lane in controls.values {
            let state = shuttingDown ? RecordingPanelState(title: "正在停止并保存", detail: "保存完成后退出", action: nil, tone: "starting", startedAt: nil) : RecordingPanelState.project(laneID: lane.id, snapshot: lastSnapshot, servicePID: pid, serviceRunning: running, error: serviceError ?? readError)
            let previousTone = lane.state?.tone
            lane.state = state
            if !preview, state.tone == "recording",
               let active = (lastSnapshot?["active"] as? [[String: Any]])?.first(where: { $0["laneId"] as? String == lane.id }),
               let id = active["recordingId"] as? String, !announced.contains(id) {
                announced.insert(id); showNotice("录音已开始", laneID: lane.id, started: true)
            } else if !preview, previousTone == "recording", state.tone != "recording" {
                cuePlayer?.stop()
                let last = (lastSnapshot?["records"] as? [[String: Any]])?.filter { $0["laneId"] as? String == lane.id }.max { ($0["startedAt"] as? String ?? "") < ($1["startedAt"] as? String ?? "") }
                let message = state.action != "start" ? state.title : last?["status"] as? String == "failed" ? "录音失败 · 请检查设备" : last?["interrupted"] as? Bool == true ? "录音中断 · 已保留采到的音频" : "录音已结束 · 原音已保存"
                showNotice(message, laneID: lane.id, started: false)
            }
            lane.status.stringValue = state.title
            lane.button.title = lane.busy ? "处理中…" : state.action == "stop" ? "停止并保存" : state.action == "start" ? "开始录音" : "暂不可用"
            lane.button.isEnabled = !preview && !lane.busy && state.action != nil
            let red = state.tone == "recording"
            let warning = ["warning", "starting", "unknown"].contains(state.tone)
            let color: NSColor = red ? .systemRed : warning ? .systemOrange : .systemBlue
            lane.button.layer?.backgroundColor = (lane.button.isEnabled ? color : .tertiaryLabelColor).cgColor
            lane.button.contentTintColor = .white
            lane.indicator.layer?.backgroundColor = (red || warning ? color : .tertiaryLabelColor).cgColor
            lane.status.textColor = red ? .systemRed : .secondaryLabelColor
            lane.card.layer?.backgroundColor = (red ? NSColor.systemRed.withAlphaComponent(0.06) : NSColor.controlBackgroundColor).cgColor
            lane.detail.stringValue = lane.actionError ?? state.detail
        }
        let localOnly = config["submissionMode"] as? String == "local"
        footer?.stringValue = preview ? "界面预览：按钮不会开始录音。" : serviceError ?? (shuttingDown ? "正在保存并退出，请稍候…" : localOnly ? "按小键盘或点按钮启停。只保存在本机，暂不上传。" : "按小键盘或点按钮启停。停止后自动回传。")
        let hasChord = (config["bindings"] as? [[String: Any]])?.contains(where: { $0["keys"] != nil }) == true
        if hasChord && !preview && serviceError == nil && !shuttingDown {
            footer?.stringValue = "1号键开始 · 三键同时按下结束。" + (localOnly ? "原音保存在本机。" : "结束后保存并回传。")
        }
        let hasDouble = (config["bindings"] as? [[String: Any]])?.contains(where: { $0["gesture"] as? String == "double" }) == true
        if hasDouble && !preview && serviceError == nil && !shuttingDown {
            footer?.stringValue = (config["keypadHint"] as? String ?? "开始键单按开始 · 结束键双击结束。") + (localOnly ? "仅本地保存。" : "结束后保存并回传。")
        }
        renderHistory(serviceRunning: running)
        renderElapsed(); renderMeters()
        let projection = controls.values.sorted { $0.id < $1.id }.map {
            ["laneId": $0.id, "title": $0.status.stringValue, "buttonTitle": $0.button.title, "detail": $0.detail.stringValue,
             "tone": $0.state?.tone ?? "unknown", "enabled": $0.button.isEnabled,
             "action": $0.state?.action ?? ""] as [String: Any]
        }
        let viewState: [String: Any] = ["lanes": projection, "serviceRunning": running, "preview": preview, "recordingHistory": historySummary?.stringValue ?? ""]
        let bytes = (try? JSONSerialization.data(withJSONObject: viewState, options: [.sortedKeys])) ?? Data()
        let key = String(data: bytes, encoding: .utf8) ?? ""
        if key != lastRenderKey {
            lastRenderKey = key; emit(viewState)
            if let path = settings.snapshot { saveSnapshot(path) }
        }
    }

    func recordingTime(_ raw: String?) -> String {
        guard let raw else { return "—" }
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let date else { return "—" }
        let format = DateFormatter(); format.dateFormat = "MM月dd日 HH:mm:ss"
        return format.string(from: date)
    }

    func renderHistory(serviceRunning: Bool) {
        guard historyStack != nil, let snapshot = lastSnapshot else { return }
        let records = (snapshot["records"] as? [[String: Any]] ?? []).sorted { ($0["startedAt"] as? String ?? "") > ($1["startedAt"] as? String ?? "") }
        let activeIDs = Set((snapshot["active"] as? [[String: Any]] ?? []).compactMap { $0["recordingId"] as? String })
        let data = (try? JSONSerialization.data(withJSONObject: ["records": records, "active": activeIDs.sorted(), "running": serviceRunning], options: [.sortedKeys])) ?? Data()
        let key = String(data: data, encoding: .utf8) ?? ""
        guard key != historyKey else { return }; historyKey = key
        let rows = records.map { RecordingRowState.project($0, activeIDs: activeIDs, serviceRunning: serviceRunning) }
        historyCount.stringValue = "录音记录 · \(rows.count) 段"
        let sent = rows.filter { $0.tone == "sent" }.count, pending = rows.filter { $0.tone == "pending" || $0.tone == "warning" }.count
        let local = rows.filter { $0.tone == "local" }.count
        historySummary.stringValue = "录音中 \(activeIDs.count) · 已上传 \(sent)\n待发送/异常 \(pending) · 仅本地 \(local)"
        for view in historyStack.arrangedSubviews { historyStack.removeArrangedSubview(view); view.removeFromSuperview() }
        if rows.isEmpty { historyStack.addArrangedSubview(text("还没有录音，按1号键开始。", size: 13, color: .secondaryLabelColor)) }
        for row in rows {
            let card = NSStackView(); card.orientation = .vertical; card.alignment = .leading; card.spacing = 5
            card.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            card.wantsLayer = true; card.layer?.cornerRadius = 8; card.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            let title = text(row.label, size: 13); title.font = .boldSystemFont(ofSize: 13)
            let color: NSColor = row.tone == "recording" ? .systemRed : row.tone == "warning" ? .systemOrange : row.tone == "sent" ? .systemGreen : .secondaryLabelColor
            let fields = [title, text(row.status, size: 12, color: color),
                          text("开始  " + recordingTime(row.startedAt), size: 12, color: .secondaryLabelColor),
                          text("结束  " + (row.endedAt == nil && row.tone == "recording" ? "录音中" : recordingTime(row.endedAt)), size: 12, color: .secondaryLabelColor),
                          text("发言人  " + row.speaker, size: 12, color: .secondaryLabelColor)]
            for field in fields { card.addArrangedSubview(field); field.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -24).isActive = true }
            card.toolTip = row.id; historyStack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: historyStack.widthAnchor).isActive = true
        }
    }

    func showNotice(_ message: String, laneID: String, started: Bool) {
        if notice == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 110), styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.title = "录音提醒"; panel.level = .statusBar; panel.isReleasedWhenClosed = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; panel.hidesOnDeactivate = false
            let label = text("", size: 22); label.alignment = .center
            label.frame = NSRect(x: 12, y: 30, width: 356, height: 55)
            panel.contentView?.addSubview(label); noticeText = label; notice = panel
        }
        lastNoticeLane = laneID; noticeText?.stringValue = message
        noticeText?.textColor = started ? .systemRed : .labelColor
        notice?.center(); notice?.orderFrontRegardless()
        window.deminiaturize(nil); window.orderFrontRegardless()
        emit(["feedback": message, "laneId": laneID, "at": ISO8601DateFormatter().string(from: Date())])
        if started || message == "录音已结束 · 原音已保存" {
            let cue = settings.root.appendingPathComponent(started ? "cues/started.mp3" : "cues/stopped.mp3")
            do {
                cuePlayer = try AVAudioPlayer(contentsOf: cue); cuePlayer?.prepareToPlay()
                if cuePlayer?.play() == true { emit(["feedbackAudio": started ? "started" : "stopped", "laneId": laneID]) }
                else { throw NSError(domain: "RecordingFeedback", code: 1) }
            } catch {
                NSSound(named: started ? "Glass" : "Pop")?.play()
                emit(["feedbackAudioError": started ? "开始语音不可用，已用系统提示音" : "结束语音不可用，已用系统提示音"])
            }
        } else { NSSound(named: "Pop")?.play() }
    }

    func renderMeters() {
        let meterPID = (lastMeter?["pid"] as? NSNumber)?.int32Value
        let statusPID = (lastSnapshot?["pid"] as? NSNumber)?.int32Value
        for lane in controls.values {
            guard lane.state?.tone == "recording" else { lane.wave.samples = []; lane.signal.stringValue = "尚未采音"; continue }
            let active = (lastSnapshot?["active"] as? [[String: Any]])?.first { $0["laneId"] as? String == lane.id }
            let meter = (lastMeter?["active"] as? [[String: Any]])?.first { $0["laneId"] as? String == lane.id && $0["recordingId"] as? String == active?["recordingId"] as? String }
            let timestamp = (meter?["updatedAt"] as? NSNumber)?.doubleValue ?? 0
            guard meterPID == statusPID, Date().timeIntervalSince1970 * 1000 - timestamp < 2000 else {
                lane.wave.samples = []; lane.signal.stringValue = "未收到实时音频 · 请检查接收器"
                lane.signal.textColor = .systemOrange; lane.status.stringValue = "等待音频"; lane.indicator.layer?.backgroundColor = NSColor.systemOrange.cgColor
                if lastNoticeLane == lane.id { noticeText?.stringValue = "录音中 · 等待音频输入" }
                continue
            }
            lane.status.stringValue = "正在录音"; lane.indicator.layer?.backgroundColor = NSColor.systemRed.cgColor
            let peak = (meter?["peak"] as? NSNumber)?.doubleValue ?? 0
            let db = (meter?["rmsDb"] as? NSNumber)?.doubleValue ?? -96
            let quiet = db < WaveformView.noiseFloorDb
            lane.wave.update(samples: meter?["waveform"] as? [Double] ?? [], rmsDb: db)
            lane.signal.stringValue = peak == 0 ? "未检测到声音 · 请检查麦克风电源和连接" : quiet ? "音频已接通 · 当前较安静" : String(format: "检测到明显声音 · 音量 %.1f dBFS", db)
            lane.signal.textColor = peak == 0 ? .systemOrange : .secondaryLabelColor
            if lastNoticeLane == lane.id { noticeText?.stringValue = peak == 0 ? "录音中 · 未检测到声音" : quiet ? "录音中 · 当前较安静" : "录音已开始 · 正在收声" }
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
              let action = lane.state?.action, service?.isRunning == true || daemonPID != nil else { return }
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
                        lane.actionError = "操作没有完成，请重新打开窗口"
                        self.readError = "录音服务未响应，请重新打开窗口"
                        self.render()
                    }
                    self.io.async { self.readSnapshot(verifyService: process.terminationStatus != 0) }
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

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if settings.mode == "panel" { sender.orderOut(nil); return false }
        NSApp.terminate(nil); return false
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if settings.mode == "panel" {
            if ownsDaemon, daemonPID != nil || service?.isRunning == true {
                if !shuttingDown {
                    shuttingDown = true; quitWhenStopped = true; render()
                    if let pid = daemonPID { kill(pid, SIGTERM) }
                }
                return .terminateLater
            }
            daemonObserver?.cancel(); watcher?.cancel(); timer?.invalidate(); return .terminateNow
        }
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
        if settings.mode == "panel", let identifier = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first(where: { $0.processIdentifier != getpid() }) {
            existing.activate(options: [.activateAllWindows])
            return
        }
        if settings.mode == "check" { emit(accessStatus()); return }
        if settings.mode == "permissions" {
            emit(["inputRequestGranted": IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)])
            AVCaptureDevice.requestAccess(for: .audio) { granted in emit(accessStatus()); exit(granted ? 0 : 1) }
            NSApplication.shared.run(); return
        }
        guard ["serve", "panel", "preview"].contains(settings.mode) else { emit(["error": "Use serve, panel, preview, check or permissions"]); exit(1) }
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        app.appearance = NSAppearance(named: .aqua)
        let host = RecordingHost(settings: settings); app.delegate = host
        withExtendedLifetime(host) { app.run() }
    }
}
