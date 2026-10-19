import Foundation
import IOKit.hid

// Native vendor-interface bridge; no keyboard grab or microphone permission.
// JSON lines on stdin: query, light, map-press. Exact USB serial is mandatory.
let args = CommandLine.arguments
guard args.count == 3 && args[1] == "--serial" && !args[2].isEmpty else {
    fputs("Usage: recording-knob-hid --serial USB_SERIAL\n", stderr); exit(2)
}
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(0))
let match: [String: Any] = [kIOHIDVendorIDKey: 1452, kIOHIDProductIDKey: 556,
    kIOHIDSerialNumberKey: args[2], kIOHIDPrimaryUsagePageKey: 65280, kIOHIDPrimaryUsageKey: 1]
IOHIDManagerSetDeviceMatching(manager, match as CFDictionary)
var device: IOHIDDevice?
var lightWritten = false
let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 256)
func write(_ bytes: [UInt8]) -> IOReturn {
    guard let current = device else { return kIOReturnNoDevice }
    let result = bytes.withUnsafeBufferPointer { IOHIDDeviceSetReport(current, kIOHIDReportTypeOutput, 3, $0.baseAddress!, $0.count) }
    if result == kIOReturnSuccess && Array(bytes.prefix(4)) == [3,253,0,6] { lightWritten = true }
    return result
}
func clear() { var bytes = [UInt8](repeating: 0, count: 65); bytes.replaceSubrange(0..<4, with: [3,253,0,6]); _ = write(bytes) }
func stop(_ code: Int32) -> Never {
    if lightWritten { clear() }; IOHIDManagerClose(manager, IOOptionBits(0)); exit(code)
}
IOHIDManagerRegisterDeviceMatchingCallback(manager, { _, _, _, found in
    guard device == nil else { emit(["error":"Multiple exact vendor collections"]); stop(3) }
    device = found
    IOHIDDeviceRegisterInputReportCallback(found, buffer, 256, { _, status, _, _, _, bytes, length in
        let report = Array(UnsafeBufferPointer(start: bytes, count: length))
        emit(["event":"report", "code":status, "bytes":report])
    }, nil)
    emit(["event":"connected", "serial":args[2]])
}, nil)
IOHIDManagerRegisterDeviceRemovalCallback(manager, { _, _, _, removed in
    if let current = device, current == removed { device = nil; emit(["event":"disconnected"]) }
}, nil)
IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
let opened = IOHIDManagerOpen(manager, IOOptionBits(0))
guard opened == kIOReturnSuccess else { emit(["error":"Cannot open knob vendor interface", "code":opened]); exit(1) }

func command(_ line: Data) {
    do {
        guard let value = try JSONSerialization.jsonObject(with:line) as? [String:Any] else { throw NSError(domain:"JSON",code:1) }
        let id = value["id"] ?? NSNull()
        var bytes = [UInt8](repeating:0,count:65)
        switch value["action"] as? String {
        case "query": bytes = [3] + [UInt8](repeating:255,count:64)
        case "light":
            guard let rgb = value["rgb"] as? [Int], rgb.count == 3, rgb.allSatisfy({ (0...255).contains($0) }),
                  let brightness = value["brightness"] as? Int, (0...100).contains(brightness),
                  let enabled = value["enabled"] as? Bool else { emit(["id":id,"error":"Invalid light settings"]); return }
            bytes.replaceSubrange(0..<9,with:[3,253,0,6] + rgb.map(UInt8.init) + [UInt8(brightness),enabled ? 1 : 0])
        case "map-press":
            // Only this documented mapping is exposed; rotation and other keys are untouched.
            bytes.replaceSubrange(0..<10,with:[3,253,3,1,1,0,1,0,0,104])
        default: emit(["id":id,"error":"Unknown command"]); return
        }
        let code = write(bytes)
        emit(["id":id,"code":code])
    } catch { emit(["error":"Malformed command"]) }
}
var input = Data()
FileHandle.standardInput.readabilityHandler = { handle in
    let chunk = handle.availableData
    DispatchQueue.main.async {
        if chunk.isEmpty { stop(0) }
        input.append(chunk)
        if input.count > 65536 { emit(["error":"Command buffer exceeded"]); stop(2) }
        while let end = input.firstIndex(of:10) {
            let line = input.prefix(upTo:end); input.removeSubrange(...end)
            command(Data(line))
        }
    }
}
signal(SIGTERM,SIG_IGN); signal(SIGINT,SIG_IGN)
let term = DispatchSource.makeSignalSource(signal:SIGTERM,queue:.main)
let interrupt = DispatchSource.makeSignalSource(signal:SIGINT,queue:.main)
term.setEventHandler { stop(0) }; interrupt.setEventHandler { stop(0) }
term.resume(); interrupt.resume()
CFRunLoopRun()
