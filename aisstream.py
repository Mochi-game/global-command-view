"""Live worldwide AIS from aisstream.io.

aisstream.io publishes decoded AIS over a WebSocket rather than as a REST feed:
you connect, say which boxes of ocean you care about, and messages arrive as
ships report. This module keeps that connection alive in a background thread and
maintains a table of what is currently afloat in the requested area, which the
server then serves like any other feed.

No third-party packages: the WebSocket client is a small implementation over
socket + ssl, which is enough for one long-lived client connection.
"""

import base64
import json
import os
import socket
import ssl
import struct
import threading
import time
import urllib.parse

STREAM_URL = "wss://stream.aisstream.io/v0/stream"
VESSEL_TTL = 1800  # drop a ship 30 minutes after its last report
RECONNECT_WAIT = 6
QUIET_WARNING = 60  # seconds of silence before saying so out loud


# --------------------------------------------------------------- websocket

class WebSocket:
    """The client half of RFC 6455, in the one shape this module needs."""

    def __init__(self, url, timeout=30):
        parts = urllib.parse.urlparse(url)
        port = parts.port or (443 if parts.scheme == "wss" else 80)
        path = parts.path or "/"
        raw = socket.create_connection((parts.hostname, port), timeout=timeout)
        if parts.scheme == "wss":
            raw = ssl.create_default_context().wrap_socket(
                raw, server_hostname=parts.hostname
            )
        self.sock = raw
        self.buffer = b""

        key = base64.b64encode(os.urandom(16)).decode()
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parts.hostname}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(handshake.encode())

        while b"\r\n\r\n" not in self.buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake closed by peer")
            self.buffer += chunk
        head, _, rest = self.buffer.partition(b"\r\n\r\n")
        self.buffer = rest
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(f"handshake refused: {head.splitlines()[0]!r}")

    def _read(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("stream closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:count], self.buffer[count:]
        return out

    def send(self, payload, opcode=1):
        if isinstance(payload, str):
            payload = payload.encode()
        header = bytearray([0x80 | opcode])
        size = len(payload)
        if size < 126:
            header.append(0x80 | size)
        elif size < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", size)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", size)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self):
        """Return the next text frame's payload, handling control frames."""
        while True:
            first, second = self._read(2)
            opcode = first & 0x0F
            masked = second & 0x80
            size = second & 0x7F
            if size == 126:
                size = struct.unpack(">H", self._read(2))[0]
            elif size == 127:
                size = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if masked else None
            payload = self._read(size)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

            if opcode == 0x8:  # close
                raise ConnectionError("peer closed the stream")
            if opcode == 0x9:  # ping
                self.send(payload, opcode=0xA)
                continue
            if opcode == 0xA:  # pong
                continue
            return payload

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ------------------------------------------------------------------ feed

class AisStream:
    """Background subscriber that keeps a table of ships in the wanted area."""

    def __init__(self, api_key, log=print):
        self.api_key = api_key
        self.log = log
        self.vessels = {}
        self.lock = threading.Lock()
        self.box = [[-90.0, -180.0], [90.0, 180.0]]
        self.box_serial = 0
        self.connected = False
        self.messages = 0
        threading.Thread(target=self._run, daemon=True).start()

    def want(self, lamin, lomin, lamax, lomax):
        """Ask for a different patch of ocean; reconnects if it really moved."""
        box = [[round(lamax, 2), round(lomin, 2)], [round(lamin, 2), round(lomax, 2)]]
        with self.lock:
            if box == self.box:
                return
            self.box = box
            self.box_serial += 1

    def snapshot(self, max_age=VESSEL_TTL):
        cutoff = time.time() - max_age
        with self.lock:
            return [v for v in self.vessels.values() if v["stamp"] > cutoff]

    def _run(self):
        while True:
            serial = self.box_serial
            try:
                self._session(serial)
            except Exception as exc:  # noqa: BLE001 - the stream must always come back
                self.connected = False
                self.log(f"aisstream: {exc}; reconnecting")
                time.sleep(RECONNECT_WAIT)

    def _session(self, serial):
        ws = WebSocket(STREAM_URL, timeout=20)
        with self.lock:
            box = list(self.box)
        # The subscription must arrive within three seconds of connecting.
        ws.send(json.dumps({"APIKey": self.api_key, "BoundingBoxes": [box]}))
        self.connected = True
        self.log(f"aisstream: subscribed to {box}")
        quiet_since = time.time()
        warned = False
        try:
            while True:
                if self.box_serial != serial:
                    # An active subscription can be updated on the same socket.
                    with self.lock:
                        box = list(self.box)
                        serial = self.box_serial
                    ws.send(json.dumps({"APIKey": self.api_key, "BoundingBoxes": [box]}))
                    self.log(f"aisstream: subscription moved to {box}")
                try:
                    self._absorb(json.loads(ws.recv()))
                    quiet_since = time.time()
                    warned = False
                except TimeoutError:
                    pass  # a quiet box is normal; a quiet planet is not
                if not warned and time.time() - quiet_since > QUIET_WARNING:
                    warned = True
                    self.log(
                        "aisstream: connected and subscribed but no messages for "
                        f"{QUIET_WARNING}s — check the key is active on aisstream.io"
                    )
        finally:
            self.connected = False
            ws.close()

    def _absorb(self, message):
        meta = message.get("MetaData") or {}
        mmsi = meta.get("MMSI") or meta.get("MMSI_String")
        if not mmsi:
            return
        mmsi = int(mmsi)
        body = (message.get("Message") or {})
        self.messages += 1

        with self.lock:
            vessel = self.vessels.setdefault(mmsi, {"mmsi": mmsi, "name": "", "kind": "",
                                                    "destination": "", "sog": 0.0,
                                                    "track": 0.0, "lat": 0.0, "lon": 0.0,
                                                    "stamp": 0.0})
            name = (meta.get("ShipName") or "").strip()
            if name:
                vessel["name"] = name

            report = body.get("PositionReport")
            if report:
                vessel.update({
                    "lat": report.get("Latitude", meta.get("latitude", 0.0)),
                    "lon": report.get("Longitude", meta.get("longitude", 0.0)),
                    "sog": report.get("Sog") or 0.0,
                    "track": (
                        report.get("TrueHeading")
                        if isinstance(report.get("TrueHeading"), (int, float))
                        and report["TrueHeading"] < 360
                        else report.get("Cog") or 0.0
                    ),
                    "stamp": time.time(),
                })

            static = body.get("ShipStaticData")
            if static:
                vessel["destination"] = (static.get("Destination") or "").strip()
                vessel["imo"] = static.get("ImoNumber") or 0
                vessel["callSign"] = (static.get("CallSign") or "").strip()
                vessel["shipType"] = static.get("Type") or 0
