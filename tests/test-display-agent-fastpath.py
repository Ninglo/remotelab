import base64
import importlib.util
import json
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


source = Path(__file__).resolve().parents[1] / "display" / "agent.py"
spec = importlib.util.spec_from_file_location("display_agent", source)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class FrameHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    paths = []
    ports = []

    def do_GET(self):
        type(self).paths.append(self.path)
        type(self).ports.append(self.client_address[1])
        if self.headers.get("Authorization") != "Bearer test-device-token":
            self.send_error(401)
            return
        if self.headers.get("Accept", "").startswith("application/vnd.remotelab.display-frames+json;v=2"):
            if self.headers.get("Accept", "").endswith(";id=fedcba987654"):
                self.send_response(304)
                self.send_header("X-RemoteLab-Display-Poll-Seconds", "2")
                self.end_headers()
                return
            frames = [b"\xff\xd8first", b"\xff\xd8second"]
            body = json.dumps({"version": 2, "frameId": "0123456789ab", "bundleId": "fedcba987654", "intervalMs": 100,
                               "frames": [base64.b64encode(frame).decode() for frame in frames]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.remotelab.display-frames+json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-RemoteLab-Display-Poll-Seconds", "2")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.headers.get("Accept") != "image/jpeg":
            self.send_error(406)
            return
        body = b"\xff\xd8test-jpeg-frame"
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-RemoteLab-Display-Poll-Seconds", "0.18")
        self.send_header("X-RemoteLab-Display-Animated", "1")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


class DisplayAgentFastPathTest(unittest.TestCase):
    def test_persistent_jpeg_connection_and_worker_interval(self):
        server = HTTPServer(("127.0.0.1", 0), FrameHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/v1/devices/display-0123456789abcdef/frame.png"
        connection = agent.JpegFrameConnection(url, "test-device-token")
        try:
            first_headers, first_image = connection.read()
            second_headers, second_image = connection.read()
            self.assertEqual(first_image, second_image)
            self.assertEqual(first_headers["x-remotelab-display-poll-seconds"], "0.18")
            self.assertEqual(second_headers["x-remotelab-display-animated"], "1")
            self.assertEqual(FrameHandler.paths[-2:], ["/v1/devices/display-0123456789abcdef/frame.png"] * 2)
            self.assertEqual(FrameHandler.ports[-2], FrameHandler.ports[-1], "JPEG requests should reuse a connection")
            worker = agent.DisplayWorker()
            worker.update(first_image, interval=0.18)
            self.assertEqual(worker.interval, 0.18)
            worker.update(first_image)
            self.assertEqual(worker.interval, 0.5)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_rejects_external_plain_http(self):
        with self.assertRaises(ValueError):
            agent.JpegFrameConnection("http://example.com/frame.png", "token")

    def test_usb_worker_sends_different_cached_frames_without_network(self):
        sent = []
        enough = threading.Event()

        class FakeUsbDisplay:
            def show(self, jpeg):
                sent.append(jpeg)
                if len(sent) >= 4:
                    enough.set()
                return 512

            def close(self):
                pass

        worker = agent.DisplayWorker()
        worker.update_sequence((b"\xff\xd8first", b"\xff\xd8second"))
        with patch.object(agent, "UsbDisplay", FakeUsbDisplay):
            worker.start()
            try:
                self.assertTrue(enough.wait(1.5), "cached animation did not reach the USB worker")
            finally:
                worker.close()
        self.assertEqual(sent[:4], [b"\xff\xd8first", b"\xff\xd8second"] * 2)
        self.assertGreaterEqual(worker.status()["usbFrames"], 4)

    def test_animation_keeps_original_timeline_when_usb_runs_slow(self):
        # Five frames at 100 ms should wrap after 500 ms even if USB
        # finishes only about once every 160 ms.
        select = agent.animation_frame_index
        self.assertEqual([select(t, 10.0, 0.1, 5) for t in
                          (10.0, 10.16, 10.32, 10.48, 10.64)], [0, 1, 3, 4, 1])
        self.assertEqual(select(10.51, 10.0, 0.1, 5), 0)

    def test_local_animation_bundle_reuses_connection_and_cycles_frames(self):
        server = HTTPServer(("127.0.0.1", 0), FrameHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/v1/devices/display-0123456789abcdef/frame.png"
        connection = agent.JpegFrameConnection(url, "test-device-token")
        try:
            mode, headers, bundle = connection.read_bundle()
            self.assertEqual(mode, "updated")
            self.assertEqual(headers["x-remotelab-display-poll-seconds"], "2")
            self.assertEqual(bundle["frames"], (b"\xff\xd8first", b"\xff\xd8second"))
            worker = agent.DisplayWorker()
            worker.update_sequence(bundle["frames"])
            self.assertEqual(worker.frames, bundle["frames"])
            self.assertEqual(worker.interval, 0.1)
            mode, _, unchanged = connection.read_bundle(bundle["bundleId"])
            self.assertEqual(mode, "unchanged")
            self.assertIsNone(unchanged)
            self.assertEqual(FrameHandler.ports[-2], FrameHandler.ports[-1])
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
