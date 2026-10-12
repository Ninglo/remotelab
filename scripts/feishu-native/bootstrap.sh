#!/bin/bash
# Generated release pins are filled by package-cli.py. No system install or sudo.
set -euo pipefail

main() {
  local trial_user_root="${RLFE_INSTALL_HOME:-$HOME}" source_app='' no_open=0 check_only=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --test-home) trial_user_root="$2"; no_open=1; shift 2;;
      --source) source_app="$2"; shift 2;;
      --no-open) no_open=1; shift;;
      --check) check_only=1; no_open=1; shift;;
      *) printf '不支持的选项：%s\n' "$1" >&2; return 1;;
    esac
  done
  if [ "$(/usr/bin/uname -s)" != Darwin ] || [ "$(/usr/bin/uname -m)" != arm64 ]; then
    echo '此入口适用于 M 系列 Mac，请在这台 Mac 的普通终端运行。' >&2; return 1
  fi
  if [ -z "$source_app" ]; then
    for source_app in /Applications/Lark.app /Applications/Feishu.app; do
      [ ! -d "$source_app" ] || break
    done
  fi
  if [ ! -d "$source_app" ]; then echo '未找到已安装的飞书，请反馈你的飞书安装位置。' >&2; return 1; fi
  local version archive
  version=$(/usr/bin/plutil -extract appVersion raw -o - "$source_app/Contents/Frameworks/Lark Framework.framework/Resources/manifest.json")
  if [ "$version" != 8.1.17 ]; then
    printf '当前飞书 %s；本入口适配 8.1.17，原飞书未改动。请反馈这个版本号，无需降级。\n' "$version" >&2; return 1
  fi
  archive="$source_app/Contents/Frameworks/Lark Framework.framework/Versions/147.0.7727.149/Resources/webcontent/messenger.asar"
  if [ ! -f "$archive" ] || [ "$(digest "$archive")" != ee29206c3e424adced06ea95533e46e7f52c5e28f41a380e1d430b670c83a80a ]; then
    echo '飞书内部构建与已核版本不同，原应用未改动。请反馈版本和安装来源。' >&2; return 1
  fi
  if [ "$check_only" = 1 ]; then echo '版本与资源检查通过。'; return 0; fi
  umask 077
  local cache="$trial_user_root/Library/Application Support/RemoteLab/Feishu Installer"
  /bin/mkdir -p "$cache"
  if ! /bin/mkdir "$cache/install.lock" 2>/dev/null; then
    echo '另一次安装尚未退出，未启动第二次安装。' >&2; return 1
  fi
  # EXIT also runs on network, checksum or installer failure; only remove our lock.
  rlfe_install_lock="$cache/install.lock"
  trap '/bin/rmdir "$rlfe_install_lock" 2>/dev/null || true' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo '正在准备增强版运行环境，无需安装开发工具。'
  local node_archive="$cache/node-v22.23.3.tar.gz" python_archive="$cache/python-3.12.15.tar.gz"
  download https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz 23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 "$node_archive"
  download https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.12.15%2B20261009-aarch64-apple-darwin-install_only_stripped.tar.gz 233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f "$python_archive"
  local node_dir="$cache/node-v22.23.3" python_dir="$cache/python-3.12.15"
  extract_runtime "$node_archive" "$node_dir"
  extract_runtime "$python_archive" "$python_dir"
  local node="$node_dir/node-v22.23.3-darwin-arm64/bin/node" python="$python_dir/python/bin/python3"
  "$node" --version >/dev/null
  "$python" --version >/dev/null
  local bundle="$cache/preview9-cli1.zip" package_dir="$cache/packages/__PACKAGE_SHA256__"
  download preview9-cli1.zip __PACKAGE_SHA256__ "$bundle"
  if [ ! -d "$package_dir" ]; then
    /bin/mkdir -p "$cache/packages"
    local unpack; unpack=$(/usr/bin/mktemp -d "$cache/packages/.unpack.XXXXXX")
    /usr/bin/ditto -x -k "$bundle" "$unpack"
    /bin/mv "$unpack" "$package_dir"
  fi
  local package="$package_dir/Feishu-Native-M2-8.1.17-preview9"
  echo '正在安装独立增强版，保留原飞书和登录数据。'
  RLFE_NODE="$node" "$python" "$package/install-preview.py" --source "$source_app" --test-home "$trial_user_root"
  if [ "$no_open" = 0 ]; then
    echo '正在打开飞书增强版。首次使用请登录你本人的飞书账号。'
    RLFE_INSTALL_HOME="$trial_user_root" "$python" "$trial_user_root/Library/Application Support/RemoteLab/Feishu Native Trial/launch_web_replica.py"
  fi
}

digest() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
download() {
  local relative="$1" expected="$2" destination="$3" temporary url
  if [ -f "$destination" ] && [ "$(digest "$destination")" = "$expected" ]; then return 0; fi
  temporary=$(/usr/bin/mktemp "$destination.next.XXXXXX")
  case "$relative" in https://*) url="$relative";; *) url="__PUBLIC_BASE__/$relative";; esac
  if ! /usr/bin/curl --fail --location --progress-bar --show-error --retry 2 --connect-timeout 15 --max-time 300 "$url" -o "$temporary"; then
    /bin/rm -f "$temporary"; echo '下载中断，请重新运行同一条命令；已校验的文件会继续复用。' >&2; return 1
  fi
  if [ "$(digest "$temporary")" != "$expected" ]; then
    /bin/rm -f "$temporary"; echo '下载校验未通过，未安装。请重新运行同一条命令。' >&2; return 1
  fi
  /bin/mv "$temporary" "$destination"
}
extract_runtime() {
  local archive="$1" destination="$2" temporary
  if [ -d "$destination" ]; then return 0; fi
  temporary=$(/usr/bin/mktemp -d "$destination.next.XXXXXX")
  /usr/bin/tar -xzf "$archive" -C "$temporary"
  /bin/mv "$temporary" "$destination"
}

main "$@"
