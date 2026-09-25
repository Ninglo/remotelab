#!/usr/bin/env python3
"""Minimal macOS display agent installed by one RemoteLab Server."""

from __future__ import annotations

import ctypes as C
import ctypes.util
import base64
import http.client
import json
import os
import platform
import re
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path


VID = 0x0416
PID = 0x5408
OUT_ENDPOINT = 0x09
IN_ENDPOINT = 0x81
MAX_JPEG_BYTES = 650_000
APP_DIR = Path.home() / "Library/Application Support/RemoteLab/display-agent"
STATE_FILE = APP_DIR / "state.json"


def event(name: str, **values) -> None:
    print(json.dumps({"event": name, **values}, ensure_ascii=False, separators=(",", ":")), flush=True)


def save_private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def request_json(url: str, *, token: str = "", data: dict | None = None, timeout: int = 30) -> dict:
    headers = {"Accept": "application/json", "User-Agent": "RemoteLab-Display/0"}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(f"server returned HTTP {exc.code}: {detail}") from exc


def download(url: str, token: str, destination: Path) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "User-Agent": "RemoteLab-Display/0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            headers = {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(f"frame request returned HTTP {exc.code}: {detail}") from exc
    destination.write_bytes(body)
    return headers


class JpegFrameConnection:
    """Reuse one HTTPS connection and consume ready-to-send JPEG frames."""

    def __init__(self, png_url: str, token: str):
        parsed = urllib.parse.urlsplit(png_url)
        if parsed.scheme not in ("https", "http") or not parsed.path.endswith("/frame.png"):
            raise ValueError("unexpected display frame URL")
        if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("display frame URL must use HTTPS")
        self.parsed = parsed
        # Existing public proxy exposes frame.png and forwards Accept.
        self.path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        self.token = token
        self.connection = None

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def read(self) -> tuple[dict, bytes]:
        try:
            if self.connection is None:
                connection_type = http.client.HTTPSConnection if self.parsed.scheme == "https" else http.client.HTTPConnection
                self.connection = connection_type(self.parsed.netloc, timeout=15)
            self.connection.request("GET", self.path, headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "image/jpeg",
                "User-Agent": "RemoteLab-Display/1",
            })
            response = self.connection.getresponse()
            headers = {key.lower(): value for key, value in response.getheaders()}
            body = response.read(MAX_JPEG_BYTES + 1)
            if response.status != 200:
                raise RuntimeError(f"JPEG frame request returned HTTP {response.status}: {body[:120]!r}")
            if headers.get("content-type", "").split(";", 1)[0] != "image/jpeg":
                raise RuntimeError("JPEG frame has the wrong content type")
            frame_packets(body)
            if headers.get("connection", "").lower() == "close":
                self.close()
            return headers, body
        except Exception:
            self.close()
            raise

    def read_bundle(self, bundle_id: str = "") -> tuple[str, dict, dict | None]:
        """Fetch a small JPEG loop when its image or playback timing changes."""
        if bundle_id and not re.fullmatch(r"[a-f0-9]{12}", bundle_id):
            raise ValueError("invalid display bundle id")
        try:
            if self.connection is None:
                connection_type = http.client.HTTPSConnection if self.parsed.scheme == "https" else http.client.HTTPConnection
                self.connection = connection_type(self.parsed.netloc, timeout=15)
            accept = "application/vnd.remotelab.display-frames+json;v=2"
            if bundle_id:
                accept += f";id={bundle_id}"
            self.connection.request("GET", self.path, headers={
                "Authorization": f"Bearer {self.token}", "Accept": accept,
                "User-Agent": "RemoteLab-Display/3",
            })
            response = self.connection.getresponse()
            headers = {key.lower(): value for key, value in response.getheaders()}
            body = response.read(9 * 1024 * 1024 + 1)
            if len(body) > 9 * 1024 * 1024:
                raise ValueError("display bundle is too large")
            if response.status in (204, 304):
                return ("unavailable" if response.status == 204 else "unchanged"), headers, None
            if response.status != 200 or headers.get("content-type", "").split(";", 1)[0] != "application/vnd.remotelab.display-frames+json":
                raise RuntimeError(f"display bundle returned HTTP {response.status} with unexpected content")
            bundle = json.loads(body)
            if bundle.get("version") != 2 or not re.fullmatch(r"[a-f0-9]{12}", str(bundle.get("frameId", ""))) \
                    or not re.fullmatch(r"[a-f0-9]{12}", str(bundle.get("bundleId", ""))):
                raise ValueError("invalid display bundle version or id")
            frames = bundle.get("frames")
            interval_ms = bundle.get("intervalMs")
            if not isinstance(frames, list) or not 1 <= len(frames) <= 32 or not isinstance(interval_ms, int) or not 50 <= interval_ms <= 500:
                raise ValueError("invalid display bundle timing")
            decoded = tuple(base64.b64decode(frame, validate=True) for frame in frames)
            for frame in decoded:
                frame_packets(frame)
            bundle["frames"] = decoded
            if headers.get("connection", "").lower() == "close":
                self.close()
            return "updated", headers, bundle
        except Exception:
            self.close()
            raise


