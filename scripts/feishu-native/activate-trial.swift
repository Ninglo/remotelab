import AppKit

guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]) else { exit(1) }
let startupDeadline = Date().addingTimeInterval(10)
var candidate = NSRunningApplication(processIdentifier: pid)
while candidate?.bundleIdentifier == nil && Date() < startupDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    candidate = NSRunningApplication(processIdentifier: pid)
}
guard let app = candidate,
      app.bundleIdentifier == "dev.remotelab.feishu-native-trial" else {
    fputs("Only the existing Feishu Native Trial can be activated.\n", stderr)
    exit(1)
}
app.unhide()
let requested = app.activate(options: [.activateIgnoringOtherApps])
let deadline = Date().addingTimeInterval(3)
while !app.isActive && Date() < deadline && !app.isTerminated {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
print("{\"activationRequested\":\(requested),\"active\":\(app.isActive),\"pid\":\(pid)}")
exit(app.isActive ? 0 : 2)
