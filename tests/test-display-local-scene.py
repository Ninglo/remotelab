import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import time
import unittest

from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location("agent", Path(__file__).parents[1] / "display/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
export_spec = importlib.util.spec_from_file_location("export", Path(__file__).parents[1] / "display/export-pet-gif.py")
exporter = importlib.util.module_from_spec(export_spec)
export_spec.loader.exec_module(exporter)


class LocalSceneTest(unittest.TestCase):
    def test_complete_loop_transparency_timing_and_asset_reuse(self):
        frames = []
        for i in range(101):
            im = Image.new("RGBA", (128, 64))
            ImageDraw.Draw(im).rectangle((i, 10, i + 10, 30), fill=(250, 20, 40, 255))
            frames.append(im)
        gif = io.BytesIO(); exporter.export_frames(frames, gif)
        asset_id = hashlib.sha256(gif.getvalue()).hexdigest()[:12]
        bg = io.BytesIO(); Image.new("RGB", (1920, 480), "white").save(bg, format="PNG")
        scene = {"version": 3, "frameId": "0123456789ab", "intervalMs": 100,
                 "backgroundPng": base64.b64encode(bg.getvalue()).decode(),
                 "layers": [{"assetId": asset_id, "box": {"x": 0, "y": 0, "width": 128, "height": 64}, "fit": "contain"}],
                 "assets": {asset_id: base64.b64encode(gif.getvalue()).decode()}}
        cache = agent.LocalSceneCache()
        started = time.monotonic(); rendered, interval = cache.compose(scene)
        self.assertEqual(len(rendered), 101)
        self.assertEqual(interval, 0.1)
        self.assertAlmostEqual(len(rendered) * interval, 10.1)
        for data in rendered:
            with Image.open(io.BytesIO(data)) as im:
                self.assertEqual(im.size, (1920, 480))
                self.assertGreater(min(im.getpixel((120, 63))), 240, "transparent background must not flash black")
        with Image.open(io.BytesIO(rendered[-1])) as last:
            self.assertGreater(last.getpixel((105, 20))[0], 220)
            self.assertLess(last.getpixel((105, 20))[1], 60, "include the finishing pose")
        reused, _ = cache.compose({**scene, "assets": {}, "frameId": "abcdef012345"})
        self.assertEqual(reused, rendered, "cached GIF produces identical frames after clock refresh")
        worker = agent.DisplayWorker(); worker.update_sequence(rendered, interval)
        self.assertEqual(worker.status()["animationFrames"], 101)
        self.assertEqual(worker.status()["targetIntervalMs"], 100)
        self.assertEqual(agent.animation_frame_index(10.0, 0, interval, 101), 100)
        with self.assertRaises(ValueError):
            cache.compose({**scene, "assets": {asset_id: base64.b64encode(b"wrong asset").decode()}})
        self.assertIn(asset_id, cache.assets, "failed refresh must preserve the previous verified asset")
        print(f"Local scene: 101 frames, complete 10.1s loop; compose/cache validation {time.monotonic()-started:.2f}s")


if __name__ == "__main__":
    unittest.main()
