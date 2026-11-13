(function () {
  "use strict";
  const byId = id => document.getElementById("personalCodex" + id);
  const root = document.getElementById("settings-personal-codex");
  if (!root) return;
  let state = null, busy = false, initialized = false, error = "", feedback = "", timer = null, delay = 250;
  let pollingDeadline = 0, refreshPromise = null;
  const copy = (zh, en) => document.documentElement.lang.startsWith("en") ? en : zh;
  const visible = () => document.getElementById("settingsPanel")?.classList.contains("visible") && !document.hidden;
  const stopPolling = () => { clearTimeout(timer); timer = null; };
  function render() {
    for (const title of document.querySelectorAll("[data-personal-codex-title]")) title.textContent = copy("我的 Codex", "My Codex");
    byId("Intro").textContent = copy("绑定你自己的 ChatGPT 账号，仅用于你发起的 Codex 任务。", "Bind your ChatGPT account for Codex tasks you initiate.");
    byId("Policy").textContent = copy(
      "个人账号优先使用，绝不分配给其他用户。目前仅在确认个人额度耗尽后转用公共池，并在当前对话提醒；额度恢复后的新请求重新优先使用个人账号。",
      "Your account is preferred and never allocated to another user. For now, confirmed quota exhaustion falls back to the shared pool with a conversation notice. New requests prefer your account again when quota recovers.");
    byId("Help").textContent = copy(
      "无需上传账号文件或提供密码。点击绑定，在 OpenAI 页面完成授权后返回；未绑定时沿用公共池。公共账号由管理员管理。",
      "No credential file or password upload. Start binding, authorize on OpenAI, then return. Unbound users use the shared pool. Shared accounts are managed by administrators.");
    const active = state?.deviceLoginActive;
    byId("Status").textContent = !state ? copy("正在读取…", "Loading…")
      : state.loggedIn ? copy("已绑定 · 个人账号优先", "Bound · personal account preferred")
        : active ? copy("等待你在 OpenAI 完成授权", "Waiting for OpenAI authorization")
          : state.phase === "failed" ? copy("需要重新授权", "Authorization needed")
            : copy("未绑定 · 使用公共池", "Unbound · using shared pool");
    byId("Refresh").textContent = copy("刷新状态", "Refresh status");
    byId("Refresh").disabled = busy;
    byId("Bind").textContent = busy ? copy("正在处理…", "Working…")
      : state?.loggedIn ? copy("重新授权", "Reauthorize") : copy("绑定我的账号", "Bind my account");
    byId("Bind").hidden = Boolean(active);
    byId("Bind").disabled = busy || state?.available === false;
    byId("Unbind").textContent = copy("解绑", "Unbind");
    byId("Unbind").hidden = !state?.loggedIn && !state?.bound;
    byId("Unbind").disabled = busy;
    byId("Cancel").textContent = copy("取消绑定", "Cancel");
    byId("Cancel").disabled = busy;
    byId("Account").hidden = !state?.loggedIn;
    byId("Account").textContent = state?.loggedIn
      ? [state.account?.email || state.account?.name, state.account?.planType].filter(Boolean).join(" · ") : "";
    byId("Usage").hidden = !state?.loggedIn;
    byId("Usage").textContent = state?.loggedIn && typeof formatCodexUsage === "function"
      ? formatCodexUsage(state.usage, getCodexAuthCopy()) : "";
    byId("Device").hidden = !active;
    byId("Code").textContent = active ? state.userCode || copy("正在获取验证码…", "Getting code…") : "";
    byId("Copy").textContent = copy("复制验证码", "Copy code");
    byId("Copy").disabled = !active || !state.userCode;
    // Device authorization always uses the official fixed endpoint.
    byId("Authorize").href = "https://auth.openai.com/codex/device";
    byId("Authorize").textContent = copy("前往 OpenAI 授权", "Authorize on OpenAI");
    byId("Steps").replaceChildren(...[
      copy("复制本页验证码，打开 OpenAI 授权页。", "Copy the code and open OpenAI authorization."),
      copy("使用你的 ChatGPT 账号登录并确认授权。", "Sign in with your ChatGPT account and approve."),
      copy("返回这里，绑定结果会自动更新。", "Return here; binding status updates automatically."),
    ].map(text => { const li = document.createElement("li"); li.textContent = text; return li; }));
    byId("Expiry").textContent = active && state.expiresAt
      ? copy("验证码有效至 ", "Code expires at ") + new Date(state.expiresAt).toLocaleTimeString() : "";
    byId("DeviceHelp").textContent = copy(
      "若 OpenAI 提示未启用设备码登录，请在 ChatGPT 设置 → 安全中启用；工作区可能还需要管理员开放。不要将验证码转发给他人。",
      "If device login is disabled, enable it in ChatGPT Settings → Security. A workspace administrator may also need to allow it. Do not share the code.");
    byId("Error").textContent = error || state?.error || (state?.available === false ? copy("当前未安装 Codex，请联系管理员。", "Codex is unavailable. Contact an administrator.") : "");
    byId("Error").hidden = !byId("Error").textContent;
    byId("Feedback").textContent = feedback;
    byId("Feedback").hidden = !feedback;
  }
  async function request(action, body) {
    return (await fetchJsonOrRedirect("/api/personal-codex/" + action, {
      revalidate: false, ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    })).codexAuth;
  }
  function schedule() {
    stopPolling();
    if (!visible() || !state?.deviceLoginActive) return;
    pollingDeadline ||= Date.parse(state.expiresAt) || Date.now() + 15 * 60_000;
    if (Date.now() >= pollingDeadline) {
      state = { ...state, deviceLoginActive: false, phase: "failed", error: copy("验证码已过期，请重新绑定。", "Code expired. Start again.") };
      render(); return;
    }
    timer = setTimeout(() => void refresh(false), delay);
    delay = Math.min(delay * 2, 2000);
  }
  async function refresh(force = false) {
    if (!initialized || busy) return;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const wasPending = state?.deviceLoginActive;
        state = await request(force ? "status?refresh=1" : "status");
        error = "";
        if (wasPending && state.loggedIn) feedback = copy("绑定成功。之后由你发起的 Codex 请求优先使用个人账号。", "Bound. Your next Codex requests prefer this account.");
      } catch (failure) { error = failure.message || copy("读取失败，请重试。", "Could not load status. Retry."); }
      finally { refreshPromise = null; render(); schedule(); }
    })();
    return refreshPromise;
  }
  async function mutate(action) {
    if (busy) return;
    if (action === "logout" && !window.confirm(copy(
      "解绑后，新请求使用公共池。确认解绑你的个人 Codex 账号？",
      "New requests will use the shared pool. Unbind your personal Codex account?"))) return;
    busy = true; stopPolling();
    // Finish an older read before writing, so it cannot overwrite the result.
    if (refreshPromise) await refreshPromise;
    error = ""; feedback = ""; render();
    try {
      state = await request(action, action === "device-login" ? { restart: true } : {});
      delay = 250; pollingDeadline = 0;
      if (action === "logout") feedback = copy("已解绑。后续请求使用公共池。", "Unbound. Future requests use the shared pool.");
    } catch (failure) {
      error = failure.message || copy("操作失败，请重试。", "Operation failed. Retry.");
    } finally { busy = false; render(); schedule(); }
  }
  function open() {
    switchTab("settings");
    const url = new URL(window.location.href);
    url.hash = "settings-personal-codex";
    history.replaceState(null, "", url);
    root.scrollIntoView({ behavior: "auto", block: "start" });
    void refresh();
  }
  document.getElementById("myCodexButton")?.addEventListener("click", open);
  byId("Bind").addEventListener("click", () => void mutate("device-login"));
  byId("Unbind").addEventListener("click", () => void mutate("logout"));
  byId("Cancel").addEventListener("click", () => void mutate("cancel-login"));
  byId("Refresh").addEventListener("click", () => void refresh(true));
  byId("Copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.userCode); feedback = copy("验证码已复制。", "Code copied."); }
    catch { feedback = copy("请长按或选中验证码手动复制。", "Select the code to copy it manually."); }
    render();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling(); else if (visible()) void refresh();
  });
  window.addEventListener("focus", () => { if (visible()) void refresh(); });
  window.addEventListener("remotelab:localechange", render);
  window.remotelabPersonalCodex = {
    init(authInfo) {
      initialized = Boolean(authInfo?.person);
      if (initialized && window.location.hash === "#settings-personal-codex") open();
      else if (initialized && visible()) void refresh();
    },
    shown() { if (initialized) void refresh(); },
  };
  render();
})();
