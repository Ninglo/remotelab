import base64
import importlib.util
import json
import threading
import tempfile
import unittest
from unittest.mock import Mock, patch
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
    def test_heartbeat_and_fallback_download_follow_proxy_changes_without_restart(self):
        class Handler(BaseHTTPRequestHandler):
            def respond(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.dumps({"route": self.server.route}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = respond

            def log_message(self, *_args):
                pass

        servers = [HTTPServer(("127.0.0.1", 0), Handler) for _ in range(2)]
        origin, proxy = servers
        origin.route, proxy.route = "direct", "proxy"
        threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
        for thread in threads:
            thread.start()
        url = f"http://127.0.0.1:{origin.server_port}/heartbeat"
        try:
            for operation in ("heartbeat", "download"):
                with self.subTest(operation=operation), tempfile.TemporaryDirectory() as temporary, \
                        patch.object(agent.urllib.request, "_opener", None), \
                        patch.object(agent.urllib.request, "proxy_bypass", return_value=False), \
                        patch.object(agent.urllib.request, "getproxies") as getproxies:
                    def read_route():
                        if operation == "heartbeat":
                            return agent.request_json(url, token="test-token", data={"playbackState": "ended"})["route"]
                        target = Path(temporary) / "frame.png"
                        agent.download(url, "test-token", target)
                        return json.loads(target.read_text())["route"]

                    getproxies.return_value = {"http": f"http://127.0.0.1:{proxy.server_port}"}
                    self.assertEqual(read_route(), "proxy")
                    getproxies.return_value = {}
                    self.assertEqual(read_route(), "direct", "disabling a system proxy must affect the next request")
                    getproxies.return_value = {"http": f"http://127.0.0.1:{proxy.server_port}"}
                    self.assertEqual(read_route(), "proxy", "re-enabling a proxy must not require restarting the player")
        finally:
            for server, thread in zip(servers, threads):
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_once_finishes_on_usb_and_background_refresh_does_not_restart(self):
        worker = agent.DisplayWorker()
        frames = (b"\xff\xd8first", b"\xff\xd8middle", b"\xff\xd8last")
        worker.update_sequence(frames, 0.05, True, "0123456789ab")
        started = worker.sequence_started
        worker.update_sequence(tuple(f + b"-new-bg" for f in frames), 0.05, True, "0123456789ab")
        self.assertEqual(worker.sequence_started, started)
        self.assertEqual(agent.animation_frame_index(100, 0, 0.05, 3, True), 2)
        sent = []
        enough = threading.Event()

        class FakeUsb:
            def show(self, jpeg):
                sent.append(jpeg)
                # Worker reports ended only after this real boundary returns.
                if len(sent) == 1:
                    self.assert_not_ended()
                if len(sent) >= 10:
                    enough.set()
                return 512

            def assert_not_ended(self):
                assert worker.status()["playbackState"] == "playing"

            def close(self):
                pass

        with patch.object(agent, "UsbDisplay", FakeUsb):
            worker.start()
            try:
                self.assertTrue(enough.wait(2))
                self.assertEqual(worker.status()["playbackState"], "ended")
                self.assertEqual(sent[0], frames[0] + b"-new-bg")
                self.assertTrue(all(f == frames[-1] + b"-new-bg" for f in sent[4:]), "hold finishing pose, never wrap")
                worker.update_sequence(frames, 0.05, True, "0123456789ab")
                self.assertEqual(worker.status()["playbackState"], "ended", "clock refresh preserves ended")
                worker.update_sequence(frames, 0.05, True, "abcdef012345")
                self.assertEqual(worker.status()["playbackState"], "playing")
                self.assertGreater(worker.sequence_started, started)
            finally:
                worker.close()

    def test_stale_usb_ack_cannot_finish_replacement_action(self):
        worker = agent.DisplayWorker()
        frames = (b"\xff\xd8first", b"\xff\xd8last")
        worker.update_sequence(frames, 0.05, True, "0123456789ab")
        worker.sequence_started -= 10

        class FakeUsb:
            def show(self, jpeg):
                worker.update_sequence(frames, 0.05, True, "abcdef012345")
                worker.stop.set()
                return 512
            def close(self):
                pass

        with patch.object(agent, "UsbDisplay", FakeUsb):
            worker._run()
        self.assertEqual(worker.status()["playbackId"], "abcdef012345")
        self.assertEqual(worker.status()["playbackState"], "playing")

    def test_jpeg_and_animation_use_system_https_proxy_and_reuse_tunnel(self):
        jpeg_response = Mock(status=200)
        jpeg_response.getheaders.return_value = [("Content-Type", "image/jpeg")]
        jpeg_response.read.return_value = b"\xff\xd8proxied-frame"
        bundle_response = Mock(status=200)
        bundle_response.getheaders.return_value = [("Content-Type", "application/vnd.remotelab.display-frames+json")]
        bundle_response.read.return_value = json.dumps({
            "version": 2, "frameId": "0123456789ab", "bundleId": "fedcba987654",
            "intervalMs": 100, "frames": [base64.b64encode(b"\xff\xd8frame").decode()],
        }).encode()
        with patch.object(agent.urllib.request, "getproxies", return_value={"https": "http://127.0.0.1:7892"}), \
                patch.object(agent.urllib.request, "proxy_bypass", return_value=False), \
                patch.object(agent.http.client, "HTTPSConnection") as connect:
            transport = connect.return_value
            transport.getresponse.side_effect = [jpeg_response, bundle_response]
            client = agent.JpegFrameConnection("https://example.com/display/v1/devices/display-0123456789abcdef/frame.png", "private-token")
            self.assertEqual(client.read()[1], b"\xff\xd8proxied-frame")
            self.assertEqual(client.read_bundle()[2]["frames"], (b"\xff\xd8frame",))
            connect.assert_called_once_with("127.0.0.1", 7892, timeout=15)
            transport.set_tunnel.assert_called_once_with("example.com", 443, headers={})
            for call in transport.request.call_args_list:
                self.assertEqual(call.kwargs["headers"]["Authorization"], "Bearer private-token")
                self.assertNotIn("Proxy-Authorization", call.kwargs["headers"])
            client.close()

    def test_proxy_bypass_keeps_https_direct(self):
        with patch.object(agent.urllib.request, "getproxies", return_value={"https": "http://127.0.0.1:7892"}), \
                patch.object(agent.urllib.request, "proxy_bypass", return_value=True), \
                patch.object(agent.http.client, "HTTPSConnection") as connect:
            agent.JpegFrameConnection("https://example.com/frame.png", "token").open_connection()
            connect.assert_called_once_with("example.com", timeout=15)
            connect.return_value.set_tunnel.assert_not_called()

    def test_no_https_proxy_keeps_existing_direct_transport(self):
        with patch.object(agent.urllib.request, "getproxies", return_value={}), \
                patch.object(agent.http.client, "HTTPSConnection") as connect:
            agent.JpegFrameConnection("https://example.com/frame.png", "token").open_connection()
            connect.assert_called_once_with("example.com", timeout=15)
            connect.return_value.set_tunnel.assert_not_called()

    def test_proxy_credentials_only_enter_connect_tunnel(self):
        with patch.object(agent.urllib.request, "getproxies", return_value={"https": "http://user:p%40ss@127.0.0.1:7892"}), \
                patch.object(agent.urllib.request, "proxy_bypass", return_value=False), \
                patch.object(agent.http.client, "HTTPSConnection") as connect:
            agent.JpegFrameConnection("https://example.com:8443/frame.png", "private-token").open_connection()
            headers = connect.return_value.set_tunnel.call_args.kwargs["headers"]
            self.assertEqual(headers, {"Proxy-Authorization": "Basic " + base64.b64encode(b"user:p@ss").decode()})
            self.assertNotIn("private-token", str(connect.mock_calls))

    def test_unsupported_proxy_does_not_silently_connect_directly(self):
        with patch.object(agent.urllib.request, "getproxies", return_value={"https": "socks5://127.0.0.1:7892"}), \
                patch.object(agent.urllib.request, "proxy_bypass", return_value=False), \
                patch.object(agent.http.client, "HTTPSConnection") as connect:
            with self.assertRaisesRegex(RuntimeError, "HTTP CONNECT proxy"):
                agent.JpegFrameConnection("https://example.com/frame.png", "token").open_connection()
            connect.assert_not_called()

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
