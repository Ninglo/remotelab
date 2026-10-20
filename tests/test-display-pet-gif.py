"""Regression: palette changes must not produce opaque background flashes."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location("export_pet", Path(__file__).parents[1] / "display/export-pet-gif.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class PetGifTest(unittest.TestCase):
    def test_transparency_motion_and_timing_survive_palette_changes(self):
        frames = []
        for i in range(12):
            frame = Image.new("RGBA", (32, 24), (0, 0, 0, 0))
            draw = ImageDraw.Draw(frame)
            draw.rectangle((2 + i, 4, 8 + i, 19), fill=(20 * i, 255 - 20 * i, 80, 255))
            # Actual black artwork must remain opaque; only alpha selects transparency.
            draw.rectangle((24, 5, 28, 9), fill=(0, 0, 0, 255))
            frames.append(frame)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "pet.gif"
            exporter.export_frames(frames, output)
            gif = Image.open(output)
            self.addCleanup(gif.close)
            self.assertEqual(gif.n_frames, len(frames))
            decoded = []
            for i, source in enumerate(frames):
                gif.seek(i)
                restored = gif.convert("RGBA")
                self.assertEqual(restored.getchannel("A").tobytes(), source.getchannel("A").tobytes(), i)
                self.assertEqual(restored.getpixel((25, 6)), (0, 0, 0, 255))
                self.assertEqual(gif.info["duration"], 100)
                decoded.append(restored.tobytes())
            self.assertEqual(len(set(decoded)), len(frames))


if __name__ == "__main__":
    unittest.main()
