import Foundation

// Pure projection: a command acknowledgement must never turn the indicator red.
struct RecordingPanelState: Equatable {
    let title: String
    let detail: String
    let action: String?
    let tone: String
    let startedAt: String?

    static func project(laneID: String, snapshot: [String: Any]?, servicePID: Int32?, serviceRunning: Bool, error: String? = nil) -> RecordingPanelState {
        guard serviceRunning else {
            return .init(title: "服务未运行", detail: error ?? "请重新打开 RemoteLab Recording", action: nil, tone: "offline", startedAt: nil)
        }
        guard error == nil, let pid = servicePID, let snapshot, (snapshot["pid"] as? NSNumber)?.int32Value == pid,
              let active = snapshot["active"] as? [[String: Any]], let records = snapshot["records"] as? [[String: Any]] else {
            return .init(title: "正在确认状态", detail: error ?? "尚未收到本次录音服务的状态", action: nil, tone: "unknown", startedAt: nil)
        }
        if let lane = active.first(where: { $0["laneId"] as? String == laneID }) {
            if lane["state"] as? String == "recording" {
                return .init(title: "正在录音", detail: "点击停止并保存", action: "stop", tone: "recording", startedAt: lane["startedAt"] as? String)
            }
            if lane["state"] as? String == "selecting" {
                return .init(title: "等待麦克风", detail: "拿起任意空闲麦说话 · 点击取消", action: "stop", tone: "starting", startedAt: nil)
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
            case "held": detail = "点击开始 · 上一段已保存在本机"
            case "pending": detail = snapshot["submissionMode"] as? String == "local" ? "点击开始 · 上一段已保存，上传已暂停" : "点击开始 · 上一段已保存，正在回传"
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

// Publication receipts, not analysis admission, establish that audio reached the group.
struct RecordingRowState {
    let id: String
    let label: String
    let startedAt: String?
    let endedAt: String?
    let speaker: String
    let status: String
    let tone: String

    static func project(_ record: [String: Any], activeIDs: Set<String>, serviceRunning: Bool) -> RecordingRowState {
        let id = record["id"] as? String ?? ""
        let state = record["status"] as? String ?? ""
        var status = "状态待确认", tone = "warning"
        if activeIDs.contains(id) {
            status = serviceRunning ? "正在录音" : "录音状态待确认"; tone = serviceRunning ? "recording" : "warning"
        } else if state == "recording" { status = "录音状态待确认" }
        else if state == "failed" { status = "录音失败" }
        else if state == "held" { status = "仅本地保存"; tone = "local" }
        else if !(record["audioPublishedAt"] as? String ?? "").isEmpty {
            status = "已发送到群"; tone = "sent"
        } else if state == "blocked" { status = "发送失败 · 原音保留" }
        else if state == "submitted" { status = "已上传"; tone = "sent" }
        else if state == "pending" { status = "已保存 · 发送中"; tone = "pending" }
        if record["interrupted"] as? Bool == true { status += " · 录音中断" }
        let names = (record["speakers"] as? [[String: Any]] ?? []).compactMap { speaker -> String? in
            guard speaker["verified"] as? Bool == true, let name = speaker["name"] as? String, !name.isEmpty else { return nil }
            return name
        }
        return .init(id: id, label: record["label"] as? String ?? "录音", startedAt: record["startedAt"] as? String,
                     endedAt: record["endedAt"] as? String, speaker: names.isEmpty ? "未识别" : names.joined(separator: "、"), status: status, tone: tone)
    }
}
