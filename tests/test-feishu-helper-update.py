"""Isolated rollout, integrity, interruption and rollback scenarios."""
import base64
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1]/'scripts/feishu-native'
spec = importlib.util.spec_from_file_location('updates', SOURCE/'helper-update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
OLD, NEW = b'module.exports={version:1};', b'module.exports={version:2};'


class Device:
    def __init__(self, root, active=True, fail=False):
        self.root, self.node, self.active, self.fail = root, shutil.which('node'), active, fail
        self.pid, self.stopped, self.started = 100, [], []

    def apps(self):
        return [42] if self.active else []

    def status(self):
        return {'pid': self.pid, 'pages': [{'id': 'page', 'hasDraft': True,
                'sync': {'state': 'connected'}}]} if self.active and self.pid else None

    def stop(self, pid):
        self.stopped.append(pid)
        self.pid = None

    def start(self, app):
        self.pid = 200+len(self.started)
        self.started.append(self.pid)
        return self.pid

    def await_pages(self, pid, apps, before):
        if self.fail:
            raise RuntimeError('reconnect failed')
        return {'sameClients': True, 'draftPresence': [True]}


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root/'topic-source.cjs').write_bytes(OLD)
        (self.root/'native_asset_bridge.cjs').write_bytes(b'bridge')
        u.save(self.root/'native-v8-deployment.json', {'revision': 16})
        (self.root/'native-v8-storage.json').write_text('private device account')
        self.manifest = {'schema': 1, 'revision': 16, 'serial': 1,
            'bridgeHashes': [u.sha(b'bridge')],
            'files': {'topic-source.cjs': {'sha256': u.sha(NEW), 'from': [u.sha(OLD)]}}}
        self.device = Device(self.root)

    def run_update(self, data=NEW):
        return u.apply(self.root, self.device, self.manifest, lambda url: data)

    def test_two_independent_devices_and_idempotent(self):
        for folder in ['studio', 'laptop']:
            root = self.root/folder
            root.mkdir()
            for name in ['topic-source.cjs', 'native_asset_bridge.cjs', 'native-v8-deployment.json']:
                shutil.copy2(self.root/name, root/name)
            (root/'native-v8-storage.json').write_text(folder+' credentials')
            device = Device(root)
            result = u.apply(root, device, self.manifest, lambda url: NEW)
            self.assertEqual(result['state'], 'updated')
            self.assertEqual(result['appPid'], 42)
            self.assertTrue(result['verification']['sameClients'])
            self.assertEqual((root/'native-v8-storage.json').read_text(), folder+' credentials')
            self.assertEqual(u.apply(root, device, self.manifest)['state'], 'current')
            self.assertEqual(device.stopped, [100])

    def test_download_tamper_does_not_stop_or_write(self):
        with self.assertRaises(ValueError):
            self.run_update(b'corrupt')
        self.assertEqual(self.device.stopped, [])
        self.assertEqual((self.root/'topic-source.cjs').read_bytes(), OLD)

    def test_unknown_baseline_and_path_rejected(self):
        (self.root/'native_asset_bridge.cjs').write_bytes(b'other')
        with self.assertRaises(ValueError):
            self.run_update()
        (self.root/'native_asset_bridge.cjs').write_bytes(b'bridge')
        self.manifest['files']['../secret'] = self.manifest['files'].pop('topic-source.cjs')
        with self.assertRaises(ValueError):
            self.run_update()
        self.assertEqual(self.device.stopped, [])

    def test_rollback_holds_bad_release(self):
        self.device.fail = True
        self.assertEqual(self.run_update()['state'], 'rolled-back')
        self.assertEqual((self.root/'topic-source.cjs').read_bytes(), OLD)
        self.assertEqual(self.run_update()['state'], 'held')
        self.assertEqual(len(self.device.started), 2)

    def test_crash_recovery_offline(self):
        backup = self.root/'helper-update-backups'/'interrupted'
        backup.mkdir(parents=True)
        (backup/'topic-source.cjs').write_bytes(OLD)
        (self.root/'topic-source.cjs').write_bytes(NEW)
        u.save(self.root/'helper-update-pending.json', {'backup': 'interrupted', 'serial': 1,
               'originals': {'topic-source.cjs': u.sha(OLD)}})
        result = u.apply(self.root, self.device, None)
        self.assertEqual(result['state'], 'rolled-back')
        self.assertEqual((self.root/'topic-source.cjs').read_bytes(), OLD)
        self.assertFalse((self.root/'helper-update-pending.json').exists())

    def test_cold_device_never_launches_app(self):
        self.device.active = False
        self.assertEqual(self.run_update()['state'], 'updated')
        self.assertEqual(self.device.started, [])
        self.assertEqual(self.device.stopped, [])

    def test_unhealthy_device_deferred(self):
        self.device.status = lambda: None
        self.assertEqual(self.run_update()['state'], 'deferred')
        self.assertEqual((self.root/'topic-source.cjs').read_bytes(), OLD)

    def test_signed_manifest_and_tamper(self):
        key = self.root/'key.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key)], check=True)
        public = subprocess.check_output(['openssl', 'pkey', '-in', str(key), '-pubout'], text=True)
        payload = self.root/'payload'
        payload.write_text(json.dumps(self.manifest))
        signature = subprocess.check_output(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', str(key), '-in', str(payload)])
        envelope = {'payload': base64.b64encode(payload.read_bytes()).decode(),
                    'signature': base64.b64encode(signature).decode()}
        self.assertEqual(u.verify_envelope(json.dumps(envelope), self.device.node, public), self.manifest)
        envelope['payload'] = base64.b64encode(b'{}').decode()
        with self.assertRaises(subprocess.CalledProcessError):
            u.verify_envelope(json.dumps(envelope), self.device.node, public)

    def test_stale_and_symlink_rejected(self):
        u.save(self.root/'helper-update-receipt.json', {'serial': 2})
        with self.assertRaises(ValueError):
            self.run_update()
        (self.root/'helper-update-receipt.json').unlink()
        (self.root/'topic-source.cjs').unlink()
        (self.root/'topic-source.cjs').symlink_to(self.root/'native-v8-storage.json')
        with self.assertRaises(ValueError):
            self.run_update()

    def test_download_uses_enabled_macos_proxy_without_auth(self):
        def download(command, **kwargs):
            self.assertIn('http://127.0.0.1:7892', command)
            self.assertNotIn('--location', command)
            pathlib.Path(command[command.index('--output')+1]).write_bytes(NEW)
        with patch.object(u.subprocess, 'check_output', return_value='HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7892\n'), patch.object(u.subprocess, 'run', side_effect=download):
            self.assertEqual(u.fetch(u.BASE+'/objects/hash/topic-source.cjs'), NEW)
            with self.assertRaises(ValueError):
                u.fetch('https://other.invalid/patch')


if __name__ == '__main__':
    unittest.main()
