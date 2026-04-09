#!/bin/bash
# RemoteLab 服务诊断脚本
# Usage:
#   logs.sh          — 显示所有服务状态 + 最近日志
#   logs.sh chat     — 只看 chat-server 日志 (实时 tail)
#   logs.sh tunnel   — 只看 cloudflared 日志 (实时 tail)
#   logs.sh status   — 只看服务状态

CMD="${1:-all}"

# Detect OS and set log directory
if [[ "$(uname)" == "Darwin" ]]; then
    OS_TYPE="macos"
    LOG_DIR="$HOME/Library/Logs"
else
    OS_TYPE="linux"
    LOG_DIR="/var/log/remotelab"
fi

# ── 颜色 ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── 服务状态 ──────────────────────────────────────────────────────────────────
show_status() {
  echo -e "${BOLD}=== 服务状态 (${OS_TYPE}) ===${RESET}"

  if [[ "$OS_TYPE" == "macos" ]]; then
    for label in com.chatserver.claude com.cloudflared.tunnel; do
      info=$(launchctl list 2>/dev/null | grep "$label")
      if [ -n "$info" ]; then
        pid=$(echo "$info" | awk '{print $1}')
        exit_code=$(echo "$info" | awk '{print $2}')
        if [ "$pid" != "-" ] && [ -n "$pid" ]; then
          echo -e "  ${GREEN}●${RESET} $label  (pid=$pid)"
        else
          echo -e "  ${RED}✗${RESET} $label  (not running, last exit=$exit_code)"
        fi
      else
        echo -e "  ${YELLOW}?${RESET} $label  (not loaded)"
      fi
    done
  else
    local owner_scope=""
    local owner_unit=""
    if systemctl list-unit-files remotelab.service &>/dev/null 2>&1 || systemctl status remotelab.service &>/dev/null 2>&1; then
      owner_scope="system"
      owner_unit="remotelab"
    elif systemctl --user list-unit-files remotelab-chat.service &>/dev/null 2>&1 || systemctl --user status remotelab-chat.service &>/dev/null 2>&1; then
      owner_scope="user"
      owner_unit="remotelab-chat"
    fi

    if [[ -n "$owner_unit" ]]; then
      if [[ "$owner_scope" == "user" ]]; then
        if systemctl --user is-active --quiet "${owner_unit}.service" 2>/dev/null; then
          pid=$(systemctl --user show -p MainPID --value "${owner_unit}.service" 2>/dev/null || echo "?")
          echo -e "  ${GREEN}●${RESET} ${owner_unit}.service  (pid=${pid}, scope=user)"
        else
          status=$(systemctl --user is-active "${owner_unit}.service" 2>/dev/null || echo "unknown")
          echo -e "  ${RED}✗${RESET} ${owner_unit}.service  (${status}, scope=user)"
        fi
      else
        if systemctl is-active --quiet "${owner_unit}.service" 2>/dev/null; then
          pid=$(systemctl show -p MainPID --value "${owner_unit}.service" 2>/dev/null || echo "?")
          echo -e "  ${GREEN}●${RESET} ${owner_unit}.service  (pid=${pid}, scope=system)"
        else
          status=$(systemctl is-active "${owner_unit}.service" 2>/dev/null || echo "unknown")
          echo -e "  ${RED}✗${RESET} ${owner_unit}.service  (${status}, scope=system)"
        fi
      fi
    else
      echo -e "  ${YELLOW}?${RESET} owner chat service  (not installed)"
    fi

    if systemctl --user list-unit-files remotelab-tunnel.service &>/dev/null 2>&1; then
      if systemctl --user is-active --quiet remotelab-tunnel.service 2>/dev/null; then
        pid=$(systemctl --user show -p MainPID --value remotelab-tunnel.service 2>/dev/null || echo "?")
        echo -e "  ${GREEN}●${RESET} remotelab-tunnel.service  (pid=${pid}, scope=user)"
      else
        status=$(systemctl --user is-active remotelab-tunnel.service 2>/dev/null || echo "unknown")
        echo -e "  ${RED}✗${RESET} remotelab-tunnel.service  (${status}, scope=user)"
      fi
    fi
  fi
  echo ""
}

