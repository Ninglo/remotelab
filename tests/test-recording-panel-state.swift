import Foundation

@main
struct RecordingPanelStateTests {
    static func main() {
        let pid: Int32 = 123
        func state(_ snapshot: [String: Any]?, _ lane: String = "a", running: Bool = true, error: String? = nil) -> RecordingPanelState {
            RecordingPanelState.project(laneID: lane, snapshot: snapshot, servicePID: pid, serviceRunning: running, error: error)
        }
        let idle: [String: Any] = ["pid": pid, "active": [[String: Any]](), "records": [[String: Any]]()]
        assert(state(idle).action == "start")
        assert(state(idle).tone == "idle")
        assert(state(nil).action == nil)
        assert(state(["pid": 122, "active": [], "records": []]).tone == "unknown", "Old daemon state must not light the indicator")
        let starting: [String: Any] = ["pid": pid, "active": [["laneId": "a", "state": "starting"]], "records": []]
        assert(state(starting).tone == "starting", "Starting is not proof that audio is saved")
        assert(state(starting).action == "stop", "A failed or slow start can be cancelled")
        let recording: [String: Any] = ["pid": pid, "active": [["laneId": "a", "state": "recording", "startedAt": "2026-01-01T00:00:00Z"]], "records": []]
        assert(state(recording).tone == "recording")
        assert(state(recording).action == "stop")
        assert(state(recording, "b").tone == "idle", "The other discussion is independent")
        assert(state(recording, running: false).tone == "offline", "Child exit must clear a red indicator even if the last file is red")
        assert(state(recording, error: "cannot read status").tone == "unknown")
        for status in ["pending", "submitted", "blocked", "failed"] {
            let saved: [String: Any] = ["pid": pid, "active": [], "records": [["laneId": "a", "status": status, "startedAt": "2026-01-01"]]]
            assert(state(saved).action == "start")
            assert(state(saved).tone != "recording", "Saved/uploading audio is not an active recording")
        }
        let latest: [String: Any] = ["pid": pid, "active": [], "records": [
            ["laneId": "a", "status": "failed", "startedAt": "2026-01-01"],
            ["laneId": "a", "status": "submitted", "startedAt": "2026-01-02"]]]
        assert(state(latest).detail.contains("已传入"))
        var warning = idle; warning["inputError"] = "listener stopped"
        assert(state(warning).tone == "warning")
        assert(state(warning).action == "start", "Mouse controls remain usable if the keypad fails")
        print("Recording panel state tests passed")
    }
}
