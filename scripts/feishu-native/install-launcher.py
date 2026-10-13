"""Install a stable user-facing launcher for an already prepared Mac trial.

Run with launch.py beside this file. No credentials,
profile, official application or injected runtime are changed.
"""
import json
import os
import sys
import pathlib
import plistlib
import shutil
import subprocess

source = pathlib.Path(__file__).resolve().parent
home = pathlib.Path(os.environ.get('RLFE_INSTALL_HOME',str(pathlib.Path.home())))
root = home / 'Library/Application Support/RemoteLab/Feishu Native Trial'
trial = root / 'Feishu Native Trial.app'
info = plistlib.loads((trial / 'Contents/Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'dev.remotelab.feishu-native-trial'
deployment = json.loads((root / 'native-v8-deployment.json').read_text())
app = home / 'Applications/飞书增强版.app'
bundle_id = 'dev.remotelab.feishu-native-launcher'
if app.exists():
    assert plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleIdentifier'] == bundle_id
launcher = root / 'launch_web_replica.py'
backup = root / 'launch_web_replica.before-desktop.py'
if launcher.exists() and not backup.exists():
    shutil.copy2(launcher, backup)
shutil.copy2(source / 'launch.py', root / 'launch_web_replica.next.py')
(root / 'launch_web_replica.next.py').replace(launcher)
(app / 'Contents/MacOS').mkdir(parents=True, exist_ok=True)
(app / 'Contents/Resources').mkdir(exist_ok=True)
executable = app / 'Contents/MacOS/launch'
(root/'python-path').write_text(sys.executable)
executable.write_text('#!/bin/sh\nexec "$(/bin/cat "$HOME/Library/Application Support/RemoteLab/Feishu Native Trial/python-path")" "$HOME/Library/Application Support/RemoteLab/Feishu Native Trial/launch_web_replica.py" >> "$HOME/Library/Application Support/RemoteLab/Feishu Native Trial/launcher.log" 2>&1\n')
executable.chmod(0o755)
metadata = {'CFBundleIdentifier': bundle_id, 'CFBundleName': '飞书增强版',
            'CFBundleDisplayName': '飞书增强版', 'CFBundleExecutable': 'launch',
            'CFBundlePackageType': 'APPL', 'LSUIElement': True,
            'CFBundleShortVersionString': str(deployment['revision']),
            'CFBundleVersion': str(deployment['revision'])}
icon_name = info.get('CFBundleIconFile', '')
icon = trial / 'Contents/Resources' / icon_name
if icon_name and not icon.suffix:
    icon = icon.with_suffix('.icns')
if icon_name and icon.is_file():
    shutil.copy2(icon, app / 'Contents/Resources/icon.icns')
    metadata['CFBundleIconFile'] = 'icon.icns'
(app / 'Contents/Info.plist').write_bytes(plistlib.dumps(metadata))
subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(app)], check=True)
subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(app)], check=True)
print(json.dumps({'launcher': str(app),
                  'revision': deployment['revision'], 'launcherVersion': 2}, ensure_ascii=False))
