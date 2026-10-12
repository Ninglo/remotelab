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
             'activate-trial.swift','observe_native_app.py','INSTALL.zh-CN.md']:
    shutil.copy2(source/name, folder/name)
(folder/'v8-build').mkdir()
for name in ['runtime-template.js','native_asset_bridge.cjs','live-source.cjs','source-manifest.json']:
    shutil.copy2(build/name, folder/'v8-build'/name)
shutil.copy2(font_license, folder/'SmileySans-LICENSE.txt')
command = folder/'安装飞书增强版.command'
command.write_text('#!/bin/bash\ncd -- "$(dirname -- "$0")" || exit 1\n/usr/bin/python3 install-preview.py\nresult=$?\nprintf "\\n按回车关闭窗口。"\nread -r ignored\nexit "$result"\n')
command.chmod(0o755)
checksums = {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(folder.rglob('*')) if p.is_file()}
(folder/'checksums.json').write_text(json.dumps(checksums,ensure_ascii=False,indent=2)+'\n')
archive=output/(folder.name+'.zip')
with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as package:
    for p in sorted(folder.rglob('*')):
        if p.is_file():package.write(p, p.relative_to(output))
print(json.dumps({'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
                  'size':archive.stat().st_size,'files':len(checksums)+1}))
