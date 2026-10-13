"""Permission display metadata stays distinct without changing identity or profile."""
import pathlib
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile

source = pathlib.Path(__file__).resolve().parents[1]/'scripts/feishu-native'
sys.path.insert(0, str(source))
from app_identity import APP_ID, APP_NAME, ICON, apply_identity

with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    app = root/'trial.app'
    resources = app/'Contents/Resources'
    localized = resources/'zh_CN.lproj/InfoPlist.strings'
    localized.parent.mkdir(parents=True)
    info = {'CFBundleIdentifier': APP_ID, 'CFBundleName': 'Feishu', 'CFBundleDisplayName': '飞书',
            'CFBundleExecutable': 'Feishu', 'CFBundleIconName': 'OriginalAssets',
            'NSMicrophoneUsageDescription': 'existing microphone purpose'}
    path = app/'Contents/Info.plist'
    path.write_bytes(plistlib.dumps(info))
    strings = {'CFBundleDisplayName': '飞书', 'CFBundleName': 'Feishu', 'unrelated': '保留原有文案'}
    localized.write_bytes(plistlib.dumps(strings, fmt=plistlib.FMT_BINARY))
    if sys.platform == 'darwin':
        other = resources/'en.lproj/InfoPlist.strings'
        other.parent.mkdir()
        other.write_text('/* original comment */\n"CFBundleDisplayName" = "Feishu";\n"unrelated" = "Keep me";\n')
    apply_identity(app, source)
    first = {p.relative_to(app): p.read_bytes() for p in app.rglob('*') if p.is_file()}
    apply_identity(app, source)
    assert first == {p.relative_to(app): p.read_bytes() for p in app.rglob('*') if p.is_file()}
    updated = plistlib.loads(path.read_bytes())
    assert updated['CFBundleIdentifier'] == APP_ID
    assert updated['CFBundleExecutable'] == 'Feishu'
    assert updated['NSMicrophoneUsageDescription'] == info['NSMicrophoneUsageDescription']
    assert updated['CFBundleName'] == updated['CFBundleDisplayName'] == APP_NAME
    assert 'CFBundleIconName' not in updated
    assert plistlib.loads(localized.read_bytes())['unrelated'] == '保留原有文案'
    assert plistlib.loads(localized.read_bytes())['CFBundleDisplayName'] == APP_NAME
    icon = (resources/ICON).read_bytes()
    assert icon[:4] == b'icns' and struct.unpack('>I', icon[4:8])[0] == len(icon)
    if sys.platform == 'darwin':
        assert plistlib.loads(other.read_bytes())['unrelated'] == 'Keep me'
        subprocess.run(['/usr/bin/sips', '-s', 'format', 'png', str(resources/ICON), '--out', str(root/'icon.png')], check=True, capture_output=True)
        assert (root/'icon.png').stat().st_size > 100
    # An official bundle is rejected before anything can be changed.
    updated['CFBundleIdentifier'] = 'com.bytedance.Lark'
    path.write_bytes(plistlib.dumps(updated))
    baseline = path.read_bytes()
    try:
        apply_identity(app, source)
        raise RuntimeError('Accepted an official App')
    except AssertionError:
        pass
    assert path.read_bytes() == baseline
print('Distinct main/localized name and icon; stable identity, preserved permissions metadata, idempotence and official-App protection passed')
