"use strict";

(() => {
  if (window.__displayDeviceRender) return;
  const button = document.querySelector("#applyDevice");
  const check = document.querySelector("#checkDevice");
  const panel = document.querySelector("#deviceStatus");
  const title = document.querySelector("#deviceStatusTitle");
  const meta = document.querySelector("#deviceStatusMeta");
  const tokenKey = "remotelab.display-device-preview.v14";
  const latestKey = "remotelab.display-sync-latest.v21";
  let token = "";
  try {
    const stored = JSON.parse(sessionStorage.getItem(tokenKey) || "null");
    if (/^[a-f0-9]{64}$/.test(stored?.token || "")) token = stored.token;
  } catch { /* A malformed old connection does not authorize a device write. */ }
  let latestFrameId = sessionStorage.getItem(latestKey) || "";
  let targetName = "";
  let connected = false;
  let sending = false;
  let editedAfterApply = false;
  let editRevision = 0;

  function show(message, detail = "", kind = "") {
    title.textContent = message;
    meta.textContent = detail;
    for (const value of ["ready", "pending", "success", "error"]) panel.classList.toggle(`is-${value}`, value === kind);
  }

  async function readStatus() {
    const response = await fetch(token ? "/display/studio-preview/status" : "/api/display/studio-preview/status", {
      credentials: "same-origin",
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(result.devices)) {
      throw Error(response.status === 401 ? "请登录 RemoteLab，或打开副屏专属连接链接。" : result.error || "暂时无法读取副屏连接。");
    }
    if (result.devices.length !== 1) throw Error(result.devices.length ? "当前账号连接了多块副屏，请先在 RemoteLab 设置中确定目标设备。" : "当前账号还没有配对副屏。");
    connected = true;
    targetName = result.devices[0].name || "已配对副屏";
    if (result.metrics && typeof window.displayStudioApplyLiveMetrics === "function") window.displayStudioApplyLiveMetrics(result.metrics);
    button.disabled = sending;
    check.hidden = false;
    return result;
  }

  function presentStatus(result, expectedId = "") {
    const frameId = result.preview?.frameId || "";
    const sameStream = Boolean(expectedId && result.stream?.firstFrameId === expectedId && result.stream?.lastFrameId === frameId);
    if (expectedId && frameId && expectedId !== frameId && !sameStream) {
      show("这次画面已被后续应用覆盖", `本次画面 ${expectedId}；请重新应用当前编辑内容。`, "error");
      return "superseded";
    }
    if (expectedId && !result.preview) {
      show("应用画面已过期", "请重新应用当前画面。", "error");
      return "expired";
    }
    const lastRefreshAt = Date.parse(result.stream?.refreshedAt || "");
    if (Number.isFinite(lastRefreshAt) && Date.now() - lastRefreshAt > 60_000) {
      show("副屏内容更新中断", `上次更新于 ${new Date(lastRefreshAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}；时间与工作状态可能已过期。`, "error");
      return "refresh-stalled";
    }
    if (!expectedId || !frameId) {
      show(`已连接 ${targetName}`, "编辑后点击“预览并应用到副屏”。", "ready");
      return "ready";
    }
    const usbRecentAck = (item) => Number.isFinite(item.usbAckMs) && Date.now() - item.usbAckMs < 15_000;
    const usbFresh = (item) => usbRecentAck(item) && item.usbFps > 0;
    const recentPlayback = (item) => Date.now() - Date.parse(item.reportedAt) < 30_000;
    const playback = result.preview?.devicePlayback?.find((item) => item.bundleFrameId === frameId && item.animationFrames > 1 && recentPlayback(item) && usbFresh(item));
    if (playback) {
      show(editedAfterApply ? "上一版动图正在播放，当前有未应用更改" : "设备正在播放动图", `画面 ${frameId} · ${playback.animationFrames} 帧 · 实体屏效果请现场核对。`, editedAfterApply ? "pending" : "success");
      return "awaiting-visual";
    }
    const earlierPlayback = result.preview?.devicePlayback?.find((item) => item.animationFrames > 1 && recentPlayback(item) && usbFresh(item));
    if (earlierPlayback && result.stream?.animatesGif) {
      show("设备正在播放上一版动图", `${earlierPlayback.animationFrames} 帧在播放 · 最新画面 ${frameId} 正在同步。`, "pending");
      return "queued";
    }
    const stalledUsb = result.preview?.devicePlayback?.find((item) => recentPlayback(item) && item.usbAckMs && !usbRecentAck(item));
    if (stalledUsb) {
      show("设备在线，USB 画面传输未恢复", `上次 USB 成功回执距今 ${Math.max(1, Math.floor((Date.now() - stalledUsb.usbAckMs) / 60_000))} 分钟 · 请检查副屏与 Mac 的连接。`, "error");
      return "usb-stalled";
    }
    const animated = result.preview?.animationCount > 0;
    const bundleSent = result.preview?.animationDelivery?.some((item) => item.sourceFrameId === frameId && item.lastFormat === "jpeg-bundle" && item.bundleFrameCount > 1);
    const state = result.delivery?.state;
    if (state === "usb-active") {
      show(editedAfterApply ? "设备已接收上一版画面，当前有未应用更改" : "USB 通道已有画面回执", `画面 ${frameId} · ${animated ? "动图播放回执待确认" : "实体屏效果仍需现场核对"}。`, editedAfterApply || animated ? "pending" : "success");
      return "awaiting-visual";
    }
    if (bundleSent) {
      show(editedAfterApply ? "上一版动图已送达，当前有未应用更改" : "动图已送达设备", `画面 ${frameId} · 正在等待多帧播放回执。`, "pending");
      return "queued";
    }
    if (state === "downloaded") {
      show(editedAfterApply ? "设备已拉取上一版画面，当前有未应用更改" : "设备已拉取画面", `画面 ${frameId} · 实体屏效果仍需现场核对。`, "pending");
      return "awaiting-visual";
    }
    if (state === "online-unconfirmed") {
      show(editedAfterApply ? "上一版已提交，当前有未应用更改" : `${targetName} 已连接，画面待核对`, `画面 ${frameId} · 设备拉取尚无独立回执，请看实体屏。`, "pending");
      return "awaiting-visual";
    }
    show(editedAfterApply ? "上一版画面待设备拉取，当前有未应用更改" : "画面已提交，等待设备拉取", `画面 ${frameId} · 可点“检查状态”。`, "pending");
    return "queued";
  }

  async function inspect(expectedId = latestFrameId) {
    const result = await readStatus();
    return presentStatus(result, expectedId);
  }

  async function waitForDevice(frameId) {
    const deadline = Date.now() + 25_000;
    let delay = 250;
    while (Date.now() < deadline) {
      try {
        const state = await inspect(frameId);
        if (["awaiting-visual", "refresh-stalled", "usb-stalled", "superseded", "expired"].includes(state)) return;
      } catch (error) {
        show("画面已提交，设备状态暂时不可读", error.message, "pending");
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2_000);
    }
    show("画面已提交，设备完成情况尚未确认", `画面 ${frameId} · 可点“检查状态”，并查看实体屏。`, "pending");
  }

  window.addEventListener("display-studio-changed", () => {
    editRevision += 1;
    if (!latestFrameId) return;
    editedAfterApply = true;
    show("有未应用更改", `当前预览已更新；${targetName || "副屏"}仍显示上一版。`, "pending");
  });

  check.addEventListener("click", async () => {
    check.disabled = true;
    try { await inspect(); }
    catch (error) { connected = false; button.disabled = true; show("无法读取副屏状态", error.message, "error"); }
    finally { check.disabled = false; }
  });

  button.addEventListener("click", async () => {
    if (sending || !connected) return;
    sending = true;
    button.disabled = true;
    button.textContent = "正在应用…";
    show("正在生成真机画面", "即将发送当前布局、主题、文字与宠物。", "pending");
    try {
      await readStatus();
      const payload = await window.displayStudioExportDevicePayload();
      const appliedRevision = editRevision;
      const response = await fetch(token ? "/display/studio-preview" : "/api/display/studio-preview", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || `应用失败（HTTP ${response.status}）`);
      if (!/^[a-f0-9]{12}$/.test(result.frameId || "")) throw Error("服务端未返回有效画面编号。");
      latestFrameId = result.frameId;
      sessionStorage.setItem(latestKey, latestFrameId);
      editedAfterApply = editRevision !== appliedRevision;
      show("画面已提交，等待设备拉取", `画面 ${latestFrameId} · 正在核对设备回执。`, "pending");
      await waitForDevice(latestFrameId);
    } catch (error) {
      show("应用未完成", error.message || "请检查副屏连接后重试。", "error");
    } finally {
      sending = false;
      button.disabled = !connected;
      button.textContent = "预览并应用到副屏";
    }
  });

  void inspect().catch((error) => { connected = false; button.disabled = true; check.hidden = false; show("尚未连接真机", error.message, "error"); });
  window.setInterval(() => {
    if (!connected || sending || document.visibilityState !== "visible") return;
    void inspect().catch(() => {});
  }, 5_000);
})();
