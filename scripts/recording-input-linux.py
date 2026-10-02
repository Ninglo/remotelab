#!/usr/bin/env python3
"""Read explicitly bound keypads through evdev without grabbing normal keyboards."""
import glob
import json
import os
import selectors
import struct
import sys


def emit(value):
    print(json.dumps(value), flush=True)


def inventory():
    devices = []
    for path in sorted(glob.glob('/dev/input/by-id/*-event-kbd')):
        event = os.path.basename(os.path.realpath(path))
        try:
            with open('/sys/class/input/' + event + '/device/name') as source:
                name = source.read().strip()
        except OSError:
            name = os.path.basename(path)
        devices.append({'deviceId': path, 'name': name})
    return devices


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'list'
    if mode == 'list':
        emit(inventory())
        return
    if mode != 'listen' or len(sys.argv) < 3:
        raise ValueError('listen requires explicit /dev/input/by-id keypad paths')
    selector = selectors.DefaultSelector()
    packets = struct.Struct('llHHI')
    carry = {}
    for path in sys.argv[2:]:
        if not path.startswith('/dev/input/by-id/') or '..' in path.split('/'):
            raise ValueError('Bind an explicit /dev/input/by-id keypad path')
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            selector.register(fd, selectors.EVENT_READ, path)
            carry[fd] = b''
        except OSError as error:
            emit({'deviceId': path, 'error': str(error)})
    if not selector.get_map():
        raise ValueError('No configured keypad is readable; grant device access and retry')
    while selector.get_map():
        for entry, _ in selector.select():
            try:
                chunk = os.read(entry.fd, 4096)
            except OSError as error:
                emit({'deviceId': entry.data, 'error': str(error)})
                chunk = b''
            if not chunk:
                selector.unregister(entry.fd)
                os.close(entry.fd)
                carry.pop(entry.fd, None)
                continue
            data = carry[entry.fd] + chunk
            offset = 0
            while len(data) - offset >= packets.size:
                _, _, kind, code, value = packets.unpack_from(data, offset)
                offset += packets.size
                if kind == 1 and value == 1:  # key-down; ignore releases and auto-repeat
                    emit({'deviceId': entry.data, 'key': code, 'pressed': True})
            carry[entry.fd] = data[offset:]


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'error': str(error)})
        sys.exit(1)
