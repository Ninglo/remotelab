import AppKit
import Foundation
import CoreBluetooth

// Separate Bluetooth permission owner. The microphone/input host is unchanged.
final class LightHost: NSObject, NSApplicationDelegate, CBCentralManagerDelegate {
    var child: Process?
    var signals = [DispatchSourceSignal]()
    var log: FileHandle?
    var central: CBCentralManager?
    func applicationDidFinishLaunching(_ notification: Notification) {
        central = CBCentralManager(delegate: self, queue: .main)
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn && child == nil { launch() }
        else if central.state == .unauthorized || central.state == .unsupported {
            fputs("Bluetooth unavailable: \(central.state.rawValue)\n", stderr)
            exit(1)
        }
    }
    func launch() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count >= 4, args[0] == "--log", args[2] == "--",
              args[1].hasPrefix("/"), args[3].hasPrefix("/") else { exit(2) }
        do {
            if !FileManager.default.fileExists(atPath: args[1]) {
                FileManager.default.createFile(atPath: args[1], contents: nil,
                                              attributes: [.posixPermissions: 0o600])
            }
            log = try FileHandle(forWritingTo: URL(fileURLWithPath: args[1]))
            try log!.seekToEnd()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: args[3])
            process.arguments = Array(args.dropFirst(4))
            process.standardOutput = log
            process.standardError = log
            process.standardInput = FileHandle.nullDevice
            process.terminationHandler = { p in DispatchQueue.main.async { exit(p.terminationStatus) } }
            try process.run()
            child = process
            for number in [SIGTERM, SIGINT] {
                signal(number, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
                source.setEventHandler { [weak self] in self?.stop() }
                source.resume()
                signals.append(source)
            }
        } catch {
            fputs("Light host: \(error)\n", stderr)
            exit(1)
        }
    }
    func stop() {
        if let process = child, process.isRunning { process.terminate() }
        else { exit(0) }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        stop()
        return .terminateLater
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = LightHost()
app.delegate = host
app.run()
