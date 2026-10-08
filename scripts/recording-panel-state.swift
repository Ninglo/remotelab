import Foundation

// Pure projection: a command acknowledgement must never turn the indicator red.
struct RecordingPanelState: Equatable {
    let title: String
    let detail: String
    let action: String?
    let tone: String
    let startedAt: String?

    static func project(laneID: String, snapshot: [String: Any]?, servicePID: Int32?, serviceRunning: Bool, error: String? = nil) -> RecordingPanelState {
        guard serviceRunning, let pid = servicePID else {
            return .init(title: "服务未运行", detail: error ?? "请重新打开 RemoteLab Recording", action: nil, tone: "offline", startedAt: nil)
        }
        guard error == nil, let snapshot, (snapshot["pid"] as? NSNumber)?.int32Value == pid,
              let active = snapshot["active"] as? [[String: Any]], let records = snapshot["records"] as? [[String: Any]] else {
            return .init(title: "正在确认状态", detail: error ?? "尚未收到本次录音服务的状态", action: nil, tone: "unknown", startedAt: nil)
        }
        if let lane = active.first(where: { $0["laneId"] as? String == laneID }) {
            if lane["state"] as? String == "recording" {
                return .init(title: "正在录音", detail: "点击停止并保存", action: "stop", tone: "recording", startedAt: lane["startedAt"] as? String)
            }
            return .init(title: "正在启动", detail: "尚未收到音频 · 点击取消", action: "stop", tone: "starting", startedAt: nil)
        }
        let last = records.filter { $0["laneId"] as? String == laneID }.max {
            ($0["startedAt"] as? String ?? "") < ($1["startedAt"] as? String ?? "")
        }
        let inputWarning = (snapshot["inputError"] as? String).map { "服务提示，可点击本窗口操作：\($0)" }
        var detail = "点击开始录音"
        var tone = "idle"
        if let last {
            switch last["status"] as? String {
            case "pending": detail = "点击开始 · 上一段已保存，正在回传"
            case "submitted": detail = "点击开始 · 上一段已传入 RemoteLab"
            case "blocked": detail = "点击开始 · 上一段已保存，回传需重试"; tone = "warning"
            case "failed": detail = "点击重试 · 上一段未录成"; tone = "warning"
            default: detail = "点击开始录音"
            }
            if last["interrupted"] as? Bool == true { detail += "（上一段被中断）" }
        }
        return .init(title: "未录音", detail: inputWarning ?? detail, action: "start", tone: inputWarning == nil ? tone : "warning", startedAt: nil)
    }
}
