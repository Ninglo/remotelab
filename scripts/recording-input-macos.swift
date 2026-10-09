import Foundation
import IOKit.hid

func emit(_ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
func property(_ device: IOHIDDevice, _ key: String) -> String {
    guard let value = IOHIDDeviceGetProperty(device, key as CFString) else { return "" }
    return String(describing: value)
}
func identity(_ device: IOHIDDevice) -> String {
    let serial = property(device, kIOHIDSerialNumberKey)
    let address = serial.isEmpty ? "location:" + property(device, kIOHIDLocationIDKey) : "serial:" + serial
    return "hid:" + property(device, kIOHIDVendorIDKey) + ":" + property(device, kIOHIDProductIDKey) + ":" + address
}
let arguments = Array(CommandLine.arguments.dropFirst())
let mode = arguments.first ?? "list"
let allowed = Set(arguments.dropFirst())
var held = Set<String>()
let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(0))
IOHIDManagerSetDeviceMatching(manager, [kIOHIDDeviceUsagePageKey: 1, kIOHIDDeviceUsageKey: 6] as CFDictionary)
if IOHIDManagerOpen(manager, IOOptionBits(0)) != kIOReturnSuccess {
    emit(["error": "Cannot read keypad events. Allow Input Monitoring for the installed recording helper in macOS Settings."])
    exit(1)
}
if mode == "list" {
    let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> ?? []
    emit(devices.map { ["deviceId": identity($0), "name": property($0, kIOHIDProductKey)] })
    exit(0)
}
if mode != "listen" || allowed.isEmpty { emit(["error": "listen requires explicit keypad device IDs"]); exit(1) }
// Read only explicitly bound keypads. Do not seize devices or install a global key tap.
IOHIDManagerRegisterInputValueCallback(manager, { _, _, _, value in
    let element = IOHIDValueGetElement(value)
    let usagePage = IOHIDElementGetUsagePage(element)
    guard usagePage == 7 || usagePage == 12 else { return }
    let device = IOHIDElementGetDevice(element)
    let id = identity(device)
    guard allowed.contains(id) else { return }
    let keyId = id + ":" + String(usagePage) + ":" + String(IOHIDElementGetUsage(element))
    if IOHIDValueGetIntegerValue(value) == 0 { held.remove(keyId); return }
    guard IOHIDValueGetIntegerValue(value) == 1, !held.contains(keyId) else { return }
    held.insert(keyId)
    emit(["deviceId": id, "usagePage": usagePage, "key": IOHIDElementGetUsage(element), "pressed": true])
}, nil)
IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
CFRunLoopRun()