# ── 打印最近 N 行日志 ─────────────────────────────────────────────────────────
show_recent_logs() {
  local name="$1"
  local out_log="$2"
  local err_log="$3"
  local lines="${4:-30}"

  echo -e "${CYAN}── $name stdout ($out_log) ──${RESET}"
  if [ -f "$out_log" ]; then
    tail -n "$lines" "$out_log"
  else
    echo "  (文件不存在)"
  fi
  echo ""

  echo -e "${RED}── $name stderr ($err_log) ──${RESET}"
  if [ -f "$err_log" ]; then
    tail -n "$lines" "$err_log"
  else
    echo "  (文件不存在)"
  fi
  echo ""
}

# ── 主逻辑 ────────────────────────────────────────────────────────────────────
case "$CMD" in
  status)
    show_status
    ;;

  chat)
    echo -e "${BOLD}实时跟踪 chat-server 日志 (Ctrl+C 退出)${RESET}"
    if [[ "$OS_TYPE" == "linux" ]]; then
      if systemctl list-unit-files remotelab.service &>/dev/null 2>&1 || systemctl status remotelab.service &>/dev/null 2>&1; then
        echo -e "${CYAN}journalctl:${RESET} journalctl -u remotelab.service -f"
        echo ""
        journalctl -u remotelab.service -f 2>/dev/null || \
          tail -f "$LOG_DIR/chat-server.log" "$LOG_DIR/chat-server.error.log" 2>/dev/null
      else
        echo -e "${CYAN}journalctl:${RESET} journalctl --user -u remotelab-chat -f"
        echo ""
        journalctl --user -u remotelab-chat -f 2>/dev/null || \
          tail -f "$HOME/.local/share/remotelab/logs/chat-server.log" "$HOME/.local/share/remotelab/logs/chat-server.error.log" 2>/dev/null
      fi
    else
      tail -f "$LOG_DIR/chat-server.log" "$LOG_DIR/chat-server.error.log" 2>/dev/null
    fi
    ;;

  tunnel)
    echo -e "${BOLD}实时跟踪 cloudflared 日志 (Ctrl+C 退出)${RESET}"
    if [[ "$OS_TYPE" == "linux" ]]; then
      journalctl --user -u remotelab-tunnel -f 2>/dev/null || \
        tail -f "$LOG_DIR/cloudflared.log" "$LOG_DIR/cloudflared.error.log" 2>/dev/null
    else
      tail -f "$LOG_DIR/cloudflared.log" "$LOG_DIR/cloudflared.error.log" 2>/dev/null
    fi
    ;;

  all|*)
    show_status
    echo -e "${BOLD}=== 最近日志 (各 30 行) ===${RESET}"
    echo ""
    show_recent_logs "chat-server" \
      "$LOG_DIR/chat-server.log" \
      "$LOG_DIR/chat-server.error.log"
    show_recent_logs "cloudflared" \
      "$LOG_DIR/cloudflared.log" \
      "$LOG_DIR/cloudflared.error.log"

    echo -e "${BOLD}── 快速命令参考 ──${RESET}"
    echo "  logs.sh chat    # 实时跟踪 chat-server"
    echo "  logs.sh tunnel  # 实时跟踪 cloudflared"
    echo "  logs.sh status  # 只看服务状态"
    if [[ "$OS_TYPE" == "linux" ]]; then
      echo ""
      echo "  # systemd 日志 (更完整):"
      if systemctl list-unit-files remotelab.service &>/dev/null 2>&1 || systemctl status remotelab.service &>/dev/null 2>&1; then
        echo "  journalctl -u remotelab.service -f"
      else
        echo "  journalctl --user -u remotelab-chat -f"
      fi
      echo "  journalctl --user -u remotelab-tunnel -f"
    fi
    ;;
esac
