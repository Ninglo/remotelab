"""Archive patch integrity: preserve unrelated assets and refuse duplicate injection."""
import hashlib
import importlib.util
import json
import pathlib
import struct

source = pathlib.Path(__file__).resolve().parents[1] / 'scripts/feishu-native/archive_patch.py'
spec = importlib.util.spec_from_file_location('archive_patch', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

body = bytearray()
def entry(data):
    offset = len(body)
    body.extend(data)
    return {'size': len(data), 'offset': str(offset), 'integrity': {'blockSize': 16}}

header = {'files': {
    'messenger': {'files': {'zh.html': entry(b'<body>list</body>')}},
    'messenger-chat': {'files': {'en.html': entry(b'<body>chat</body>')}},
    'keep.bin': entry(bytes(range(256))),
}}
raw = json.dumps(header).encode()
payload = struct.pack('<I', len(raw)) + raw
payload += b'\0' * ((-len(payload)) % 4)
pickle = struct.pack('<I', len(payload)) + payload
original = struct.pack('<II', 4, len(pickle)) + pickle + body
patched, report = module.patch_archive(original, b'console.log("fixture")')
assert report['unchangedEntriesVerified'] == 1
assert report['htmlsPatched'] == ['messenger/zh.html', 'messenger-chat/en.html']
_, size, _, length = struct.unpack('<4I', patched[:16])
result = json.loads(patched[16:16+length])
for kind, locale in [('messenger', 'zh.html'), ('messenger-chat', 'en.html')]:
    item = result['files'][kind]['files'][locale]
    start = 8+size+int(item['offset'])
    data = patched[start:start+item['size']]
    assert data.count(b'remotelab-native-v7.js') == 1
    assert hashlib.sha256(data).hexdigest() == item['integrity']['hash']
    assert item['integrity']['blocks'] == [hashlib.sha256(data[i:i+16]).hexdigest() for i in range(0,len(data),16)]
try:
    module.patch_archive(patched, b'replacement')
    raise RuntimeError('Duplicate injection accepted')
except AssertionError:
    pass
print('Native installer archive integrity and duplicate protection passed')
