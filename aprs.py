"""Live amateur radio positions from APRS-IS.

APRS is what radio amateurs use to say where they are: a packet with a position,
a symbol and often a comment, repeated by digipeaters and gatewayed onto the
internet by volunteers running igates. APRS-IS is the internet side of that — a
plain TCP firehose you can read without an account, and without a key.

Read-only access logs in as NOCALL with a pass of -1, which the servers accept as
unverified. Unverified means it can listen and never transmit, which is exactly
the contract wanted here: this app has nothing to say on the air.

The firehose is far too much traffic to take whole, so a server-side filter keeps
it to a radius around wherever the operator is looking. That filter can be changed
on the open connection rather than by reconnecting, which is both cheaper for the
server and politer.

No third-party packages: it is a socket and a line parser.
"""

import math
import re
import socket
import threading
import time

APRS_HOST = "rotate.aprs2.net"
APRS_PORT = 14580
STATION_TTL = 3600        # forget a station an hour after its last packet
RECONNECT_WAIT = 8
FILTER_MIN_GAP = 60       # do not re-aim the filter more than once a minute
MAX_STATIONS = 4000       # a bound, so a busy region cannot grow without limit

# "4903.50N/07201.75W-" — degrees, minutes, hemisphere, symbol table, symbol.
UNCOMPRESSED = re.compile(
    r"[!=/@](?:\d{6}[hz/])?"
    r"(\d{2})(\d{2}\.\d{2})([NS])(.)"
    r"(\d{3})(\d{2}\.\d{2})([EW])(.)"
)

# What the symbol character means, for the ones worth naming. APRS has a hundred
# and this is not a symbol table - it is the handful that answer "what is this".
SYMBOLS = {
    "-": "house", "k": "van", ">": "car", "j": "jeep", "U": "bus",
    "b": "bicycle", "<": "motorcycle", "_": "weather station",
    "O": "balloon", "^": "aircraft", "'": "small aircraft", "s": "boat",
    "Y": "yacht", "R": "recreational vehicle", "u": "truck",
    "I": "igate", "#": "digipeater", "&": "gateway", "a": "ambulance",
    "f": "fire truck", "P": "police", "*": "snowmobile", "$": "phone",
    "[": "person", "r": "repeater", "n": "node", "E": "eyeball",
}


def _dm_to_degrees(deg, minutes, hemisphere):
    value = int(deg) + float(minutes) / 60.0
    return -value if hemisphere in ("S", "W") else value


class AprsStream:
    """A long-lived reader of APRS-IS, with a table of who is where."""

    def __init__(self, log=print):
        self.log = log
        self.stations = {}
        self.lock = threading.Lock()
        self.connected = False
        self.packets = 0
        self._sock = None
        self._filter = None
        self._filter_at = 0.0
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    # ------------------------------------------------------------- public

    def aim(self, lat, lon, radius_km):
        """Point the filter somewhere, at most once a minute.

        APRS-IS takes a new filter on the open connection, so this is a line of
        text rather than a reconnection. The rate limit is manners: the server
        recomputes its routing every time this changes.
        """
        radius = max(50, min(int(radius_km), 5000))
        wanted = "r/%.1f/%.1f/%d" % (lat, lon, radius)
        if wanted == self._filter:
            return
        if time.time() - self._filter_at < FILTER_MIN_GAP:
            return
        self._filter = wanted
        self._filter_at = time.time()
        self._send("#filter t/p %s\r\n" % wanted)
        self.log("aprs: listening within %d km of %.1f, %.1f" % (radius, lat, lon))

    def in_box(self, west, south, east, north):
        """Stations inside a bounding box, freshest first."""
        cutoff = time.time() - STATION_TTL
        out = []
        with self.lock:
            for call, st in self.stations.items():
                if st["at"] < cutoff:
                    continue
                if not (south <= st["lat"] <= north):
                    continue
                if west <= east:
                    if not (west <= st["lon"] <= east):
                        continue
                elif not (st["lon"] >= west or st["lon"] <= east):
                    continue
                out.append(dict(st, call=call))
        out.sort(key=lambda x: x["at"], reverse=True)
        return out

    def stop(self):
        self._stop.set()
        self._send(None)

    # ------------------------------------------------------------ internals

    def _send(self, text):
        sock = self._sock
        if not sock:
            return
        try:
            if text is None:
                sock.close()
            else:
                sock.sendall(text.encode("ascii", "replace"))
        except OSError:
            pass

    def _run(self):
        while not self._stop.is_set():
            try:
                self._session()
            except Exception as exc:  # noqa: BLE001 - reconnect, always
                self.connected = False
                # Closing the socket to stop is not a fault worth reporting.
                if not self._stop.is_set():
                    self.log("aprs: %s, reconnecting" % exc)
            if not self._stop.is_set():
                time.sleep(RECONNECT_WAIT)

    def _session(self):
        sock = socket.create_connection((APRS_HOST, APRS_PORT), timeout=20)
        sock.settimeout(30)
        self._sock = sock
        sock.recv(512)  # the server's banner

        # Unverified login: read the stream, never transmit. t/p asks for
        # position packets only, which is most of the traffic we can use.
        start = self._filter or "r/59.3/18.1/2000"
        sock.sendall(
            ("user NOCALL pass -1 vers global-command-view 0.7 filter t/p %s\r\n"
             % start).encode("ascii")
        )
        self.connected = True
        self.log("aprs: connected to %s" % APRS_HOST)

        buf = b""
        last = time.time()
        while not self._stop.is_set():
            try:
                chunk = sock.recv(8192)
            except socket.timeout:
                # A quiet filter is normal; the server sends a comment line every
                # 20 seconds, so real silence means the link is gone.
                if time.time() - last > 90:
                    raise OSError("silent for 90 s")
                continue
            if not chunk:
                raise OSError("server closed the connection")
            last = time.time()
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                self._packet(line.decode("utf-8", "replace").strip())
            if len(buf) > 65536:
                buf = b""  # a line that long is not a packet

    def _packet(self, text):
        if not text or text.startswith("#"):
            return
        head, _, body = text.partition(":")
        if not body:
            return
        call = head.split(">")[0].strip()
        if not call:
            return
        match = UNCOMPRESSED.match(body)
        if not match:
            return  # compressed and object formats are skipped, not guessed at

        lat = _dm_to_degrees(match.group(1), match.group(2), match.group(3))
        lon = _dm_to_degrees(match.group(5), match.group(6), match.group(7))
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            return
        symbol = match.group(8)
        comment = body[match.end():].strip()

        self.packets += 1
        with self.lock:
            if len(self.stations) >= MAX_STATIONS and call not in self.stations:
                # Drop the stalest rather than refusing the newest.
                oldest = min(self.stations, key=lambda k: self.stations[k]["at"])
                del self.stations[oldest]
            self.stations[call] = {
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "symbol": symbol,
                "what": SYMBOLS.get(symbol, ""),
                "comment": comment[:80],
                "path": head.split(">", 1)[1][:60] if ">" in head else "",
                "at": time.time(),
            }
