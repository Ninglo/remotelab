"""Distinct display identity for the isolated App; keep its permission ID stable."""
import pathlib
import plistlib
import shutil
import subprocess

APP_ID = 'dev.remotelab.feishu-native-trial'
APP_NAME = '飞书增强版'
ICON = 'RemoteLabEnhanced.icns'


def read_strings(path):
    raw = path.read_bytes()
    try:
        return plistlib.loads(raw)
    except plistlib.InvalidFileException:
        # macOS localized strings may use the legacy OpenStep text format.
        converted = subprocess.run(['/usr/bin/plutil', '-convert', 'binary1', '-o', '-', str(path)],
                                   check=True, capture_output=True).stdout
        return plistlib.loads(converted)


def apply_identity(app, package):
    app, package = pathlib.Path(app), pathlib.Path(package)
    info_path = app/'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    assert info['CFBundleIdentifier'] == APP_ID, 'Refusing to rename an official or unrelated App'
    resources = app/'Contents/Resources'
    resources.mkdir(exist_ok=True)
    # Localized values override Info.plist in Finder and system permission UI.
    localized = [(p, read_strings(p)) for p in resources.glob('*.lproj/InfoPlist.strings')]
    for _, values in localized:
        assert isinstance(values, dict), 'Invalid localized App metadata'
    info.update(CFBundleName=APP_NAME, CFBundleDisplayName=APP_NAME, CFBundleIconFile=ICON)
    info.pop('CFBundleIconName', None)
    shutil.copy2(package/ICON, resources/ICON)
    info_path.write_bytes(plistlib.dumps(info))
    for path, values in localized:
        values.update(CFBundleName=APP_NAME, CFBundleDisplayName=APP_NAME, CFBundleIconFile=ICON)
        values.pop('CFBundleIconName', None)
        path.write_bytes(plistlib.dumps(values, fmt=plistlib.FMT_BINARY))
