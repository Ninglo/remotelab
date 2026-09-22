#!/bin/sh
set -eu

enrollment_url=${1:-}
if [ -z "$enrollment_url" ]; then
  echo "Usage: curl -fsSL <this-server>/install.sh | sh -s -- <enrollment-url>" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "RemoteLab Display v0 currently supports macOS only." >&2
  exit 3
fi

python_bin=/usr/bin/python3
if [ ! -x "$python_bin" ]; then
  echo "Python 3 is required." >&2
  exit 4
fi

server_base=$($python_bin - "$enrollment_url" <<'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
if parsed.scheme != "https" or not parsed.netloc:
    raise SystemExit("Enrollment URL must use HTTPS")
suffix = "/v1/enroll/"
if suffix not in parsed.path:
    raise SystemExit("Enrollment URL has an unexpected path")
prefix = parsed.path.split(suffix, 1)[0].rstrip("/")
print(f"{parsed.scheme}://{parsed.netloc}{prefix}")
PY
)

app_dir="$HOME/Library/Application Support/RemoteLab/display-agent"
launch_dir="$HOME/Library/LaunchAgents"
label=ai.remotelab.display-agent
plist="$launch_dir/$label.plist"
agent="$app_dir/agent.py"

mkdir -p "$app_dir" "$launch_dir"
chmod 700 "$app_dir"
temporary="$app_dir/agent.py.download"
curl -fsSL "$server_base/agent.py" -o "$temporary"
chmod 700 "$temporary"
mv "$temporary" "$agent"

if ! "$python_bin" "$agent" check-usb; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing libusb…"
    brew install libusb
  else
    echo "libusb is missing. Install Homebrew and run: brew install libusb" >&2
    exit 5
  fi
fi

echo "Registering this display with $server_base …"
"$python_bin" "$agent" enroll "$enrollment_url"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$python_bin</string><string>$agent</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$app_dir</string>
  <key>StandardOutPath</key><string>$app_dir/agent.log</string>
  <key>StandardErrorPath</key><string>$app_dir/agent.log</string>
</dict></plist>
EOF
chmod 600 "$plist"

launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"

echo "RemoteLab Display is installed and running."
echo "Logs: $app_dir/agent.log"
