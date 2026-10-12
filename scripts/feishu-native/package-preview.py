"""Package only reviewed code/assets; never package a Mac application or profile."""
import hashlib
import json
import pathlib
import shutil
import sys
import zipfile

source = pathlib.Path(__file__).resolve().parent
build, font_license, output = map(pathlib.Path, sys.argv[1:])
folder = output / 'Feishu-Native-M2-8.1.17-preview9'
folder.mkdir(parents=True, exist_ok=False)
for name in ['install-preview.py','archive_patch.py','launch.py','install-launcher.py',
             'observe_native_app.py','upgrade-preview.py','INSTALL.zh-CN.md']:
    shutil.copy2(source/name, folder/name)
(folder/'v8-build').mkdir()
for name in ['runtime-template.js','native_asset_bridge.cjs','live-source.cjs','topic-source.cjs','source-manifest.json']:
    shutil.copy2(build/name, folder/'v8-build'/name)
# A standalone release carries no developer-specific dependency path. A future
# explicitly paired source must provide its own ws dependency; no binding ships.
live = folder/'v8-build/live-source.cjs'
live.write_text(live.read_text().replace("require('/Users/jiujianian/code/remotelab/node_modules/ws')", "require(process.env.RLFE_WS_MODULE || 'ws')"))
shutil.copy2(font_license, folder/'SmileySans-LICENSE.txt')
checksums = {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(folder.rglob('*')) if p.is_file()}
(folder/'checksums.json').write_text(json.dumps(checksums,ensure_ascii=False,indent=2)+'\n')
archive=output/(folder.name+'.zip')
with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as package:
    for p in sorted(folder.rglob('*')):
        if p.is_file():package.write(p, p.relative_to(output))
print(json.dumps({'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
                  'size':archive.stat().st_size,'files':len(checksums)+1}))
