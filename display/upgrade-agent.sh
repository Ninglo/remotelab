#!/bin/sh
set -eu

app_dir="$HOME/Library/Application Support/RemoteLab/display-agent"
state="$app_dir/state.json"
agent="$app_dir/agent.py"
temporary="$app_dir/agent.py.download"
backup="$app_dir/agent.py.previous"
vendor="$app_dir/vendor"
vendor_new="$app_dir/vendor.download"
vendor_backup="$app_dir/vendor.previous"
python_bin=/usr/bin/python3
label=ai.remotelab.display-agent

if [ "$(uname -s)" != "Darwin" ] || [ ! -f "$state" ] || [ ! -f "$agent" ]; then
  echo "Run this on the paired Mac that is driving the RemoteLab side display." >&2
  exit 2
fi

server_base=$("$python_bin" - "$state" <<'PY'
import json, sys
from urllib.parse import urlsplit
state = json.load(open(sys.argv[1]))
url = urlsplit(state['frameUrl'])
if url.scheme != 'https' or not url.path.endswith('/frame.png'):
    raise SystemExit('The paired display has an unexpected server address')
print(f'{url.scheme}://{url.netloc}{url.path.split("/v1/devices/", 1)[0]}')
PY
)

trap 'rm -f "$temporary"' EXIT
curl -fsSL "$server_base/agent.py" -o "$temporary"
"$python_bin" -m py_compile "$temporary"
mkdir -p "$vendor_new"
"$python_bin" -m pip install --disable-pip-version-check --upgrade --target "$vendor_new" 'Pillow>=10.4,<13'
"$python_bin" - "$vendor_new" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from PIL import Image, features
assert features.check('jpg'), 'Pillow JPEG support is required'
print('Local animation renderer ready:', Image.__version__)
PY
chmod 700 "$temporary"
cp -p "$agent" "$backup"
if [ -d "$vendor_backup" ]; then rm -rf "$vendor_backup"; fi
if [ -d "$vendor" ]; then mv "$vendor" "$vendor_backup"; fi
mv "$vendor_new" "$vendor"
mv "$temporary" "$agent"
if ! "$python_bin" "$agent" check-renderer || ! launchctl kickstart -k "gui/$(id -u)/$label"; then
  mv "$backup" "$agent"
  rm -rf "$vendor"
  if [ -d "$vendor_backup" ]; then mv "$vendor_backup" "$vendor"; fi
  launchctl kickstart -k "gui/$(id -u)/$label" || true
  echo "The new agent did not start; the previous agent was restored." >&2
  exit 1
fi
echo "RemoteLab side display agent upgraded with local GIF playback. Existing pairing and screen layout were kept."