def find_libusb() -> str:
    explicit = os.environ.get("THERMALRIGHT_LIBUSB_PATH")
    if explicit:
        return explicit
    found = ctypes.util.find_library("usb-1.0")
    if found:
        return found
    candidates = [
        "/opt/homebrew/opt/libusb/lib/libusb-1.0.dylib",
        "/usr/local/opt/libusb/lib/libusb-1.0.dylib",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    raise RuntimeError("libusb 1.0 was not found")


def frame_packets(jpeg: bytes) -> bytearray:
    if not jpeg.startswith(b"\xff\xd8") or len(jpeg) > MAX_JPEG_BYTES:
        raise ValueError("expected a JPEG no larger than 650 KB")
    count = len(jpeg) // 496 + 1
    output = bytearray(((count + 3) // 4) * 2048)
    for index in range(count):
        part = jpeg[index * 496 : (index + 1) * 496]
        struct.pack_into("<BBIHBHH3x", output, index * 512, 1, 255, len(jpeg), len(part), 1, count, index)
        output[index * 512 + 16 : index * 512 + 16 + len(part)] = part
    return output


class UsbDisplay:
    def __init__(self):
        self.lib = C.CDLL(find_libusb())
        pointer, byte_pointer = C.c_void_p, C.POINTER(C.c_ubyte)
        signatures = [
            ("init", [C.POINTER(pointer)], C.c_int),
            ("exit", [pointer], None),
            ("open_device_with_vid_pid", [pointer, C.c_uint16, C.c_uint16], pointer),
            ("close", [pointer], None),
            ("error_name", [C.c_int], C.c_char_p),
            ("get_configuration", [pointer, C.POINTER(C.c_int)], C.c_int),
            ("claim_interface", [pointer, C.c_int], C.c_int),
            ("release_interface", [pointer, C.c_int], C.c_int),
            ("bulk_transfer", [pointer, C.c_ubyte, byte_pointer, C.c_int, C.POINTER(C.c_int), C.c_uint], C.c_int),
        ]
        for name, args, result in signatures:
            function = getattr(self.lib, "libusb_" + name)
            function.argtypes, function.restype = args, result
        self.context, self.handle, self.claimed = pointer(), None, False
        try:
            self._check(self.lib.libusb_init(C.byref(self.context)))
            self.handle = self.lib.libusb_open_device_with_vid_pid(self.context, VID, PID)
            if not self.handle:
                raise RuntimeError("Thermalright LCD is absent, busy, or inaccessible")
            configuration = C.c_int()
            self._check(self.lib.libusb_get_configuration(self.handle, C.byref(configuration)))
            if configuration.value != 1:
                raise RuntimeError("unexpected USB configuration")
            self._check(self.lib.libusb_claim_interface(self.handle, 0))
            self.claimed = True
            hello = bytearray(2048)
            hello[0], hello[1], hello[8] = 2, 255, 1
            self._transfer(OUT_ENDPOINT, hello)
            response = self._transfer(IN_ENDPOINT, bytes(512))
            if len(response) < 37 or (response[0], response[1], response[8]) != (3, 255, 1):
                raise RuntimeError("invalid display handshake")
        except Exception:
            self.close()
            raise

    def _check(self, code: int) -> None:
        if code < 0:
            raise RuntimeError(self.lib.libusb_error_name(code).decode())

    def _transfer(self, endpoint: int, data: bytes | bytearray) -> bytes:
        buffer = (C.c_ubyte * len(data)).from_buffer_copy(data)
        transferred = C.c_int()
        self._check(self.lib.libusb_bulk_transfer(self.handle, endpoint, buffer, len(data), C.byref(transferred), 2000))
        if endpoint < 128 and transferred.value != len(data):
            raise RuntimeError("short USB write")
        return bytes(buffer[: transferred.value])

    def show(self, jpeg: bytes) -> int:
        data = frame_packets(jpeg)
        for offset in range(0, len(data), 4096):
            self._transfer(OUT_ENDPOINT, data[offset : offset + 4096])
        acknowledgment = self._transfer(IN_ENDPOINT, bytes(512))
        if not acknowledgment:
            raise RuntimeError("missing frame acknowledgment")
        return len(acknowledgment)

    def close(self) -> None:
        if self.handle:
            if self.claimed:
                self.lib.libusb_release_interface(self.handle, 0)
            self.lib.libusb_close(self.handle)
        if self.context:
            self.lib.libusb_exit(self.context)
        self.handle, self.context, self.claimed = None, None, False


def animation_frame_index(now: float, started: float, interval: float, frame_count: int) -> int:
    """Choose the GIF frame by elapsed time, not by completed USB writes."""
    return max(0, int((now - started) / interval)) % frame_count


class DisplayWorker:
    def __init__(self):
        self.jpeg: bytes | None = None
        self.frames: tuple[bytes, ...] = ()
        self.frame_index = 0
        self.sequence_started = 0.0
        self.usb_frames = 0
        self.usb_ack_ms = 0
        self.usb_frame_ms = 0
        self.last_ack_monotonic = 0.0
        self.usb_intervals_ms: list[int] = []
        self.interval = 0.5
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def update(self, jpeg: bytes, interval: float = 0.5) -> None:
        frame_packets(jpeg)
        with self.lock:
            self.jpeg = jpeg
            self.frames = (jpeg,)
            self.frame_index = 0
            self.sequence_started = time.monotonic()
            self.interval = max(0.18, min(0.5, interval))

    def update_sequence(self, frames: tuple[bytes, ...], interval: float = 0.1) -> None:
        if not 1 <= len(frames) <= 32:
            raise ValueError("invalid animation frame count")
        for frame in frames:
            frame_packets(frame)
        with self.lock:
            self.frames = frames
            self.jpeg = frames[0]
            self.frame_index = 0
            self.sequence_started = time.monotonic()
            self.interval = max(0.05, min(0.5, interval))

    def status(self) -> dict:
        with self.lock:
            return {"usbFrames": self.usb_frames, "usbAckMs": self.usb_ack_ms,
                    "usbFrameMs": self.usb_frame_ms, "animationFrames": len(self.frames),
                    "targetIntervalMs": round(self.interval * 1000),
                    "actualIntervalMs": round(sum(self.usb_intervals_ms) / len(self.usb_intervals_ms)) if self.usb_intervals_ms else 0}

    def _run(self) -> None:
        display = None
        retry_at = 0.0
        count = 0
        while not self.stop.is_set():
            started = time.monotonic()
            try:
                with self.lock:
                    interval = self.interval
                    if len(self.frames) > 1:
                        # Stay on the GIF's time axis even if a USB write stalls.
                        # Otherwise a 100 ms animation sent at ~160 ms/USB frame
                        # plays in slow motion. Skip late frames rather than drift.
                        frame_index = animation_frame_index(started, self.sequence_started, interval, len(self.frames))
                        jpeg = self.frames[frame_index]
                    else:
                        jpeg = self.frames[0] if self.frames else None
                if jpeg is None:
                    self.stop.wait(0.25)
                    continue
                if display is None:
                    if started < retry_at:
                        self.stop.wait(min(0.5, retry_at - started))
                        continue
                    display = UsbDisplay()
                    event("usb_connected", device="0416:5408")
                ack = display.show(jpeg)
                count += 1
                ack_monotonic = time.monotonic()
                elapsed_ms = round((ack_monotonic - started) * 1000)
                with self.lock:
                    if self.last_ack_monotonic:
                        self.usb_intervals_ms.append(round((ack_monotonic - self.last_ack_monotonic) * 1000))
                        if len(self.usb_intervals_ms) > 32:
                            self.usb_intervals_ms.pop(0)
                    self.last_ack_monotonic = ack_monotonic
                    self.usb_frames = count
                    self.usb_ack_ms = round(time.time() * 1000)
                    self.usb_frame_ms = elapsed_ms
                if count <= 3 or count % 30 == 0:
                    event("usb_frame", count=count, bytes=len(jpeg), ack_bytes=ack,
                          elapsed_ms=elapsed_ms)
            except Exception as exc:
                event("usb_error", error=str(exc))
                if display:
                    display.close()
                display = None
                retry_at = time.monotonic() + 3
            with self.lock:
                sequence_started = self.sequence_started
                animated = len(self.frames) > 1
                current_interval = self.interval
            if animated:
                # Align the next attempt to the animation clock. A late USB
                # acknowledgment must not shift all subsequent GIF frames.
                elapsed = max(0.0, time.monotonic() - sequence_started)
                next_tick = sequence_started + (int(elapsed / current_interval) + 1) * current_interval
                self.stop.wait(max(0.001, next_tick - time.monotonic()))
            else:
                self.stop.wait(max(0.01, interval - (time.monotonic() - started)))
        if display:
            display.close()

    def close(self) -> None:
        self.stop.set()
        self.thread.join(timeout=5)


def convert_frame(png_path: Path, jpeg_path: Path, rotation: int) -> bytes:
    command = ["/usr/bin/sips", "-s", "format", "jpeg", str(png_path), "--out", str(jpeg_path)]
    subprocess.run(command, check=True, capture_output=True)
    if rotation:
        subprocess.run(["/usr/bin/sips", "-r", str(rotation), str(jpeg_path)], check=True, capture_output=True)
    jpeg = jpeg_path.read_bytes()
    frame_packets(jpeg)
    return jpeg


def rotate_frame(jpeg: bytes, jpeg_path: Path, rotation: int) -> bytes:
    if not rotation:
        return jpeg
    jpeg_path.write_bytes(jpeg)
    subprocess.run(["/usr/bin/sips", "-r", str(rotation), str(jpeg_path)], check=True, capture_output=True)
    rotated = jpeg_path.read_bytes()
    frame_packets(rotated)
    return rotated


def report_playback(url: str, token: str, status: dict) -> None:
    try:
        request_json(url, token=token, data=status, timeout=5)
    except Exception as exc:
        event("playback_report_error", error=str(exc))


def enroll(url: str) -> None:
    payload = request_json(
        url,
        data={"name": f"{socket.gethostname()} Side Display", "hostname": socket.gethostname(), "platform": platform.platform()},
    )
    save_private_json(STATE_FILE, payload)
    event("enrolled", device_id=payload["deviceId"], server=payload["serverBaseUrl"])


def run() -> None:
    state = json.loads(STATE_FILE.read_text())
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    worker = DisplayWorker()
    worker.start()
    jpeg_connection = JpegFrameConnection(state["frameUrl"], state["deviceToken"])
    retry_delay = 1
    next_jpeg_probe = 0.0
    next_bundle_probe = 0.0
    bundle_id = ""
    bundle_frame_id = ""
    next_playback_report = 0.0
    playback_thread = None
    last_frame_saved = 0.0
    APP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    png_path = APP_DIR / "frame.png"
    jpeg_path = APP_DIR / "frame.jpg"
    try:
        while not stopping.is_set():
            started = time.monotonic()
            try:
                bundle_active = False
                received_bytes = 0
                if started >= next_bundle_probe:
                    try:
                        mode, headers, bundle = jpeg_connection.read_bundle(bundle_id)
                        if mode == "updated":
                            frames = bundle["frames"]
                            rotation = int(state.get("rotation") or 0)
                            if rotation:
                                frames = tuple(rotate_frame(frame, jpeg_path, rotation) for frame in frames)
                            worker.update_sequence(frames, interval=bundle["intervalMs"] / 1000)
                            bundle_id = bundle["bundleId"]
                            bundle_frame_id = bundle["frameId"]
                            jpeg_path.write_bytes(frames[0])
                            last_frame_saved = time.monotonic()
                            received_bytes = sum(len(frame) for frame in frames)
                            event("animation_loaded", frame_id=bundle_frame_id, bundle_id=bundle_id,
                                  frame_count=len(frames), bytes=received_bytes)
                        elif mode == "unavailable":
                            bundle_id = ""
                            bundle_frame_id = ""
                            next_bundle_probe = time.monotonic() + 10
                        if mode != "unavailable":
                            bundle_active = True
                            source = "bundle" if mode == "updated" else "bundle-current"
                    except Exception as exc:
                        event("animation_bundle_fallback", error=str(exc))
                        next_bundle_probe = time.monotonic() + 30
                if not bundle_active:
                    source = "jpeg"
                    if started >= next_jpeg_probe:
                        try:
                            headers, jpeg = jpeg_connection.read()
                        except Exception as exc:
                            event("jpeg_frame_fallback", error=str(exc))
                            next_jpeg_probe = time.monotonic() + 30
                    if started < next_jpeg_probe:
                        source = "png-fallback"
                        headers = download(state["frameUrl"], state["deviceToken"], png_path)
                        jpeg = convert_frame(png_path, jpeg_path, int(state.get("rotation") or 0))
                    else:
                        jpeg = rotate_frame(jpeg, jpeg_path, int(state.get("rotation") or 0))
                    animated = headers.get("x-remotelab-display-animated") == "1" or headers.get("x-remotelab-display-poll-seconds") == "0.18"
                    worker.update(jpeg, interval=0.18 if animated else 0.5)
                    bundle_id = ""
                    bundle_frame_id = ""
                    received_bytes = len(jpeg)
                    if source == "jpeg" and time.monotonic() - last_frame_saved >= 5:
                        jpeg_path.write_bytes(jpeg)
                        last_frame_saved = time.monotonic()
                event(
                    "frame",
                    bytes=received_bytes,
                    source=source,
                    elapsed_ms=round((time.monotonic() - started) * 1000),
                    running=headers.get("x-remotelab-display-running", ""),
                    pending_review=headers.get("x-remotelab-display-pending-review", ""),
                )
                if time.monotonic() >= next_playback_report and (playback_thread is None or not playback_thread.is_alive()):
                    playback = worker.status()
                    if playback["usbAckMs"] and playback["animationFrames"]:
                        playback["bundleFrameId"] = bundle_frame_id
                        playback_thread = threading.Thread(target=report_playback,
                            args=(state["heartbeatUrl"], state["deviceToken"], playback), daemon=True)
                        playback_thread.start()
                    next_playback_report = time.monotonic() + 10
                retry_delay = 1
                try:
                    poll_seconds = float(headers.get("x-remotelab-display-poll-seconds") or state.get("pollSeconds") or 8)
                except (TypeError, ValueError):
                    poll_seconds = 8
                stopping.wait(max(0.05, min(30, poll_seconds) - (time.monotonic() - started)))
            except Exception as exc:
                event("server_error", error=str(exc))
                stopping.wait(retry_delay)
                retry_delay = min(retry_delay * 2, 15)
    finally:
        jpeg_connection.close()
        worker.close()


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: agent.py check-usb | check-device | enroll URL | run")
    if sys.argv[1] == "check-usb":
        print(find_libusb())
    elif sys.argv[1] == "check-device":
        display = UsbDisplay()
        display.close()
        event("device_ready", device="0416:5408")
    elif sys.argv[1] == "enroll" and len(sys.argv) == 3:
        enroll(sys.argv[2])
    elif sys.argv[1] == "run":
        run()
    else:
        raise SystemExit("usage: agent.py check-usb | check-device | enroll URL | run")


if __name__ == "__main__":
    main()
