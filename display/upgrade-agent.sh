#!/bin/sh
set -eu

app_dir="$HOME/Library/Application Support/RemoteLab/display-agent"
state="$app_dir/state.json"
agent="$app_dir/agent.py"
temporary="$app_dir/agent.py.download"
backup="$app_dir/agent.py.previous"
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
chmod 700 "$temporary"
cp -p "$agent" "$backup"
mv "$temporary" "$agent"
if ! launchctl kickstart -k "gui/$(id -u)/$label"; then
  mv "$backup" "$agent"
  launchctl kickstart -k "gui/$(id -u)/$label" || true
  echo "The new agent did not start; the previous agent was restored." >&2
  exit 1
fi
echo "RemoteLab side display agent upgraded. Existing pairing and screen layout were kept."
