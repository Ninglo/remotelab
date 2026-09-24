#!/usr/bin/env python3
"""Minimal macOS display agent installed by one RemoteLab Server."""

from __future__ import annotations

import ctypes as C
import ctypes.util
import json
import os
import platform
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


class DisplayWorker:
    def __init__(self):
        self.jpeg: bytes | None = None
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def update(self, jpeg: bytes) -> None:
        frame_packets(jpeg)
        with self.lock:
            self.jpeg = jpeg

    def _run(self) -> None:
        display = None
        retry_at = 0.0
        count = 0
        while not self.stop.is_set():
            started = time.monotonic()
            try:
                with self.lock:
                    jpeg = self.jpeg
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
                if count <= 3 or count % 30 == 0:
                    event("usb_frame", count=count, bytes=len(jpeg), ack_bytes=ack)
            except Exception as exc:
                event("usb_error", error=str(exc))
                if display:
                    display.close()
                display = None
                retry_at = time.monotonic() + 3
            self.stop.wait(max(0.01, 0.5 - (time.monotonic() - started)))
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
    retry_delay = 1
    last_heartbeat = 0.0
    APP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    png_path = APP_DIR / "frame.png"
    jpeg_path = APP_DIR / "frame.jpg"
    try:
        while not stopping.is_set():
            try:
                headers = download(state["frameUrl"], state["deviceToken"], png_path)
                jpeg = convert_frame(png_path, jpeg_path, int(state.get("rotation") or 0))
                worker.update(jpeg)
                event(
                    "frame",
                    bytes=len(jpeg),
                    running=headers.get("x-remotelab-display-running", ""),
                    pending_review=headers.get("x-remotelab-display-pending-review", ""),
                )
                if time.monotonic() - last_heartbeat >= 10:
                    request_json(state["heartbeatUrl"], token=state["deviceToken"], data={"state": "running"})
                    last_heartbeat = time.monotonic()
                retry_delay = 1
                try:
                    poll_seconds = float(headers.get("x-remotelab-display-poll-seconds") or state.get("pollSeconds") or 8)
                except (TypeError, ValueError):
                    poll_seconds = 8
                stopping.wait(max(0.45, min(30, poll_seconds)))
            except Exception as exc:
                event("server_error", error=str(exc))
                stopping.wait(retry_delay)
                retry_delay = min(retry_delay * 2, 15)
    finally:
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
