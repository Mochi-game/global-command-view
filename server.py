#!/usr/bin/env python3
"""Global Command View - local server.

Serves the web client and proxies the public data feeds it uses. The proxy
exists for two reasons: the upstream APIs do not send permissive CORS headers,
and they are all rate limited, so responses are cached here instead of being
hammered by every browser tab.

Everything it talks to is public and key-free:
  flights   OpenSky Network      https://opensky-network.org/
  vessels   Digitraffic AIS      https://meri.digitraffic.fi/
  cables    TeleGeography        https://www.submarinecablemap.com/
  cameras   Digitraffic weathercam

    python server.py --port 8787
"""

import argparse
import gzip
import html as _html
import io
import array
import collections
import csv
import datetime
import email.utils
import json
import math
import os
import re
import stat as stat_module
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.90.1"
BUILT = "2026-08-19"

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
CACHE_DIR = os.path.join(ROOT, ".cache")

USER_AGENT = "global-command-view/0.1 (local research client)"
TIMEOUT = 30

# Optional API keys, kept out of git. See keys.example.json. Everything works
# without it; a key only adds camera networks that refuse anonymous callers.
KEYS = {}
_keys_path = os.path.join(ROOT, "keys.json")
if os.path.exists(_keys_path):
    try:
        with open(_keys_path, encoding="utf-8") as fh:
            KEYS = {k: v for k, v in json.load(fh).items() if v}
    except Exception as exc:  # noqa: BLE001 - a broken key file must not stop the server
        print(f"keys.json unreadable: {exc}")

# name -> (url, memory ttl seconds, disk ttl seconds or 0 for memory only)
FEEDS = {
    "vessels": ("https://meri.digitraffic.fi/api/ais/v1/locations", 15, 0),
    "vessel-meta": ("https://meri.digitraffic.fi/api/ais/v1/vessels", 3600, 86400),
    "cameras-fi": ("https://tie.digitraffic.fi/api/weathercam/v1/stations", 900, 86400),
    "cameras-uk": ("https://api.tfl.gov.uk/Place/Type/JamCam", 900, 86400),
    "cables": (
        "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json",
        86400,
        604800,
    ),
    "landings": (
        "https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json",
        86400,
        604800,
    ),
    # Orbital elements, not positions: the browser propagates them itself. They
    # are re-issued roughly daily, and CelesTrak asks callers not to poll harder.
    "satellites": (
        "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
        7200,
        86400,
    ),
    # Every quake worldwide in the last week, magnitude 2.5 and up.
    "quakes": (
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson",
        600,
        86400,
    ),
}

TEXT_FEEDS = {"satellites"}

# Worldwide AIS, if the user registered for it. Digitraffic covers the Baltic and
# nothing else, so without this key the sea is empty outside northern Europe.
AIS = None

FLIGHTS_URL = "https://opensky-network.org/api/states/all"
FLIGHTS_TTL = 12  # OpenSky refuses more than one anonymous poll per ~10s

# OpenSky hands out ~400 anonymous credits per IP per day. When they run out it
# answers 429 with a retry hint measured in hours, so the air layer falls back to
# the community ADS-B feeders at adsb.lol until the quota comes back.
# adsb.lol's feeders are almost all in Europe and North America — it answers with
# nothing at all over the Gulf, Japan or South America. adsb.fi has genuine global
# coverage but serves at most a 250 nm circle per call, so a wide view is stitched
# together from a grid of them.
ADSB_URL = "https://opendata.adsb.fi/api/v2/lat/{lat:.3f}/lon/{lon:.3f}/dist/{radius:.0f}"
# adsb.lol behind it, in that order and not the other way round: adsb.lol's
# feeders are almost all in Europe and North America, so it is the better
# second opinion over Sweden and no help at all over the Gulf. Two community
# networks having a bad afternoon at once is rarer than one.
ADSB_URLS = (
    ADSB_URL,
    "https://api.adsb.lol/v2/lat/{lat:.3f}/lon/{lon:.3f}/dist/{radius:.0f}",
)
ADSB_RADIUS_NM = 250
ADSB_MAX_CALLS = 8
ADSB_PACE = 1.2  # seconds between calls; adsb.fi allows roughly one per second
_opensky_blocked_until = 0.0

# adsb.lol keeps a military register keyed by ICAO hex. Neither feed marks the
# aircraft it returns, so the register is pulled separately and used to tag them
# whichever source the picture came from.
MIL_URL = "https://api.adsb.lol/v2/mil"
MIL_TTL = 120
_mil_hexes = set()
_mil_stamp = 0.0
_mil_lock = threading.Lock()


OPENSKY_TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/"
    "protocol/openid-connect/token"
)
_opensky_token = {"value": None, "expires": 0.0}


def opensky_token():
    """OAuth2 client-credentials token, if the user registered an OpenSky client.

    Worth having: OpenSky answers a single call for the whole planet, where the
    community feeders have to be stitched together 250 nm at a time.
    """
    client_id = KEYS.get("opensky_client_id")
    secret = KEYS.get("opensky_client_secret")
    if not client_id or not secret:
        return None
    if _opensky_token["value"] and time.time() < _opensky_token["expires"]:
        return _opensky_token["value"]

    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": secret,
    }).encode()
    req = urllib.request.Request(
        OPENSKY_TOKEN_URL,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        payload = json.loads(resp.read())
    _opensky_token["value"] = payload["access_token"]
    _opensky_token["expires"] = time.time() + payload.get("expires_in", 1800) - 60
    log("opensky: authenticated, global snapshots available")
    return _opensky_token["value"]


def military_hexes():
    global _mil_stamp
    if time.time() - _mil_stamp < MIL_TTL:
        return _mil_hexes
    with _mil_lock:
        if time.time() - _mil_stamp < MIL_TTL:
            return _mil_hexes
        try:
            data = json.loads(fetch(MIL_URL))
            fresh = {ac["hex"].lower() for ac in data.get("ac") or [] if ac.get("hex")}
            if fresh:
                _mil_hexes.clear()
                _mil_hexes.update(fresh)
            _mil_stamp = time.time()
            log(f"military register: {len(_mil_hexes)} airframes airborne")
        except Exception as exc:  # noqa: BLE001 - tagging is a bonus, not a feed
            _mil_stamp = time.time()  # do not retry in a tight loop
            log(f"military register unavailable: {exc}")
    return _mil_hexes

# The memory cache is bounded, because its keys are not. An aircraft type is
# keyed by hull, a street photo by a 100 m square, a road tile by its tile: every
# one of those grows with wherever you have been, and a plain dict would hold all
# of it for as long as the server runs. One day of flying around left 19 771
# aircraft entries on disk, and the same number would have sat in RAM alongside a
# lock object each.
#
# An OrderedDict gives least-recently-used order for free: read a key and it
# moves to the end, so eviction takes from the front. The disk cache is untouched
# by this — evicting from memory costs one file read, not a network round trip.
MEM_BUDGET_BYTES = 96 * 1024 * 1024
LOCK_BUDGET = 4096

_mem = collections.OrderedDict()
_mem_bytes = 0
_mem_guard = threading.Lock()
_locks = collections.OrderedDict()
_locks_guard = threading.Lock()


def log(*parts):
    print(time.strftime("[%H:%M:%S]"), *parts, flush=True)


def _mem_get(key):
    """Look up and mark as recently used."""
    with _mem_guard:
        hit = _mem.get(key)
        if hit is not None:
            _mem.move_to_end(key)
        return hit


def _mem_put(key, data):
    """Store, then evict from the cold end until inside the budget."""
    global _mem_bytes
    with _mem_guard:
        old = _mem.pop(key, None)
        if old is not None:
            _mem_bytes -= len(old[1])
        _mem[key] = (time.time(), data)
        _mem_bytes += len(data)
        evicted = 0
        while _mem_bytes > MEM_BUDGET_BYTES and len(_mem) > 1:
            _, cold = _mem.popitem(last=False)
            _mem_bytes -= len(cold[1])
            evicted += 1
        if evicted:
            log(f"cache: dropped {evicted} cold entries, "
                f"{_mem_bytes // (1024 * 1024)} MB held")


def _lock_for(key):
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = threading.Lock()
        else:
            _locks.move_to_end(key)
        # A lock currently held must not be dropped, or two threads would each
        # get a fresh one and both fetch the same URL.
        while len(_locks) > LOCK_BUDGET:
            cold_key, cold = _locks.popitem(last=False)
            if cold.locked():
                _locks[cold_key] = cold
                _locks.move_to_end(cold_key)
                break
        return lock


def fetch(url):
    """GET url and return decoded bytes. Digitraffic requires gzip."""
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
        return raw


# --------------------------------------------------------- disk cache bounds

# The disk cache had no bound at all and had reached 92 MB in 34 000 files.
#
# Measuring it first changed the design. It holds two populations that want
# opposite treatment:
#
#   eight files    mesh nodes, airports, power plants, two fire snapshots,
#                  satellites - 82 MB between them, and expensive to fetch again
#   ~34 000 files  per-query answers, median 143 bytes, ~10 MB in total
#
# So plain least-recently-used over everything would be actively wrong. Left to
# itself it would drop meshnodes.json, untouched for three days, to reclaim 30 MB
# - and the next request downloads those same 30 MB back. Small files go first,
# and the big ones are only touched if dropping every small file was not enough.
#
# Two ceilings, because bytes and file count are different problems. Half a
# gigabyte is nothing on disk, but at a 143-byte median it would hold over a
# million files, and a directory that size is slow to list, slow to back up and
# unpleasant to open. The count is what actually needs holding down.
DISK_BUDGET_BYTES = 500 * 1024 * 1024
DISK_MAX_FILES = 40000
DISK_LARGE_FILE = 1024 * 1024      # above this, evicted only as a last resort
DISK_SWEEP_EVERY = 400             # writes between sweeps; stat'ing 34 000 files
                                   # on every write would cost more than it saves

_disk_writes = 0


def _sweep_disk(force=False):
    """Hold the cache under both ceilings, oldest and smallest first."""
    global _disk_writes
    if not force:
        _disk_writes += 1
        if _disk_writes < DISK_SWEEP_EVERY:
            return
    _disk_writes = 0

    try:
        names = os.listdir(CACHE_DIR)
    except OSError:
        return

    small, large, total = [], [], 0
    for name in names:
        path = os.path.join(CACHE_DIR, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        if not stat_module.S_ISREG(st.st_mode):
            continue
        total += st.st_size
        (large if st.st_size >= DISK_LARGE_FILE else small).append(
            (st.st_mtime, st.st_size, path))

    count = len(small) + len(large)
    if total <= DISK_BUDGET_BYTES and count <= DISK_MAX_FILES:
        return

    freed = dropped = 0
    # Oldest first within each group, and the whole small group before any of the
    # large one.
    for group in (sorted(small), sorted(large)):
        for mtime, size, path in group:
            if total <= DISK_BUDGET_BYTES and count <= DISK_MAX_FILES:
                break
            try:
                os.remove(path)
            except OSError:
                continue
            total -= size
            count -= 1
            freed += size
            dropped += 1
    if dropped:
        log("cache: dropped %d files, freed %.1f MB, now %.1f MB in %d files"
            % (dropped, freed / 1e6, total / 1e6, count))


def _disk_path(key):
    return os.path.join(CACHE_DIR, key.replace("/", "_") + ".json")


def cached(key, url, mem_ttl, disk_ttl):
    """Return (payload_bytes, source) using memory then disk then network."""
    now = time.time()
    hit = _mem_get(key)
    if hit and now - hit[0] < mem_ttl:
        return hit[1], "memory"

    with _lock_for(key):
        hit = _mem_get(key)
        if hit and time.time() - hit[0] < mem_ttl:
            return hit[1], "memory"

        path = _disk_path(key)
        if disk_ttl and os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            if age < disk_ttl:
                with open(path, "rb") as fh:
                    data = fh.read()
                _mem_put(key, data)
                return data, "disk"

        try:
            data = fetch(url)
            log(f"fetched {key} ({len(data) // 1024} kB)")
        except urllib.error.HTTPError as exc:
            if exc.code == 403 and key == "satellites":
                # CelesTrak answers 403 when its data has not changed since your
                # last download. The cached elements are the correct response.
                log("celestrak: elements unchanged since last download, using cache")
            else:
                log(f"fetch failed for {key}: HTTP {exc.code}")
            if hit:
                return hit[1], "stale"
            if disk_ttl and os.path.exists(path):
                with open(path, "rb") as fh:
                    return fh.read(), "cached"
            raise
        except Exception as exc:  # noqa: BLE001 - any failure falls back to stale
            log(f"fetch failed for {key}: {exc}")
            if hit:
                return hit[1], "stale"
            if disk_ttl and os.path.exists(path):
                with open(path, "rb") as fh:
                    return fh.read(), "stale-disk"
            raise

        _mem_put(key, data)
        if disk_ttl:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(data)
            _sweep_disk()
        return data, "network"


TRAFIKVERKET_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json"
TRAFIKVERKET_QUERY = """<REQUEST>
  <LOGIN authenticationkey="{key}"/>
  <QUERY objecttype="Camera" schemaversion="1.0">
    <FILTER><EQ name="Active" value="true"/></FILTER>
    <INCLUDE>Id</INCLUDE><INCLUDE>Name</INCLUDE><INCLUDE>Description</INCLUDE>
    <INCLUDE>CountyNo</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE><INCLUDE>PhotoUrl</INCLUDE>
  </QUERY>
</REQUEST>"""

# The camera record carries a county number rather than a place name.
COUNTIES = {
    1: "Stockholm", 3: "Uppsala", 4: "Södermanland", 5: "Östergötland",
    6: "Jönköping", 7: "Kronoberg", 8: "Kalmar", 9: "Gotland", 10: "Blekinge",
    12: "Skåne", 13: "Halland", 14: "Västra Götaland", 17: "Värmland",
    18: "Örebro", 19: "Västmanland", 20: "Dalarna", 21: "Gävleborg",
    22: "Västernorrland", 23: "Jämtland", 24: "Västerbotten", 25: "Norrbotten",
}


def trafikverket_cameras():
    """Swedish road cameras. Free key, but the API refuses anonymous callers."""
    hit = _mem_get("cameras-se")
    path = _disk_path("cameras-se")
    if hit and time.time() - hit[0] < 86400:
        return json.loads(hit[1])
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400:
        with open(path, "rb") as fh:
            raw = fh.read()
        _mem_put("cameras-se", raw)
        return json.loads(raw)

    body = TRAFIKVERKET_QUERY.format(key=KEYS["trafikverket"]).encode()
    req = urllib.request.Request(
        TRAFIKVERKET_URL,
        data=body,
        headers={"Content-Type": "text/xml", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        payload = json.loads(resp.read())

    out = []
    for camera in payload["RESPONSE"]["RESULT"][0].get("Camera", []):
        point = (camera.get("Geometry") or {}).get("WGS84", "")  # "POINT (18.06 59.33)"
        try:
            lon, lat = (float(v) for v in point.split("(")[1].rstrip(")").split())
        except (IndexError, ValueError):
            continue
        if not camera.get("PhotoUrl"):
            continue
        county = (camera.get("CountyNo") or [None])[0]
        out.append({
            # Ids come as SE_STA_CAMERA_0_1075001058 or SE_STA_CAMERA_Orion_426
            "id": camera.get("Id", "").replace("SE_STA_CAMERA_", ""),
            "name": camera.get("Name") or "Camera",
            "area": COUNTIES.get(county, "Sweden"),
            "lat": lat,
            "lon": lon,
            # The bare URL serves a 10 kB thumbnail; fullsize is the real frame.
            "image": camera["PhotoUrl"] + "?type=fullsize",
            "source": "Trafikverket",
        })

    raw = json.dumps(out).encode()
    _mem_put("cameras-se", raw)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    _sweep_disk()
    log(f"cameras SE: {len(out)} stations")
    return out


WINDY_URL = (
    "https://api.windy.com/webcams/api/v3/webcams"
    "?limit=50&offset={offset}&include=location,images{filter}"
)

# Windy holds ~70 000 webcams but the free tier stops paging at about 1 050, so
# an unfiltered pull returns whatever is most popular — which turns out to be
# the Alps. These country buckets spend that budget on a global spread instead.
WINDY_REGIONS = [
    ("SE,NO,DK,FI,IS", 6),
    ("", 4),  # unfiltered: the most-viewed webcams worldwide
    ("US,CA,MX", 4),
    ("JP,KR,TH,IN,ID", 3),
    ("AU,NZ,BR,AR,CL,ZA", 3),
]


def windy_cameras():
    """Windy's global webcam network. Free key after registration, metered."""
    hit = _mem_get("cameras-windy")
    if hit and time.time() - hit[0] < 86400:
        return json.loads(hit[1])
    path = _disk_path("cameras-windy")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400:
        with open(path, "rb") as fh:
            raw = fh.read()
        _mem_put("cameras-windy", raw)
        return json.loads(raw)

    out = []
    seen = set()
    for countries, pages in WINDY_REGIONS:
        for page in range(pages):
            url = WINDY_URL.format(
                offset=page * 50,
                filter=f"&countries={countries}" if countries else "",
            )
            req = urllib.request.Request(
                url,
                headers={"x-windy-api-key": KEYS["windy"], "User-Agent": USER_AGENT},
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                payload = json.loads(resp.read())
            webcams = payload.get("webcams") or []
            if not webcams:
                break
            for cam in webcams:
                location = cam.get("location") or {}
                images = (cam.get("images") or {}).get("current") or {}
                webcam_id = str(cam.get("webcamId", ""))
                if not images.get("preview") or location.get("latitude") is None:
                    continue
                if webcam_id in seen:  # buckets overlap with the popular list
                    continue
                seen.add(webcam_id)
                out.append({
                    "id": webcam_id,
                    "name": cam.get("title") or "Webcam",
                    "area": ", ".join(
                        filter(None, [location.get("city"), location.get("country")])
                    ),
                    "lat": location["latitude"],
                    "lon": location["longitude"],
                    # Plain imgproxy paths with no expiry token: they always
                    # serve that webcam's current frame, so link them directly.
                    "image": images["preview"],
                    "source": "Windy",
                })

    raw = json.dumps(out).encode()
    _mem_put("cameras-windy", raw)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    _sweep_disk()
    log(f"cameras Windy: {len(out)} stations")
    return out


AIRCRAFT_URL = "https://api.adsbdb.com/v0/aircraft/{hex}"

# ICAO type designators for rotorcraft. ADS-B carries the type but never says
# "helicopter", so the list is the classifier.
ROTORCRAFT = {
    "A109", "A119", "A139", "A169", "A189", "AS32", "AS50", "AS55", "AS65",
    "B06", "B06T", "B105", "B212", "B222", "B230", "B407", "B412", "B427",
    "B429", "B430", "B505", "BK17", "EC20", "EC25", "EC30", "EC35", "EC45",
    "EC55", "EC75", "EH10", "EXPL", "GAZL", "H125", "H135", "H145", "H155",
    "H160", "H175", "H500", "H60", "HUCO", "KA32", "LYNX", "MD52", "MD60",
    "MI17", "MI24", "MI8", "NH90", "PUMA", "R22", "R44", "R66", "S276", "S61",
    "S76", "S92", "UH1", "UH60",
}

# Owner strings that mean a police operator, in the languages the registry uses.
POLICE_WORDS = (
    "police", "polizei", "politie", "polis", "politi", "policia", "polizia",
    "policja", "rendorseg", "gendarmerie", "guardia civil", "carabinieri",
    "sheriff", "state patrol", "state trooper", "garda", "npas",
    "public safety", "law enforcement",
)


def classify_owner(owner):
    """Police, or another state operator, or nothing — from the registry text."""
    low = (owner or "").lower()
    if any(word in low for word in POLICE_WORDS):
        return "police"
    for word in ("air force", "navy", "army", "military", "defence", "defense"):
        if word in low:
            return "military"
    for word in ("coast guard", "coastguard", "kustbevakning", "kystvakt", "border",
                 "maritime administration", "sjofartsverket", "sjöfartsverket",
                 "search and rescue", "rescue", "redningstjeneste", "raddning"):
        if word in low:
            return "coastguard"
    for word in ("ambulance", "hems", "air rescue", "rega", "medical", "lifeflight"):
        if word in low:
            return "medical"
    return ""


def aircraft_type(icao_hex):
    """Registry record for one airframe: type, owner and what that owner is.

    ADS-B tells you a hull is there, not what it is. adsbdb keeps the registry,
    and registry entries do not change, so each hex is asked for once ever.
    """
    key = f"actype_{icao_hex}"
    hit = _mem_get(key)
    if hit:
        return json.loads(hit[1])
    path = _disk_path(key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            raw = fh.read()
        _mem_put(key, raw)
        return json.loads(raw)

    record = {}
    try:
        payload = json.loads(fetch(AIRCRAFT_URL.format(hex=icao_hex)))
        aircraft = (payload.get("response") or {}).get("aircraft") or {}
        if aircraft:
            owner = aircraft.get("registered_owner") or ""
            record = {
                "reg": aircraft.get("registration") or "",
                "icao_type": aircraft.get("icao_type") or "",
                "type": aircraft.get("type") or "",
                "owner": owner,
                "country": aircraft.get("registered_owner_country_name") or "",
                "rotorcraft": (aircraft.get("icao_type") or "") in ROTORCRAFT,
                "role": classify_owner(owner),
            }
    except Exception:  # noqa: BLE001 - an unknown airframe is a normal answer
        record = {}

    raw = json.dumps(record).encode()
    _mem_put(key, raw)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    _sweep_disk()
    return record


PHOTO_URL = "https://api.planespotters.net/pub/photos/hex/{hex}"
ROUTE_URL = "https://api.adsbdb.com/v0/callsign/{callsign}"
# planespotters rejects generic library user agents and asks for a contact link.
PHOTO_AGENT = "global-command-view/0.9 (+http://localhost:8820 local research client)"


ESRI_IDENTIFY = (
    "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/identify"
)


MARKS_PATH = os.path.join(ROOT, "data", "marks.json")
_marks_lock = threading.Lock()


USAGE_PATH = os.path.join(ROOT, "data", "usage.json")

# What Google gives away each month on the Photorealistic 3D Tiles SKU before
# the first cent is charged. One request buys a session, not a tile.
GOOGLE_FREE_ROOTS = 1000


def _pacific_now():
    """Now, in US Pacific time.

    Google resets the free monthly allowance at midnight Pacific on the 1st, so
    counting in UTC would zero the tally seven or eight hours early and report a
    clean sheet while Google was still charging against the old month.

    zoneinfo is the right answer where the machine has a tz database. Windows
    ships none, so the US rule is spelled out as the fallback rather than adding
    a dependency: DST from the second Sunday in March to the first Sunday in
    November, both at 02:00 local.
    """
    utc = datetime.datetime.now(datetime.timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return utc.astimezone(ZoneInfo("America/Los_Angeles"))
    except Exception:  # noqa: BLE001 - no tz database, use the written rule
        pass

    def nth_sunday(year, month, nth):
        first = datetime.date(year, month, 1)
        # weekday(): Monday is 0, so Sunday is 6
        first_sunday = 1 + (6 - first.weekday()) % 7
        return datetime.date(year, month, first_sunday + 7 * (nth - 1))

    year = utc.year
    # 02:00 PST is 10:00 UTC; 02:00 PDT is 09:00 UTC
    starts = datetime.datetime.combine(
        nth_sunday(year, 3, 2), datetime.time(10), datetime.timezone.utc)
    ends = datetime.datetime.combine(
        nth_sunday(year, 11, 1), datetime.time(9), datetime.timezone.utc)
    offset = -7 if starts <= utc < ends else -8
    return utc + datetime.timedelta(hours=offset)


def _usage_month():
    return _pacific_now().strftime("%Y-%m")


def read_usage():
    """This month's billable requests, as counted by this app.

    Only this app's own asking is counted, and only since counting began. The
    authority is the Google Cloud console; this is a warning light, not a bill.
    """
    stored = {}
    if os.path.exists(USAGE_PATH):
        with open(USAGE_PATH, encoding="utf-8") as fh:
            stored = json.load(fh)
    month = _usage_month()
    services = stored.get("services", {})
    return json.dumps({
        "month": month,
        "google_root": stored.get("months", {}).get(month, 0),
        "free_limit": GOOGLE_FREE_ROOTS,
        "streetview": services.get("google_streetview", {}).get(month, 0),
        "streetview_limit": USAGE_LIMITS["google_streetview"],
        "since": stored.get("since", month),
    }).encode(), "disk"


# Street View images are billed per request with 10 000 free a month; the
# metadata lookups the app makes first are free and unlimited, and are not
# counted here because there is nothing to count.
USAGE_LIMITS = {"google_root": GOOGLE_FREE_ROOTS, "google_streetview": 10000}


def bump_usage(raw):
    """Record one billable Google request. Months are kept, so history stays."""
    incoming = json.loads(raw or b"{}")
    service = incoming.get("service", "google_root")
    if service not in USAGE_LIMITS:
        raise ValueError("unknown service")

    stored = {}
    if os.path.exists(USAGE_PATH):
        with open(USAGE_PATH, encoding="utf-8") as fh:
            stored = json.load(fh)
    stored.setdefault("since", _usage_month())
    month = _usage_month()
    # Photoreal sessions kept the bare month->count shape before there was a
    # second thing to count; that shape is still read, so old files still work.
    months = stored.setdefault("months", {})
    if service == "google_root":
        months[month] = months.get(month, 0) + 1
        used = months[month]
    else:
        per = stored.setdefault("services", {}).setdefault(service, {})
        per[month] = per.get(month, 0) + 1
        used = per[month]

    os.makedirs(os.path.dirname(USAGE_PATH), exist_ok=True)
    with open(USAGE_PATH, "w", encoding="utf-8") as fh:
        json.dump(stored, fh, indent=2)

    limit = USAGE_LIMITS[service]
    log(f"google {service} {used}/{limit} free this month")
    if used > limit:
        log(f"past the free allowance for {service} — further calls are billed",
            "warn")
    return json.dumps({"ok": True, "service": service, "used": used,
                       "free_limit": limit}).encode()


ALLOWED_KEYS = (
    "windy", "trafikverket", "opensky_client_id", "opensky_client_secret",
    "aisstream", "cesium_ion", "google_maps", "openaq", "gfw", "tomtom",
)


def write_keys(raw):
    """Save API keys typed into the app, and start using them without a restart.

    Keys arrive from a page served on localhost only. Values are never logged and
    never handed back to the browser — the page is told which are set, nothing more.
    """
    global AIS
    incoming = json.loads(raw)
    stored = {}
    if os.path.exists(_keys_path):
        with open(_keys_path, encoding="utf-8") as fh:
            stored = json.load(fh)

    changed = []
    for field, value in incoming.items():
        if field not in ALLOWED_KEYS:
            continue
        value = (value or "").strip()
        if not value:
            continue
        stored[field] = value
        changed.append(field)

    if changed:
        with open(_keys_path, "w", encoding="utf-8") as fh:
            json.dump(stored, fh, indent=2)
        KEYS.clear()
        KEYS.update({k: v for k, v in stored.items() if v})
        _mem.pop("cameras", None)          # so a new camera key takes effect now
        _opensky_token.update({"value": None, "expires": 0.0})
        if "aisstream" in changed and AIS is None:
            try:
                from aisstream import AisStream
                AIS = AisStream(KEYS["aisstream"], log=log)
            except Exception as exc:  # noqa: BLE001
                log(f"aisstream unavailable: {exc}")
        log(f"keys updated: {', '.join(changed)}")

    return json.dumps({"ok": True, "saved": changed}).encode()


# --------------------------------------------------------------- wildfires

# NASA FIRMS publishes active fire detections as open CSV, no key and no
# registration — the same feed Worldview draws. VIIRS resolves 375 m against
# MODIS's 1 km, so both VIIRS platforms are used and MODIS is left out: it adds
# coarser duplicates of what the other two already saw.
#
# What these are is worth being exact about. They are *thermal anomalies*: a
# pixel the satellite judged much hotter than its surroundings. Wildfire is the
# common cause, but gas flares, volcanoes, steel works and deliberate
# agricultural burning all register the same way, and the bulk feed carries no
# field that separates them. So the layer says thermal, not wildfire.
FIRE_SOURCES = (
    ("fires-n20", "https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
                  "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv"),
    ("fires-npp", "https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
                  "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv"),
)
FIRE_TTL = 1800          # FIRMS republishes a few times a day; this is polite
FIRE_MAX_RETURNED = 4000  # per request, hottest first, and it says when it cuts

# Parallel arrays rather than 213 000 tuples: the same data costs about 4 MB
# this way and some 45 MB the obvious way, and the whole point of the last
# release was to stop the server hoarding.
_fire_lat = array.array("f")
_fire_lon = array.array("f")
_fire_frp = array.array("f")      # radiative power, megawatts — the intensity
_fire_bright = array.array("f")   # brightness temperature, kelvin
_fire_when = array.array("i")     # minutes since the epoch, UTC
_fire_meta = array.array("B")     # satellite, confidence and day/night, packed
_fires_at = 0.0
_fires_lock = threading.Lock()

FIRE_SATS = ("N20", "N", "T", "A", "?")
FIRE_CONF = ("low", "nominal", "high", "?")


def _fire_meta_byte(satellite_code, confidence):
    sat = FIRE_SATS.index(satellite_code) if satellite_code in FIRE_SATS else 4
    conf = FIRE_CONF.index(confidence) if confidence in FIRE_CONF else 3
    return sat * 8 + conf * 2


def _parse_fires():
    """Rebuild the arrays from the two CSVs. Held under the lock by callers."""
    lat, lon, frp = array.array("f"), array.array("f"), array.array("f")
    bright, when, meta = array.array("f"), array.array("i"), array.array("B")
    epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)

    for key, url in FIRE_SOURCES:
        try:
            raw, _ = cached(key, url, FIRE_TTL, FIRE_TTL)
        except Exception as exc:  # noqa: BLE001 - one platform may be down
            log(f"fires: {key} unavailable ({exc})")
            continue
        lines = raw.decode("utf-8", "replace").splitlines()
        for line in lines[1:]:
            parts = line.split(",")
            if len(parts) < 13:
                continue
            try:
                lat.append(float(parts[0]))
                lon.append(float(parts[1]))
                bright.append(float(parts[2]))
                frp.append(float(parts[11]))
                stamp = datetime.datetime.strptime(
                    parts[5] + parts[6].zfill(4), "%Y-%m-%d%H%M"
                ).replace(tzinfo=datetime.timezone.utc)
                when.append(int((stamp - epoch).total_seconds() // 60))
                night = 1 if parts[12].strip().upper() == "N" else 0
                meta.append(_fire_meta_byte(parts[7].strip(), parts[8].strip()) + night)
            except (ValueError, IndexError):
                # A malformed row is one detection, not a reason to lose the set.
                for arr in (lat, lon, bright, frp, when):
                    if len(arr) > len(meta):
                        arr.pop()
                continue

    return lat, lon, frp, bright, when, meta


def _load_fires():
    global _fire_lat, _fire_lon, _fire_frp, _fire_bright, _fire_when, _fire_meta
    global _fires_at
    with _fires_lock:
        if len(_fire_lat) and time.time() - _fires_at < FIRE_TTL:
            return
        started = time.time()
        parsed = _parse_fires()
        if not len(parsed[0]):
            log("fires: no detections parsed, keeping whatever we had")
            return
        (_fire_lat, _fire_lon, _fire_frp,
         _fire_bright, _fire_when, _fire_meta) = parsed
        _fires_at = time.time()
        log(f"fires: {len(_fire_lat)} thermal detections, "
            f"parsed in {time.time() - started:.1f}s")


def fires(bbox):
    """Detections inside bbox, hottest first, capped and honest about it."""
    _load_fires()
    west, south, east, north = bbox
    wraps = west > east

    picked = []
    for i in range(len(_fire_lat)):
        lat = _fire_lat[i]
        if lat < south or lat > north:
            continue
        lon = _fire_lon[i]
        if wraps:
            if lon < west and lon > east:
                continue
        elif lon < west or lon > east:
            continue
        picked.append(i)

    picked.sort(key=lambda i: _fire_frp[i], reverse=True)
    total = len(picked)
    shown = picked[:FIRE_MAX_RETURNED]
    if total > len(shown):
        log(f"fires: {total} in view, sending the {len(shown)} hottest")

    out = []
    for i in shown:
        meta = _fire_meta[i]
        out.append([
            round(_fire_lat[i], 5), round(_fire_lon[i], 5),
            round(_fire_frp[i], 2), round(_fire_bright[i], 1),
            _fire_when[i],
            FIRE_SATS[meta // 8],
            FIRE_CONF[(meta % 8) // 2],
            "N" if meta % 2 else "D",
        ])
    return json.dumps({
        "fires": out,
        "total_in_view": total,
        "returned": len(out),
        "capped": total > len(out),
        "as_of_minutes": max((_fire_when[i] for i in shown), default=0),
        "source": "NASA FIRMS · VIIRS NOAA-20 and Suomi-NPP, last 24 h",
    }).encode(), "memory"


# ------------------------------------------------------- satellite dossier

# CelesTrak's catalogue answers what an object *is*: payload or debris, whose,
# launched when, and the shape of its orbit. It does not say what the thing does,
# and it has no pictures. Wikipedia has both for anything notable, and nothing at
# all for the rocket bodies and fragments that are most of the catalogue - which
# is a true answer, and the panel says so rather than inventing one.
SATCAT_URL = "https://celestrak.org/satcat/records.php?CATNR={norad}&FORMAT=json"

SAT_OBJECT_TYPES = {
    "PAY": "payload",
    "R/B": "rocket body",
    "DEB": "debris",
    "UNK": "unknown",
}

# CelesTrak's own status letters. Anything unlisted passes through as given.
SAT_STATUS = {
    "+": "operational",
    "-": "nonoperational",
    "P": "partially operational",
    "B": "backup or standby",
    "S": "spare",
    "X": "extended mission",
    "D": "decayed",
    "?": "unknown",
}

# The owner codes that actually turn up often. The rest pass through as the code,
# which is better than a wrong guess at whose satellite you are looking at.
SAT_OWNERS = {
    "US": "United States", "CIS": "Russia / CIS", "PRC": "China",
    "ESA": "European Space Agency", "EUME": "EUMETSAT", "EUTE": "Eutelsat",
    "FR": "France", "UK": "United Kingdom", "JPN": "Japan", "IND": "India",
    "ISS": "International Space Station partners", "GER": "Germany",
    "ITSO": "Intelsat", "SES": "SES", "GLOB": "Globalstar", "ORB": "ORBCOMM",
    "IRID": "Iridium", "CA": "Canada", "SKOR": "South Korea", "TURK": "Turkey",
    "BRAZ": "Brazil", "SPN": "Spain", "IT": "Italy", "ARGN": "Argentina",
    "AUS": "Australia", "ISRA": "Israel", "NOR": "Norway", "SWED": "Sweden",
    "NETH": "Netherlands", "LUXE": "Luxembourg", "SAFR": "South Africa",
    "IRAN": "Iran", "NKOR": "North Korea", "UAE": "United Arab Emirates",
    "TBD": "not yet attributed",
}

SAT_SITES = {
    "TYMSC": "Baikonur, Kazakhstan", "AFETR": "Cape Canaveral, Florida",
    "AFWTR": "Vandenberg, California", "PLMSC": "Plesetsk, Russia",
    "FRGUI": "Kourou, French Guiana", "TTMTR": "Baikonur, Kazakhstan",
    "KSCUT": "Uchinoura, Japan", "TANSC": "Tanegashima, Japan",
    "SRILR": "Satish Dhawan, India", "JSC": "Jiuquan, China",
    "TSC": "Taiyuan, China", "XSC": "Xichang, China", "WSC": "Wenchang, China",
    "KODAK": "Kodiak, Alaska", "SEAL": "Sea Launch, Pacific",
    "SEMLS": "Semnan, Iran", "YUN": "Sohae, North Korea",
    "WLPIS": "Wallops Island, Virginia", "ERAS": "Eastern Range, at sea",
    "SNMLP": "San Marco, Kenya", "MAHIA": "Mahia, New Zealand",
}


def _wiki_title_for_satellite(name):
    """Turn a catalogue name into something Wikipedia might have an article on.

    Catalogue names are shouted and parenthesised: "ISS (ZARYA)", "NOAA 19",
    "SL-16 R/B". Constellations get one article for tens of thousands of members,
    so a Starlink is looked up as Starlink; the panel then says the article is
    about the constellation rather than about that particular spacecraft.

    Returns (candidates, is_fleet). Candidates are tried in order because one
    rule cannot spell every family: "NOAA 19" lives at NOAA-19 with a hyphen,
    "Kosmos 2221" keeps its space, and guessing wrong once used to mean no
    article at all. An empty list means do not look.
    """
    raw = (name or "").strip()
    if not raw:
        return [], False

    upper = raw.upper()
    # Debris and spent stages have no article, and searching for one returns
    # something misleading rather than nothing.
    if any(tag in upper for tag in (" DEB", "R/B", "DEBRIS", "FRAGMENT")):
        return [], False

    # The flag is whether the article covers a fleet rather than this object.
    # The ISS is one article about one thing; Starlink is one article about
    # eight thousand, and claiming it describes hull 1007 would be a lie.
    for prefix, title, is_fleet in (
        ("ISS", "International Space Station", False),
        ("STARLINK", "Starlink", True),
        ("ONEWEB", "OneWeb", True),
        ("IRIDIUM", "Iridium satellite constellation", True),
        ("GLOBALSTAR", "Globalstar", True),
        ("ORBCOMM", "Orbcomm", True),
        ("NAVSTAR", "Global Positioning System", True),
        ("GPS BII", "Global Positioning System", True),
        ("GALILEO", "Galileo (satellite navigation)", True),
        ("BEIDOU", "BeiDou", True),
        ("GLONASS", "GLONASS", True),
        ("PLANET", "Planet Labs", True),
        ("FLOCK", "Planet Labs", True),
        ("SPIRE", "Spire Global", True),
        ("QIANFAN", "Qianfan", True),
        ("HUBBLE", "Hubble Space Telescope", False),
        ("HST", "Hubble Space Telescope", False),
        ("CHANDRA", "Chandra X-ray Observatory", False),
        ("JWST", "James Webb Space Telescope", False),
        ("TIANGONG", "Tiangong space station", False),
    ):
        if upper.startswith(prefix):
            return [title], is_fleet

    # "COSMOS 2221" is spelled Kosmos on Wikipedia.
    if upper.startswith("COSMOS "):
        raw = "Kosmos " + raw.split(" ", 1)[1]

    # Drop the parenthesised alias, then spell the name the several ways
    # Wikipedia might have it. Its REST endpoint is case sensitive past the
    # first letter, and catalogue names are shouted: "SENTINEL-2" is a dead end
    # where "Sentinel-2" is an article. But "NOAA-19" really is upper case, so
    # the original spelling is tried before any prettified one.
    raw = re.sub(r"\s*\([^)]*\)", "", raw).strip()
    if not raw:
        return [], False

    candidates = []

    def offer(value):
        if value and value not in candidates:
            candidates.append(value)

    hyphenated = re.sub(r"^([A-Za-z]+)\s+(\d+[A-Za-z]?)$", r"\1-\2", raw)
    for base in (hyphenated, raw):
        offer(base)
        # Sentence case, for the many names that are words and not acronyms.
        if len(base) > 4:
            offer(base[:1].upper() + base[1:].lower())

    # A trailing letter marks one spacecraft of a family - Sentinel-2A is a
    # member of Sentinel-2 - and the family article is the honest fallback.
    for base in list(candidates):
        offer(re.sub(r"(\d)[A-Za-z]$", r"\1", base))

    return candidates[:6], False


def satellite_dossier(norad, name):
    """What one orbiting object is, and a picture if the world has one."""
    key = "satdoss_%s" % norad
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < 604800:
        return hit[1], "memory"
    path = _disk_path(key)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 2592000:
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    dossier = {}

    try:
        records = json.loads(fetch(SATCAT_URL.format(norad=int(norad))))
        if records:
            r = records[0]
            dossier["catalogue"] = {
                "name": r.get("OBJECT_NAME") or name,
                "designator": r.get("OBJECT_ID") or "",
                "kind": SAT_OBJECT_TYPES.get(
                    r.get("OBJECT_TYPE"), r.get("OBJECT_TYPE") or ""),
                "status": SAT_STATUS.get(
                    r.get("OPS_STATUS_CODE"), r.get("OPS_STATUS_CODE") or ""),
                "owner": SAT_OWNERS.get(r.get("OWNER"), r.get("OWNER") or ""),
                "launched": r.get("LAUNCH_DATE") or "",
                "site": SAT_SITES.get(
                    r.get("LAUNCH_SITE"), r.get("LAUNCH_SITE") or ""),
                "period_min": r.get("PERIOD"),
                "inclination": r.get("INCLINATION"),
                "apogee_km": r.get("APOGEE"),
                "perigee_km": r.get("PERIGEE"),
                "rcs_m2": r.get("RCS"),
                "decayed": r.get("DECAY_DATE") or "",
            }
    except Exception as exc:  # noqa: BLE001 - the orbit is still drawable
        log("satcat lookup failed for %s: %s" % (norad, exc))

    candidates, generic = _wiki_title_for_satellite(name)
    for title in candidates:
        try:
            page = json.loads(fetch(
                "https://en.wikipedia.org/api/rest_v1/page/summary/"
                + urllib.parse.quote(title.replace(" ", "_"))
            ))
            if page.get("type") == "standard" and page.get("extract"):
                returned = ((page.get("titles") or {}).get("normalized")
                            or page.get("title") or title)
                # A redirect to a broader page is not an article about this
                # object. Say which it is rather than implying the wrong one.
                redirected = returned.lower() != title.lower()
                thumb = (page.get("thumbnail") or {}).get("source")
                urls = page.get("content_urls") or {}
                dossier["about"] = {
                    "title": returned,
                    "summary": page["extract"],
                    "url": (urls.get("desktop") or {}).get("page", ""),
                    "photo": thumb or "",
                    "photo_full": (page.get("originalimage") or {}).get(
                        "source", thumb or ""),
                    "scope": ("constellation" if generic
                              else "related" if redirected else "object"),
                }
                break
        except Exception:  # noqa: BLE001 - most of the catalogue has no article
            continue

    raw = json.dumps(dossier).encode()
    _mem_put(key, raw)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    _sweep_disk()
    return raw, "network"


# ----------------------------------------------------------------- briefing

# Panning around the globe hoping to catch a megafire is not a way of finding
# one. This ranks what is actually happening right now and hands back somewhere
# to point the camera, with the reason attached.
#
# The important move is clustering the fires. A single 200 MW detection is as
# likely to be a gas flare as a forest; four hundred detections sharing half a
# degree of latitude is a fire front, and that is the thing worth looking at. So
# detections are binned and the bins are ranked by total radiative power, not by
# any one pixel's.

BRIEF_CELL = 0.5          # degrees; roughly 55 km of latitude
BRIEF_TTL = 300


def _fire_clusters(limit):
    """Group detections into cells and rank the cells by total power."""
    _load_fires()
    cells = {}
    for i in range(len(_fire_lat)):
        lat, lon = _fire_lat[i], _fire_lon[i]
        cell = (int(lat // BRIEF_CELL), int(lon // BRIEF_CELL))
        got = cells.get(cell)
        if got is None:
            cells[cell] = [_fire_frp[i], 1, lat, lon, _fire_when[i]]
        else:
            got[0] += _fire_frp[i]
            got[1] += 1
            got[2] += lat
            got[3] += lon
            got[4] = max(got[4], _fire_when[i])

    ranked = sorted(cells.values(), key=lambda c: c[0], reverse=True)[:limit]
    out = []
    for power, count, lat_sum, lon_sum, newest in ranked:
        # A handful of hot pixels is a flare stack or a furnace, not news.
        if count < 8:
            continue
        out.append({
            "kind": "fire",
            "score": power,
            "headline": "%s MW fire front, %d detections" % (round(power), count),
            "why": "total radiative power across %.0f km - a front, not a flare"
                   % (BRIEF_CELL * 111),
            "lat": lat_sum / count,
            "lon": lon_sum / count,
            # High enough that NASA's false colour is still near its native
            # resolution when the camera arrives, low enough that the cell
            # fills a useful part of the frame. Measured, not guessed.
            "altitude": 250000,
            "newest_minutes": newest,
            "source": "NASA FIRMS VIIRS, last 24 h",
        })
    return out


def _quake_events(limit):
    try:
        raw, _ = cached("quakes", *FEEDS["quakes"])
    except Exception as exc:  # noqa: BLE001
        log("briefing: quakes unavailable (%s)" % exc)
        return []
    out = []
    for f in json.loads(raw).get("features", []):
        props = f.get("properties") or {}
        mag = props.get("mag")
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if mag is None or len(coords) < 2:
            continue
        out.append({
            "kind": "quake",
            # Magnitude is logarithmic, so a 6 must outrank a pile of 4s.
            "score": 10 ** mag / 1000.0,
            "headline": "M %.1f - %s" % (mag, props.get("place") or "unknown"),
            "why": "depth %s km%s" % (
                round(coords[2]) if len(coords) > 2 else "?",
                ", tsunami warning issued" if props.get("tsunami") else "",
            ),
            "lat": coords[1],
            "lon": coords[0],
            "altitude": 400000,
            "at": props.get("time"),
            # Not shown as its own line - it is already in the headline - but a
            # news search for "earthquake" alone is no search at all.
            "news_place": props.get("place") or "",
            "source": "USGS, magnitude 2.5 and up, last 7 days",
        })
    out.sort(key=lambda e: e["score"], reverse=True)
    return out[:limit]


def _military_air(limit):
    """State aircraft anywhere the flight cache has already looked."""
    seen = {}
    for key in list(_mem.keys()):
        if not key.startswith("flights:"):
            continue
        hit = _mem_get(key)
        if not hit:
            continue
        try:
            states = json.loads(hit[1]).get("states") or []
        except Exception:  # noqa: BLE001
            continue
        for st in states:
            if len(st) < 20 or not st[19]:
                continue
            if st[5] is None or st[6] is None:
                continue
            icao = st[0]
            alt = st[13] if len(st) > 13 and st[13] is not None else st[7]
            seen[icao] = {
                "kind": "military",
                # Altitude alone is a poor ranking, but a tanker at 10 km over
                # open water is more interesting than a trainer in the circuit.
                "score": (alt or 0) / 1000.0,
                "headline": "%s - military contact" % ((st[1] or icao).strip() or icao),
                "why": "%s, %s" % (
                    (st[2] or "unknown operator").strip(),
                    "on the ground" if st[8] else "%d ft" % round((alt or 0) * 3.281),
                ),
                "lat": st[6],
                "lon": st[5],
                "altitude": 60000,
                "source": "ADS-B, military flag from the hex allocation register",
            }
    out = sorted(seen.values(), key=lambda e: e["score"], reverse=True)
    return out[:limit]


# ------------------------------------------------------------ what is known

# FIRMS says a place is hot. It never says whether anybody has noticed.
#
# GDACS is the EU Joint Research Centre's alert system: it pools the official
# reporting - burnt area from GWIS, magnitudes from the seismic networks - and
# publishes what has crossed an international threshold. Cross-referencing our
# own detections against it answers the question worth asking on air: is this
# fire in the record, or is it just burning?
#
# The honest reading of a miss is narrow. No GDACS entry means no *international*
# alert, and their wildfire threshold is a burnt area in hectares. A local fire
# service almost certainly knows about a fire GDACS has never heard of. So a miss
# is reported as "no international alert", never as "undiscovered", and a hit
# always carries the distance so the operator can judge whether it is even the
# same fire.
GDACS_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
GDACS_TTL = 900

# How far a briefing event may sit from an alert and still plausibly be it.
# GDACS publishes a centroid for a whole fire complex, which can be a long way
# from the hottest pixel in it.
GDACS_NEAR_KM = 60
GDACS_FAR_KM = 300


def _haversine_km(lat1, lon1, lat2, lon2):
    r_lat = math.radians(lat2 - lat1)
    r_lon = math.radians(lon2 - lon1)
    a = (math.sin(r_lat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(r_lon / 2) ** 2)
    return 6371.0 * 2 * math.asin(min(1.0, math.sqrt(a)))


def gdacs_events():
    """Current GDACS alerts, flattened to what a caption needs."""
    try:
        raw, _ = cached("gdacs", GDACS_URL, GDACS_TTL, GDACS_TTL)
    except Exception as exc:  # noqa: BLE001 - a missing alert list is not fatal
        log("gdacs unavailable (%s)" % exc)
        return []

    out = []
    for feature in json.loads(raw).get("features", []):
        pr = feature.get("properties") or {}
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        severity = pr.get("severitydata") or {}
        urls = pr.get("url") or {}
        out.append({
            "type": pr.get("eventtype"),
            "lat": coords[1],
            "lon": coords[0],
            "name": pr.get("name") or pr.get("description") or "",
            "level": pr.get("alertlevel") or "",
            "country": pr.get("country") or "",
            "severity": severity.get("severitytext") or "",
            "from": (pr.get("fromdate") or "")[:10],
            "to": (pr.get("todate") or "")[:10],
            "source": pr.get("source") or "GDACS",
            "report": urls.get("report") or "",
        })
    return out


def _attach_alerts(events):
    """Say, for each briefing event, what the alert system has on it."""
    alerts = gdacs_events()
    wanted = {"fire": "WF", "quake": "EQ"}

    for event in events:
        # Anything that came from GDACS already knows what the record says.
        if event.get("reported"):
            continue
        kind = wanted.get(event["kind"])
        if not kind:
            continue
        nearest, nearest_km = None, None
        for alert in alerts:
            if alert["type"] != kind:
                continue
            km = _haversine_km(event["lat"], event["lon"], alert["lat"], alert["lon"])
            if nearest_km is None or km < nearest_km:
                nearest, nearest_km = alert, km

        if nearest is None or nearest_km > GDACS_FAR_KM:
            event["reported"] = {
                "state": "none",
                # Deliberately not "unknown to the world".
                "text": "no international alert on record",
                "caveat": "GDACS alerts above a threshold, so a local service "
                          "may well know about this already",
            }
            continue

        event["reported"] = {
            "state": "match" if nearest_km <= GDACS_NEAR_KM else "nearby",
            "text": nearest["name"],
            "level": nearest["level"],
            "severity": nearest["severity"],
            "country": nearest["country"],
            "window": " to ".join(x for x in (nearest["from"], nearest["to"]) if x),
            "source": nearest["source"],
            "report": nearest["report"],
            "km": round(nearest_km),
        }
    return events


# ------------------------------------------------------------------- places

# A coordinate is not an answer to "where am I". Nominatim turns one into a
# region and a country, which is the difference between 63.5, -118.8 and the
# Northwest Territories.
#
# Their terms allow one request a second and ask for a real User-Agent, so this
# serialises behind a lock with a minimum interval and caches hard: coordinates
# are rounded to a tenth of a degree, which is about 11 km, and a region does not
# change at that scale. A whole briefing needs a handful of lookups, once.
NOMINATIM_URL = ("https://nominatim.openstreetmap.org/reverse"
                 "?lat={lat}&lon={lon}&format=json&zoom=5&accept-language=en")
NOMINATIM_GAP = 1.2
_nominatim_lock = threading.Lock()
_nominatim_last = [0.0]


def place_name(lat, lon):
    """Region and country for a point, or an empty string if unknown."""
    key = "place_%.1f_%.1f" % (lat, lon)
    hit = _mem_get(key)
    if hit:
        return json.loads(hit[1]).get("place", "")
    path = _disk_path(key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return json.loads(data).get("place", "")

    record = {"place": ""}
    try:
        with _nominatim_lock:
            wait = NOMINATIM_GAP - (time.time() - _nominatim_last[0])
            if wait > 0:
                time.sleep(wait)
            raw = fetch(NOMINATIM_URL.format(lat=lat, lon=lon))
            _nominatim_last[0] = time.time()
        found = json.loads(raw)
        address = found.get("address") or {}
        country = address.get("country") or ""
        region = (address.get("state") or address.get("region")
                  or address.get("province") or address.get("county") or "")
        # Over open ocean Nominatim answers nothing, which is the honest answer.
        record["place"] = ", ".join(x for x in (region, country) if x)
        record["country"] = country
    except Exception as exc:  # noqa: BLE001 - a nameless place is acceptable
        log("place lookup failed for %.1f,%.1f: %s" % (lat, lon, exc))

    data = json.dumps(record).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    return record["place"]


def news_search(event):
    """A search, not a curated feed.

    Fetching articles needs an API that rate-limits or charges, and a stale
    headline is worse than none. A link the operator clicks is honest about what
    it is: somewhere to go and look, phrased from what we actually know.
    """
    where = event.get("place") or event.get("news_place") or ""
    terms = {
        "fire": "wildfire",
        "quake": "earthquake",
        "cyclone": "cyclone",
        "flood": "flood",
        "volcano": "volcano eruption",
        "drought": "drought",
        "outbreak": "outbreak",
    }.get(event["kind"], "")
    if not terms:
        return ""
    query = " ".join(x for x in (terms, where) if x)
    return ("https://news.google.com/search?q="
            + urllib.parse.quote(query) + "&hl=en-GB")


# ---------------------------------------------------------------- outbreaks

# WHO publishes Disease Outbreak News as OData, no key and no registration - the
# authoritative record of what is spreading where. ReliefWeb covers the same
# ground and more, but wants an approved application name, and a thing you hand
# to friends should not need one each.
#
# The API returns an arbitrary page unless told otherwise: unsorted, and full of
# 2001. Ordering by date and taking the top is the whole trick.
WHO_DON_URL = (
    "https://www.who.int/api/news/diseaseoutbreaknews"
    "?%24orderby=PublicationDateAndTime%20desc&%24top=40"
    "&%24select=Title,PublicationDateAndTime,ItemDefaultUrl,UrlName,DonId,Summary"
)
WHO_TTL = 21600          # six hours; these are published weekly at best

# Titles read "Ebola disease caused by Bundibugyo virus - Democratic Republic of
# the Congo", with either a dash or a comma before the place. These are the ones
# that name no single place, and must not be geocoded into the sea.
# Substrings, not exact matches: "Multi-country" slipped past an exact list and
# Nominatim placed it in British Columbia. A wrong dot is worse than no dot, so
# anything that reads as "more than one place" gets none.
WHO_NOWHERE = ("global", "multi", "worldwide", "multiple", "several countries",
               "region", "international")


def _split_outbreak_title(title):
    """Disease and place out of one WHO headline."""
    clean = (title or "").replace("\u2013", "-").replace("\u2014", "-").strip()
    for sep in (" - ", ", "):
        if sep in clean:
            head, _, tail = clean.rpartition(sep)
            place = tail.strip()
            if place and len(place) < 60:
                return head.strip(), place
    return clean, ""


def outbreaks():
    """Current disease outbreaks, placed where they can be."""
    key = "outbreaks"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < WHO_TTL:
        return hit[1], "memory"

    try:
        raw = fetch(WHO_DON_URL)
    except Exception as exc:  # noqa: BLE001
        log("who outbreaks unavailable (%s)" % exc)
        return json.dumps({"outbreaks": [], "error": str(exc)}).encode(), "error"

    seen_place = {}
    out = []
    for item in json.loads(raw).get("value", []):
        disease, place = _split_outbreak_title(item.get("Title"))
        when = (item.get("PublicationDateAndTime") or "")[:10]
        # ItemDefaultUrl is a slug, not a path: "/2026-DON613". Pasted straight
        # onto the domain it 404s, which is what it did. The reports live under
        # /emergencies/disease-outbreak-news/item/.
        slug = (item.get("UrlName") or item.get("DonId")
                or (item.get("ItemDefaultUrl") or "").lstrip("/"))
        url = ("https://www.who.int/emergencies/disease-outbreak-news/item/"
               + slug) if slug else ""

        # One outbreak gets many updates; the newest is the one worth a marker.
        marker = (disease.lower(), place.lower())
        if marker in seen_place:
            seen_place[marker]["updates"] += 1
            continue

        record = {
            "disease": disease,
            "place": place,
            "date": when,
            "url": url,
            "updates": 1,
            "lat": None,
            "lon": None,
            "placeable": bool(place) and not any(
                word in place.lower() for word in WHO_NOWHERE),
        }
        seen_place[marker] = record
        out.append(record)

    # Geocoding is paced by Nominatim's terms, so only the placeable ones and
    # only to a deadline. An outbreak with no dot is still worth listing.
    deadline = time.time() + 8.0
    for record in out:
        if not record["placeable"] or time.time() > deadline:
            continue
        point = country_point(record["place"])
        if point:
            record["lat"], record["lon"] = point

    data = json.dumps({
        "outbreaks": out,
        "source": "WHO Disease Outbreak News",
        "note": "the newest report per outbreak; earlier updates are counted, "
                "not listed",
    }).encode()
    _mem_put(key, data)
    return data, "network"


def country_point(name):
    """A point for a country or region name, cached hard and paced politely."""
    key = "countrypt_%s" % name.lower().replace(" ", "_")[:60]
    hit = _mem_get(key)
    if hit:
        got = json.loads(hit[1])
        return (got["lat"], got["lon"]) if got.get("lat") is not None else None
    path = _disk_path(key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        got = json.loads(data)
        return (got["lat"], got["lon"]) if got.get("lat") is not None else None

    record = {"lat": None, "lon": None}
    try:
        with _nominatim_lock:
            wait = NOMINATIM_GAP - (time.time() - _nominatim_last[0])
            if wait > 0:
                time.sleep(wait)
            raw = fetch(
                "https://nominatim.openstreetmap.org/search?q="
                + urllib.parse.quote(name)
                + "&format=json&limit=1&accept-language=en"
            )
            _nominatim_last[0] = time.time()
        found = json.loads(raw)
        if found:
            record = {"lat": float(found[0]["lat"]), "lon": float(found[0]["lon"])}
    except Exception as exc:  # noqa: BLE001 - an unplaced outbreak still lists
        log("country lookup failed for %s: %s" % (name, exc))

    data = json.dumps(record).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    return (record["lat"], record["lon"]) if record["lat"] is not None else None


# GDACS was already being downloaded whole and mined for two event types. The
# rest of it - cyclones, floods, volcanoes, droughts - was thrown away every
# fifteen minutes. These are alerts somebody has already judged worth issuing,
# which is a stronger signal than anything computed here.
GDACS_KINDS = {
    "TC": ("cyclone", "tropical cyclone"),
    "FL": ("flood", "flood"),
    "VO": ("volcano", "volcanic activity"),
    "DR": ("drought", "drought"),
}

GDACS_LEVEL_SCORE = {"Red": 3.0, "Orange": 2.0, "Green": 1.0}


def _gdacs_events(limit_per_kind=3):
    """Cyclones, floods, volcanoes and droughts, straight from the alert list."""
    out = []
    per_kind = {}
    for alert in gdacs_events():
        kind = GDACS_KINDS.get(alert["type"])
        if not kind:
            continue
        name, label = kind
        if per_kind.get(name, 0) >= limit_per_kind:
            continue
        per_kind[name] = per_kind.get(name, 0) + 1
        out.append({
            "kind": name,
            "score": GDACS_LEVEL_SCORE.get(alert["level"], 0.5),
            "headline": alert["name"] or label,
            "why": (alert["severity"]
                    if alert["severity"] and "Magnitude 0" not in alert["severity"]
                    else label),
            "lat": alert["lat"],
            "lon": alert["lon"],
            "altitude": 900000,
            "place": alert["country"],
            "source": "GDACS \u00b7 EU Joint Research Centre",
            "reported": {
                "state": "match",
                "text": alert["name"],
                "level": alert["level"],
                "severity": alert["severity"],
                "window": " to ".join(x for x in (alert["from"], alert["to"]) if x),
                "report": alert["report"],
                "km": 0,
            },
        })
    return out


def _outbreak_events(limit=3):
    """The newest placed outbreaks, as things to fly to.

    Only the ones with a point: a briefing entry that cannot be flown to is a
    headline, and the briefing is a list of places to look at. The rest are in
    the layer and on the WHO page either way.
    """
    try:
        raw, _ = outbreaks()
    except Exception as exc:  # noqa: BLE001
        log("briefing: outbreaks unavailable (%s)" % exc)
        return []

    out = []
    for record in json.loads(raw).get("outbreaks", []):
        if record["lat"] is None:
            continue
        out.append({
            "kind": "outbreak",
            # Dates sort naturally as strings in this format.
            "score": float(record["date"].replace("-", "") or 0),
            "headline": record["disease"],
            "why": (f'{record["updates"]} WHO reports'
                    if record["updates"] > 1 else "first WHO report"),
            "lat": record["lat"],
            "lon": record["lon"],
            # A country centroid is not a spot; stay high enough to say so.
            "altitude": 1800000,
            "place": record["place"],
            "at": None,
            "source": "WHO Disease Outbreak News",
            "reported": {
                "state": "match",
                "text": f'WHO Disease Outbreak News, {record["date"]}',
                "report": record["url"],
                "km": 0,
            },
        })
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- volcanoes

# The Smithsonian's Global Volcanism Program keeps the eruption catalogue, served
# as WFS with no key. GDACS has a volcano alert type but it fires rarely, so that
# slot in the briefing sat empty while two dozen volcanoes were erupting.
#
# The catalogue is curated rather than live: an eruption appears once somebody has
# confirmed it, and the newest start date can be months old. What it is good at is
# the opposite question - which eruptions are *still going* - because it carries a
# continuing flag. That is the list worth drawing, and it is dated so the lag is
# visible rather than implied away.
GVP_URL = (
    "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows"
    "?service=WFS&version=2.0.0&request=GetFeature"
    "&typeName=GVP-VOTW:E3WebApp_Eruptions1960"
    "&outputFormat=application/json&count=400&sortBy=StartDate%20D"
)
GVP_TTL = 43200          # twelve hours; the catalogue moves in days at best


def _gvp_date(raw):
    """GVP dates are YYYYMMDD integers, and sometimes only a year."""
    text = str(raw or "").strip()
    if len(text) == 8:
        return "%s-%s-%s" % (text[:4], text[4:6], text[6:])
    if len(text) == 4:
        return text
    return ""


def volcanoes():
    """Eruptions the Smithsonian still lists as continuing."""
    key = "volcanoes"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < GVP_TTL:
        return hit[1], "memory"

    try:
        raw = fetch(GVP_URL)
    except Exception as exc:  # noqa: BLE001
        log("volcanoes unavailable (%s)" % exc)
        return json.dumps({"volcanoes": [], "error": str(exc)}).encode(), "error"

    out = []
    for feature in json.loads(raw).get("features", []):
        pr = feature.get("properties") or {}
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        if str(pr.get("ContinuingEruption")).lower() not in ("true", "1"):
            continue
        vei = pr.get("ExplosivityIndexMax")
        out.append({
            "name": pr.get("VolcanoName") or "unnamed",
            "lat": coords[1],
            "lon": coords[0],
            "started": _gvp_date(pr.get("StartDate")),
            # The Volcanic Explosivity Index is logarithmic: 2 is a hundred times
            # the ejecta of 0, and 8 is Yellowstone.
            "vei": vei if vei not in ("", None) else None,
            "id": pr.get("Activity_ID") or pr.get("VolcanoNumber"),
        })

    data = json.dumps({
        "volcanoes": out,
        "source": "Smithsonian Global Volcanism Program",
        "note": "eruptions the catalogue still lists as continuing; a curated "
                "record rather than a live sensor, so a start date can be old "
                "and a finished eruption can linger",
    }).encode()
    _mem_put(key, data)
    log(f"volcanoes: {len(out)} continuing eruptions \u00b7 Smithsonian GVP")
    return data, "network"


def _volcano_events(limit=3):
    """The biggest continuing eruptions, for the briefing."""
    try:
        raw, _ = volcanoes()
    except Exception:  # noqa: BLE001
        return []

    ranked = []
    for v in json.loads(raw).get("volcanoes", []):
        try:
            vei = float(v["vei"]) if v["vei"] is not None else 0.0
        except (TypeError, ValueError):
            vei = 0.0
        ranked.append((vei, v))
    # VEI first, then the most recently started, because an old VEI 2 is less of
    # a story than one that began last month.
    ranked.sort(key=lambda pair: (pair[0], pair[1]["started"]), reverse=True)

    out = []
    for vei, v in ranked[:limit]:
        out.append({
            "kind": "volcano",
            "score": vei,
            "headline": f"{v['name']} erupting",
            "why": (f"VEI {v['vei']}, " if v["vei"] is not None else "")
                   + f"continuing since {v['started'] or 'an unrecorded date'}",
            "lat": v["lat"],
            "lon": v["lon"],
            "altitude": 300000,
            "place": "",
            "source": "Smithsonian Global Volcanism Program",
            "reported": {
                "state": "match",
                "text": "listed as a continuing eruption",
                "report": "https://volcano.si.edu/volcano.cfm?vn=%s" % (v["id"] or ""),
                "km": 0,
            },
        })
    return out


# -------------------------------------------------------------------- radio

# Some 900 people around the world have put a shortwave receiver on the public
# internet and left it open. Click one and you are listening to that antenna, on
# whatever frequency you tune, right now - a hurricane net from the Caribbean, a
# numbers station, Radio Havana, aircraft over the North Atlantic.
#
# The list comes from Pierre Ynard's mirror rather than kiwisdr.com directly,
# because that is what the mirror exists for: keeping the load off one volunteer's
# bandwidth. It regenerates about every half hour, so asking more often than that
# is asking for nothing new. Cached accordingly, and on disk too, so a restart
# does not re-fetch a megabyte.
KIWI_URL = "http://rx.linkfanel.net/kiwisdr_com.js"
KIWI_TTL = 1800


def _kiwi_point(gps):
    """GPS arrives as the string "(62.149054, 25.664383)"."""
    match = re.match(r"\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)", (gps or "").strip())
    if not match:
        return None
    try:
        return float(match.group(1)), float(match.group(2))
    except ValueError:
        return None


def _kiwi_band(bands):
    """"0-30000000" into something a person reads."""
    try:
        low, high = (int(x) for x in (bands or "").split("-"))
    except (ValueError, TypeError):
        return ""
    return "%g\u2013%g MHz" % (low / 1e6, high / 1e6)


def kiwisdr():
    """Public shortwave receivers, with somewhere to click and listen."""
    key = "kiwisdr"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < KIWI_TTL:
        return hit[1], "memory"
    path = _disk_path(key)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < KIWI_TTL:
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    try:
        raw = fetch(KIWI_URL).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        log("kiwisdr unavailable (%s)" % exc)
        return json.dumps({"receivers": [], "error": str(exc)}).encode(), "error"

    try:
        body = raw[raw.index("["):raw.rindex("]") + 1]
        # It is a JavaScript literal, so it carries trailing commas that JSON
        # refuses. Stripping them is cheaper than shipping a JS parser.
        body = re.sub(r",\s*([}\]])", r"\1", body)
        entries = json.loads(body)
    except Exception as exc:  # noqa: BLE001
        log("kiwisdr list unparseable (%s)" % exc)
        return json.dumps({"receivers": [], "error": "unparseable"}).encode(), "error"

    out = []
    for e in entries:
        if str(e.get("offline", "")).lower() == "yes":
            continue
        point = _kiwi_point(e.get("gps"))
        if not point:
            continue
        url = (e.get("url") or "").strip()
        if not url.startswith("http"):
            url = "http://" + url if url else ""
        try:
            users = int(e.get("users") or 0)
            slots = int(e.get("users_max") or 0)
        except ValueError:
            users, slots = 0, 0
        out.append({
            "name": (e.get("name") or "unnamed receiver")[:110],
            "lat": point[0],
            "lon": point[1],
            "url": url[:200],
            "place": (e.get("loc") or "")[:80],
            "band": _kiwi_band(e.get("bands")),
            "antenna": (e.get("antenna") or "")[:90],
            "users": users,
            "slots": slots,
            # Signal-to-noise as the receiver reports it: a rough guide to whether
            # this one is in a quiet field or next to a switch-mode power supply.
            "snr": (e.get("snr") or "")[:12],
            "hardware": (e.get("sdr_hw") or "")[:60],
        })

    data = json.dumps({
        "receivers": out,
        "source": "KiwiSDR network, via Pierre Ynard's rx.linkfanel.net mirror",
        "note": "open receivers other people are paying for. Slots are limited "
                "and shared; take one, listen, and leave.",
    }).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    log(f"radio: {len(out)} shortwave receivers online \u00b7 KiwiSDR network")
    return data, "network"


# ------------------------------------------------------------- space weather

# NOAA's Space Weather Prediction Center publishes the planetary K index minute
# by minute, public domain, no key. Kp runs 0 to 9 and is quasi-logarithmic: 4 is
# unsettled, 5 is a storm, 7 pushes aurora to mid-latitudes, 9 is the sort of
# night people photograph from Rome. It is the one number that says whether
# tonight is worth pointing a camera at the sky.
SWPC_KP_URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json"
SWPC_TTL = 600


def space_weather():
    key = "spaceweather"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < SWPC_TTL:
        return hit[1], "memory"
    try:
        rows = json.loads(fetch(SWPC_KP_URL))
    except Exception as exc:  # noqa: BLE001
        log("space weather unavailable (%s)" % exc)
        return json.dumps({"kp": None, "error": str(exc)}).encode(), "error"

    latest = rows[-1] if rows else {}
    # The estimated value moves smoothly; the integer is the official bin.
    try:
        estimated = float(latest.get("estimated_kp") or 0)
    except (TypeError, ValueError):
        estimated = 0.0
    kp = latest.get("kp_index")
    day = [r for r in rows[-1440:]]
    try:
        peak = max(float(r.get("estimated_kp") or 0) for r in day) if day else 0.0
    except ValueError:
        peak = 0.0

    level = ("quiet" if estimated < 4 else "unsettled" if estimated < 5
             else "storm" if estimated < 7 else "severe storm")
    data = json.dumps({
        "kp": kp,
        "estimated": round(estimated, 2),
        "peak_24h": round(peak, 2),
        "level": level,
        "at": latest.get("time_tag"),
        "source": "NOAA Space Weather Prediction Center",
        "note": "Kp 5 is a geomagnetic storm; 7 pushes aurora to mid-latitudes",
    }).encode()
    _mem_put(key, data)
    return data, "network"


# ------------------------------------------------------------ weather alerts

# The US National Weather Service publishes every active alert as GeoJSON, public
# domain, keyless. It wants a User-Agent that identifies you, and it refuses a
# `limit` parameter with a 400 - which cost a few minutes to work out.
#
# It is United States only. No equivalent open feed covers the rest of the world,
# and the layer name says so rather than leaving a European wondering why their
# storm is missing.
NWS_URL = "https://api.weather.gov/alerts/active"
NWS_TTL = 300


def weather_alerts():
    key = "nws"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < NWS_TTL:
        return hit[1], "memory"
    try:
        raw = fetch(NWS_URL)
    except Exception as exc:  # noqa: BLE001
        log("weather alerts unavailable (%s)" % exc)
        return json.dumps({"alerts": [], "error": str(exc)}).encode(), "error"

    out = []
    for feature in json.loads(raw).get("features", []):
        pr = feature.get("properties") or {}
        if pr.get("severity") not in ("Severe", "Extreme"):
            continue
        geom = feature.get("geometry") or {}
        point = _alert_point(geom)
        if not point:
            continue
        out.append({
            "event": pr.get("event") or "alert",
            "severity": pr.get("severity"),
            "urgency": pr.get("urgency"),
            "area": (pr.get("areaDesc") or "")[:120],
            "headline": (pr.get("headline") or "")[:200],
            "until": (pr.get("ends") or pr.get("expires") or "")[:16],
            "lat": point[0],
            "lon": point[1],
            "url": pr.get("@id") or "",
        })

    data = json.dumps({
        "alerts": out,
        "source": "US National Weather Service",
        "note": "United States only; severe and extreme alerts. Marker is the "
                "centre of the warned area, which can be a whole county.",
    }).encode()
    _mem_put(key, data)
    log(f"weather: {len(out)} severe or extreme US alerts \u00b7 NWS")
    return data, "network"


def _alert_point(geom):
    """Rough centre of an alert polygon, or None if it carries no geometry.

    Many alerts reference zones rather than shapes; those are skipped rather
    than guessed at, because a warning drawn in the wrong county is worse than
    one that is missing.
    """
    kind = geom.get("type")
    coords = geom.get("coordinates")
    if kind == "Point" and coords and len(coords) >= 2:
        return coords[1], coords[0]
    rings = []
    if kind == "Polygon":
        rings = coords or []
    elif kind == "MultiPolygon":
        for poly in (coords or []):
            rings.extend(poly)
    points = [pt for ring in rings for pt in ring if len(pt) >= 2]
    if not points:
        return None
    return (sum(p[1] for p in points) / len(points),
            sum(p[0] for p in points) / len(points))


# ------------------------------------------------------------- power plants

# WRI's Global Power Plant Database: some 35 000 stations with fuel type and
# capacity, CC BY 4.0. Static - it is a database release, not a feed - which
# makes it the cheapest possible layer: fetched once, kept on disk, and filtered
# by view like the fires are.
WRI_URL = ("https://raw.githubusercontent.com/wri/global-power-plant-database/"
           "master/output_database/global_power_plant_database.csv")
WRI_TTL = 2592000        # a month; the database is republished yearly at best

_plants = []
_plants_lock = threading.Lock()


def _load_plants():
    global _plants
    with _plants_lock:
        if _plants:
            return
        try:
            raw, _ = cached("powerplants", WRI_URL, WRI_TTL, WRI_TTL)
        except Exception as exc:  # noqa: BLE001
            log("power plants unavailable (%s)" % exc)
            return
        text = raw.decode("utf-8", "replace")
        reader = csv.DictReader(io.StringIO(text))
        rows = []
        for row in reader:
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            try:
                mw = float(row.get("capacity_mw") or 0)
            except ValueError:
                mw = 0.0
            rows.append((lat, lon, mw,
                         (row.get("primary_fuel") or "")[:20],
                         (row.get("name") or "")[:60],
                         (row.get("country_long") or "")[:40]))
        _plants = rows
        log(f"power plants: {len(rows)} stations loaded \u00b7 WRI")


def power_plants(bbox, min_mw=0.0):
    """Stations inside bbox, largest first, capped."""
    _load_plants()
    west, south, east, north = bbox
    picked = [p for p in _plants
              if south <= p[0] <= north and west <= p[1] <= east and p[2] >= min_mw]
    picked.sort(key=lambda p: p[2], reverse=True)
    total = len(picked)
    shown = picked[:1500]
    return json.dumps({
        "plants": [{"lat": p[0], "lon": p[1], "mw": round(p[2], 1),
                    "fuel": p[3], "name": p[4], "country": p[5]} for p in shown],
        "total_in_view": total,
        "capped": total > len(shown),
        "source": "WRI Global Power Plant Database, CC BY 4.0",
    }).encode(), "memory"


# --------------------------------------------------------------- head of state

# Wikidata answers who runs a country, under CC0, through SPARQL. Used by the
# place readout so a coordinate can become "Sweden - Ulf Kristersson" rather
# than a number and a flagless name.
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql?format=json&query=%s"
HEAD_TTL = 604800


def head_of_state(country):
    # With no country there is no query to run, and Wikidata's endpoint takes
    # its full timeout to say so. Thirty seconds for a blank is not politeness.
    country = (country or "").strip()
    if not country:
        return {}
    key = "headof_%s" % country.lower().replace(" ", "_")[:50]
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < HEAD_TTL:
        return json.loads(hit[1])
    query = (
        'SELECT ?govLabel ?headLabel WHERE {'
        ' ?c rdfs:label "%s"@en; wdt:P31/wdt:P279* wd:Q6256.'
        ' OPTIONAL { ?c wdt:P6 ?gov. } OPTIONAL { ?c wdt:P35 ?head. }'
        ' SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }'
        ' LIMIT 1'
    ) % country.replace('"', '')
    record = {}
    try:
        raw = fetch(WIKIDATA_SPARQL % urllib.parse.quote(query))
        rows = (json.loads(raw).get("results") or {}).get("bindings") or []
        if rows:
            record = {
                "government": (rows[0].get("govLabel") or {}).get("value", ""),
                "head_of_state": (rows[0].get("headLabel") or {}).get("value", ""),
            }
    except Exception as exc:  # noqa: BLE001
        log("head of state lookup failed for %s: %s" % (country, exc))
    _mem_put(key, json.dumps(record).encode())
    return record


# ----------------------------------------------------------- internet outages

# IODA at Georgia Tech watches the internet from three angles at once - BGP
# withdrawals, active probing, and darknet background noise - and raises an alert
# when a country or network goes quiet. A national outage is usually either a
# cable cut or a government, and either is a story.
#
# Their API wants absolute unix seconds; relative offsets are refused with a
# terse "'from' timestamp must be set", which is worth writing down because the
# documentation implies otherwise.
IODA_URL = ("https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts"
            "?from=%d&until=%d&limit=200")
IODA_TTL = 600


def internet_outages():
    key = "outages_net"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < IODA_TTL:
        return hit[1], "memory"

    now = int(time.time())
    try:
        raw = fetch(IODA_URL % (now - 10800, now))
    except Exception as exc:  # noqa: BLE001
        log("internet outages unavailable (%s)" % exc)
        return json.dumps({"outages": [], "error": str(exc)}).encode(), "error"

    # One entity can raise several alerts across the three data sources; the
    # interesting unit is the place, not the measurement.
    places = {}
    for row in json.loads(raw).get("data") or []:
        entity = row.get("entity") or {}
        name = entity.get("name") or ""
        kind = entity.get("type") or ""
        # Autonomous systems are numerous and mostly meaningless on a globe, and
        # IODA also reports them sliced by geography - "AS270 -- California" -
        # which is still a network and not a place. Only countries and regions
        # are things a viewer can be flown to.
        if not name or kind not in ("country", "region"):
            continue
        got = places.setdefault((kind, name), {
            "name": name, "kind": kind, "sources": set(), "level": row.get("level") or "",
        })
        got["sources"].add(row.get("datasource") or "?")

    out = []
    deadline = time.time() + 6.0
    for (kind, name), rec in sorted(places.items(), key=lambda kv: -len(kv[1]["sources"])):
        point = None
        if time.time() < deadline:
            point = country_point(name)
        out.append({
            "name": name,
            "scope": kind,
            "level": rec["level"],
            # Two or three independent methods agreeing is a real outage; one is
            # a measurement artefact as often as not.
            "sources": sorted(rec["sources"]),
            "confidence": len(rec["sources"]),
            "lat": point[0] if point else None,
            "lon": point[1] if point else None,
        })

    data = json.dumps({
        "outages": out,
        "source": "IODA, Georgia Tech Internet Intelligence Lab",
        "note": "three independent methods; agreement between them is the signal. "
                "Autonomous systems are omitted - only countries and regions.",
    }).encode()
    _mem_put(key, data)
    log(f"internet: {len(out)} regions with outage alerts \u00b7 IODA")
    return data, "network"


# ------------------------------------------------------------------ recon

# Public registry lookups: what a domain resolves to, who an address belongs to,
# which network announces it, and what it leaves open. All of it is published by
# the registries themselves; none of it touches the target.
#
# Guarded, because a lookup tool that will query anything is a way to make this
# server probe a private network on somebody else's behalf. Private, loopback and
# link-local addresses are refused before any request is made.
RECON_TTL = 3600
_PRIVATE_V4 = (
    (10, 0, 0, 0, 8), (127, 0, 0, 0, 8), (169, 254, 0, 0, 16),
    (172, 16, 0, 0, 12), (192, 168, 0, 0, 16), (100, 64, 0, 0, 10),
    (0, 0, 0, 0, 8), (224, 0, 0, 0, 4),
)


def _is_public_ip(text):
    parts = text.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(x) for x in parts]
    except ValueError:
        return False
    if any(o < 0 or o > 255 for o in octets):
        return False
    value = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]
    for a, b, c, d, bits in _PRIVATE_V4:
        net = (a << 24) | (b << 16) | (c << 8) | d
        mask = (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF
        if value & mask == net & mask:
            return False
    return True


def recon(kind, target):
    """One registry lookup, cached. Never touches the target itself."""
    target = (target or "").strip()[:120]
    if not target:
        raise ValueError("nothing to look up")

    key = "recon_%s_%s" % (kind, target.lower())
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < RECON_TTL:
        return hit[1], "memory"

    # The network lookup takes a prefix - 8.8.8.0/24 - so the guard checks the
    # address part and lets a CIDR suffix through.
    bare = target.split("/")[0]
    looks_like_ip = bare.count(".") == 3 and bare.replace(".", "").isdigit()
    if kind in ("geo", "ports", "whois", "net") and not _is_public_ip(bare):
        raise ValueError("that is not a public IP address")
    if kind != "net" and "/" in target:
        raise ValueError("a prefix only works with the network lookup")
    if kind == "dns" and looks_like_ip:
        raise ValueError("dns takes a hostname")

    urls = {
        "dns": "https://dns.google/resolve?name=%s&type=A" % urllib.parse.quote(target),
        "geo": "http://ip-api.com/json/%s" % urllib.parse.quote(target),
        "ports": "https://internetdb.shodan.io/%s" % urllib.parse.quote(target),
        "whois": "https://rdap.db.ripe.net/ip/%s" % urllib.parse.quote(target),
        "net": ("https://stat.ripe.net/data/prefix-overview/data.json?resource=%s"
                % urllib.parse.quote(target)),
    }
    if kind not in urls:
        raise ValueError("unknown lookup")

    try:
        raw = fetch(urls[kind])
        body = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("the registry did not answer (%s)" % exc)

    data = json.dumps({"kind": kind, "target": target, "result": body}).encode()
    _mem_put(key, data)
    log(f"recon {kind}: {target}")
    return data, "network"


# --------------------------------------------------------------- mesh radio

# Meshtastic is LoRa mesh networking on cheap hardware: a few dozen grams that
# relays text between nodes with no infrastructure at all. Liam Cottle runs a
# volunteer map that aggregates the ones reporting through the public MQTT
# bridge, and asks for daily polling - so this is fetched once a day, kept on
# disk, and filtered by view. The whole file is 30 MB, which is exactly why it
# must not be fetched per request.
#
# Coordinates arrive as integers scaled by ten million, which is the Meshtastic
# wire format rather than a mistake: 537100288 is 53.7100288.
MESH_URL = "https://meshtastic.liamcottle.net/api/v1/nodes"
MESH_TTL = 86400

_mesh = []
_mesh_lock = threading.Lock()


def _load_mesh():
    global _mesh
    with _mesh_lock:
        if _mesh:
            return
        try:
            raw, _ = cached("meshnodes", MESH_URL, MESH_TTL, MESH_TTL)
        except Exception as exc:  # noqa: BLE001
            log("mesh nodes unavailable (%s)" % exc)
            return
        rows = []
        for n in json.loads(raw).get("nodes") or []:
            lat_raw, lon_raw = n.get("latitude"), n.get("longitude")
            if not lat_raw or not lon_raw:
                continue
            lat, lon = lat_raw / 1e7, lon_raw / 1e7
            if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                continue
            rows.append((
                lat, lon,
                (n.get("long_name") or "")[:40],
                (n.get("short_name") or "")[:8],
                (n.get("hardware_model_name") or "")[:24],
                (n.get("region_name") or "")[:12],
                n.get("battery_level"),
            ))
        _mesh = rows
        log(f"mesh: {len(rows)} positioned Meshtastic nodes \u00b7 liamcottle.net")


def mesh_nodes(bbox):
    _load_mesh()
    west, south, east, north = bbox
    picked = [m for m in _mesh
              if south <= m[0] <= north and west <= m[1] <= east]
    shown = picked[:2000]
    return json.dumps({
        "nodes": [{"lat": m[0], "lon": m[1], "name": m[2], "short": m[3],
                   "hardware": m[4], "region": m[5], "battery": m[6]}
                  for m in shown],
        "total_in_view": len(picked),
        "capped": len(picked) > len(shown),
        "source": "Meshtastic public MQTT bridge, via Liam Cottle's map",
        "note": "only nodes that report through the public bridge; most mesh "
                "traffic is local and never appears here",
    }).encode(), "memory"


# --------------------------------------------------------------- news by place

# GDELT reads the world's news and tags each article with the country it came
# from. Aggregated, that answers a question no sensor can: where is attention
# right now. It is coverage and not events - a country with free press and one
# with none produce very different counts for the same trouble - and the card
# says so.
#
# They ask for one request every five seconds and mean it. A fifteen minute cache
# puts us far inside that, and the failures during development were all from
# testing in bursts.
GDELT_URL = ("https://api.gdeltproject.org/api/v2/doc/doc"
             "?query=%s&mode=artlist&maxrecords=250&format=json&sort=datedesc")
GDELT_TTL = 900
GDELT_BACKOFF = 600     # how long a 429 is believed before asking again
GDELT_KEEP = 6 * 3600   # how old a fallen-back answer may be and still help
GDELT_QUERY = "(protest OR clashes OR strike OR evacuation OR airstrike)"


def _last_good_news():
    """The newest news-heat answer still on disk, if it is not ancient."""
    path = _disk_path("newsheat")
    try:
        age = time.time() - os.path.getmtime(path)
        if age > GDELT_KEEP:
            return None
        with open(path, "rb") as fh:
            body = json.loads(fh.read())
    except Exception:  # noqa: BLE001 - having no fallback is a normal state
        return None
    body["stale_since"] = int(age)
    return json.dumps(body).encode()


def news_heat():
    key = "newsheat"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < GDELT_TTL:
        return hit[1], "memory"

    # A refusal is worth remembering. GDELT answer 429 when asked too often,
    # and the first version read that as "no data" and asked again on the next
    # call - the one behaviour guaranteed to keep the door shut.
    beaten = _mem_get(key + ":429")
    if beaten and time.time() - beaten[0] < GDELT_BACKOFF:
        stale = _last_good_news()
        if stale:
            return stale, "stale"
        return json.dumps({
            "places": [],
            "error": "rate limited by GDELT, backing off",
        }).encode(), "error"

    try:
        raw = fetch(GDELT_URL % urllib.parse.quote(GDELT_QUERY))
        payload = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - they rate-limit, and that is fair
        log("news heat unavailable (%s)" % exc)
        _mem_put(key + ":429", b"1")
        # Hours-old coverage beats an empty map as long as it is labelled, and
        # the client prints the age rather than the count on its own.
        stale = _last_good_news()
        if stale:
            log("news heat: serving the last good answer instead")
            return stale, "stale"
        return json.dumps({"places": [], "error": str(exc)}).encode(), "error"

    counts = {}
    samples = {}
    for article in payload.get("articles") or []:
        country = (article.get("sourcecountry") or "").strip()
        if not country:
            continue
        counts[country] = counts.get(country, 0) + 1
        samples.setdefault(country, {
            "title": (article.get("title") or "")[:140],
            "url": article.get("url") or "",
            "seen": (article.get("seendate") or "")[:8],
        })

    out = []
    deadline = time.time() + 6.0
    for country, count in sorted(counts.items(), key=lambda kv: -kv[1])[:25]:
        point = country_point(country) if time.time() < deadline else None
        if not point:
            continue
        out.append({
            "country": country,
            "articles": count,
            "top": samples.get(country, {}),
            "lat": point[0],
            "lon": point[1],
        })

    data = json.dumps({
        "places": out,
        "query": GDELT_QUERY,
        "source": "GDELT Project",
        "note": "counts articles, not events. A free press and a censored one "
                "report the same trouble very differently, so this measures "
                "attention rather than what happened.",
    }).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(_disk_path(key), "wb") as fh:
        fh.write(data)
    _sweep_disk()
    log(f"news: coverage from {len(out)} countries \u00b7 GDELT")
    return data, "network"


# ------------------------------------------------------------------- trains

# Amtrak positions, from the community amtraker mirror. Trains are the one form
# of transport this globe had nothing of, and the American network is the one
# that publishes openly enough to plot without a key.
#
# Digitraffic's Finnish train feed is not here, and not for want of trying: their
# train-locations endpoint answers 406 to every combination of Accept header I
# could construct, while the same host's AIS and camera feeds work fine. Rather
# than ship a broken layer, the gap is written down.
AMTRAK_URL = "https://api-v3.amtraker.com/v3/trains"
TRAIN_TTL = 120


def trains():
    key = "trains"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < TRAIN_TTL:
        return hit[1], "memory"

    try:
        raw = fetch(AMTRAK_URL)
        payload = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        log("trains unavailable (%s)" % exc)
        return json.dumps({"trains": [], "error": str(exc)}).encode(), "error"

    out = []
    for group in payload.values():
        for t in group:
            lat, lon = t.get("lat"), t.get("lon")
            if lat is None or lon is None:
                continue
            out.append({
                "number": str(t.get("trainNum") or ""),
                "route": (t.get("routeName") or "")[:40],
                "lat": lat,
                "lon": lon,
                "heading": t.get("heading") or "",
                "state": t.get("trainState") or "",
                "from": (t.get("origName") or "")[:34],
                "to": (t.get("destName") or "")[:34],
                "speed": t.get("velocity"),
            })

    data = json.dumps({
        "trains": out,
        "source": "Amtrak, via the community amtraker mirror",
        "note": "United States only. Finland's open train feed refuses every "
                "Accept header tried, so it is absent rather than broken.",
    }).encode()
    _mem_put(key, data)
    log(f"trains: {len(out)} Amtrak services running")
    return data, "network"


# --------------------------------------------------------------------- aprs

# Amateur radio operators broadcasting their own positions, gatewayed onto the
# internet by volunteers. APRS-IS takes read-only listeners without an account:
# logging in as NOCALL is unverified, which means it can listen and never
# transmit. That is the right contract - this app has nothing to say on the air.
APRS = None


def aprs_stations(bbox):
    """Who is on the air inside the view, and aim the filter there."""
    global APRS
    if APRS is None:
        try:
            from aprs import AprsStream
            APRS = AprsStream(log=log)
        except Exception as exc:  # noqa: BLE001
            log("aprs unavailable (%s)" % exc)
            return json.dumps({"stations": [], "error": str(exc)}).encode(), "error"

    west, south, east, north = bbox
    # The firehose is filtered server-side to a radius around the view, so it is
    # pointed at wherever the camera actually is.
    mid_lat = (south + north) / 2
    mid_lon = (west + east) / 2 if west <= east else 0.0
    span_km = max(abs(north - south), abs(east - west)) * 111 / 2
    APRS.aim(mid_lat, mid_lon, span_km + 100)

    found = APRS.in_box(west, south, east, north)
    now = time.time()
    out = [{
        "call": st["call"],
        "lat": st["lat"],
        "lon": st["lon"],
        "what": st["what"],
        "symbol": st["symbol"],
        "comment": st["comment"],
        "path": st["path"],
        "ago_s": int(now - st["at"]),
    } for st in found[:1500]]

    return json.dumps({
        "stations": out,
        "connected": APRS.connected,
        "held": len(APRS.stations),
        "packets": APRS.packets,
        "source": "APRS-IS, read-only",
        "note": "positions amateurs broadcast about themselves, relayed by "
                "volunteer igates. Compressed and object packets are skipped "
                "rather than guessed at.",
    }).encode(), "memory"



# ------------------------------------------------------------ entity graph

# An aircraft has an operator, an operator has a parent, a parent has a country
# and an owner. None of that is on the transponder, and all of it is on Wikidata,
# which is CC0 and answers without a key.
#
# Three calls: find the thing, read its claims, then resolve the Q-numbers those
# claims point at into names. Cached hard, because a company's parent does not
# change between Tuesdays.
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
ENTITY_TTL = 604800

# The properties worth showing. Wikidata has thousands; these are the ones that
# answer "what is this and who is behind it".
ENTITY_PROPS = [
    ("P31", "is a"),
    ("P17", "country"),
    ("P749", "parent"),
    ("P127", "owned by"),
    ("P169", "chief executive"),
    ("P159", "headquarters"),
    ("P452", "industry"),
    ("P137", "operator"),
    ("P1128", "employees"),
    ("P571", "founded"),
    ("P856", "website"),
    ("P414", "listed on"),
]


def _wikidata(params):
    query = dict(params)
    query["format"] = "json"
    return json.loads(fetch(WIKIDATA_API + "?" + urllib.parse.urlencode(query)))


def entity_graph(name):
    """What Wikidata knows about a named thing, one hop out."""
    key = "entity_%s" % re.sub(r"[^a-z0-9]+", "_", name.lower())[:50]
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < ENTITY_TTL:
        return hit[1], "memory"
    path = _disk_path(key)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < ENTITY_TTL:
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    record = {"query": name, "found": False}
    try:
        found = _wikidata({
            "action": "wbsearchentities", "search": name,
            "language": "en", "limit": 1, "type": "item",
        }).get("search") or []
        if found:
            qid = found[0]["id"]
            record.update({
                "found": True,
                "id": qid,
                "label": found[0].get("label") or name,
                "description": found[0].get("description") or "",
                "url": "https://www.wikidata.org/wiki/" + qid,
            })

            entity = _wikidata({
                "action": "wbgetentities", "ids": qid,
                "props": "claims|sitelinks", "languages": "en",
            })["entities"][qid]
            claims = entity.get("claims") or {}

            # Wikipedia, if there is an article, because a paragraph beats a
            # property list for a person reading it.
            enwiki = (entity.get("sitelinks") or {}).get("enwiki")
            if enwiki:
                record["wikipedia"] = ("https://en.wikipedia.org/wiki/"
                                       + urllib.parse.quote(enwiki["title"].replace(" ", "_")))

            links = []
            wanted_ids = set()
            for pid, label in ENTITY_PROPS:
                for claim in (claims.get(pid) or [])[:3]:
                    value = (claim.get("mainsnak") or {}).get("datavalue", {}).get("value")
                    if isinstance(value, dict) and value.get("id"):
                        wanted_ids.add(value["id"])
                        links.append({"relation": label, "qid": value["id"]})
                    elif isinstance(value, dict) and value.get("time"):
                        links.append({"relation": label, "text": value["time"][1:11]})
                    elif isinstance(value, dict) and value.get("amount"):
                        links.append({"relation": label,
                                      "text": value["amount"].lstrip("+")})
                    elif isinstance(value, str):
                        links.append({"relation": label, "text": value})

            # One more call resolves every Q-number at once rather than one each.
            if wanted_ids:
                labels = _wikidata({
                    "action": "wbgetentities",
                    "ids": "|".join(sorted(wanted_ids)[:50]),
                    "props": "labels", "languages": "en",
                }).get("entities") or {}
                for link in links:
                    qid_ref = link.get("qid")
                    if qid_ref:
                        got = labels.get(qid_ref) or {}
                        link["text"] = ((got.get("labels") or {}).get("en") or {}).get(
                            "value", qid_ref)
            record["links"] = links
    except Exception as exc:  # noqa: BLE001 - an unknown entity is a fine answer
        record["error"] = str(exc)[:120]

    data = json.dumps(record).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    return data, "network"


# ----------------------------------------------------------------- airports

# Aviation radio is the interesting kind, and most of it is out of reach here:
# tower and approach live on VHF around 118-137 MHz, and the KiwiSDR network
# stops at 30. The receivers can hear oceanic HF - Shanwick, Gander, the VOLMET
# weather broadcasts - and those presets exist, but they are not the tower.
#
# LiveATC carries the VHF feeds and sits behind a Cloudflare challenge that gates
# even robots.txt, which is a clear enough statement about automated access. So
# this does not fetch from them. It puts airports on the map and offers a link,
# which is a person clicking through to a website exactly as intended.
#
# The airport list is OurAirports: public domain, 86 000 entries, and only the
# large and medium ones are kept because a grass strip has no radio room.
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRPORTS_TTL = 2592000       # a month; runways do not move
_airports = []
_airport_codes = {}
_airports_at = 0.0
_airports_lock = threading.Lock()


def _load_airports():
    global _airports, _airport_codes, _airports_at
    with _airports_lock:
        if _airports and time.time() - _airports_at < AIRPORTS_TTL:
            return
        path = _disk_path("airports_csv")
        raw = None
        if os.path.exists(path) and time.time() - os.path.getmtime(path) < AIRPORTS_TTL:
            with open(path, "rb") as fh:
                raw = fh.read()
        if raw is None:
            try:
                raw = fetch(AIRPORTS_URL)
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write(raw)
                _sweep_disk()
            except Exception as exc:  # noqa: BLE001
                log("airports unavailable (%s)" % exc)
                return

        rows = []
        reader = csv.DictReader(io.StringIO(raw.decode("utf-8", "replace")))
        for r in reader:
            if r.get("type") not in ("large_airport", "medium_airport"):
                continue
            try:
                lat = float(r["latitude_deg"])
                lon = float(r["longitude_deg"])
            except (KeyError, TypeError, ValueError):
                continue
            rows.append({
                "icao": (r.get("icao_code") or r.get("ident") or "").strip(),
                "iata": (r.get("iata_code") or "").strip(),
                "name": (r.get("name") or "")[:70],
                "lat": lat,
                "lon": lon,
                "big": r["type"] == "large_airport",
                "town": (r.get("municipality") or "")[:40],
                "country": (r.get("iso_country") or "")[:2],
                "elev_ft": (r.get("elevation_ft") or "").strip(),
            })
        _airports = rows

        # The layer draws large and medium fields only, or the map is unreadable
        # over Europe. Search should still find ESGV: a small airfield is exactly
        # the kind of place somebody types a code for, and looking it up costs a
        # dictionary rather than a marker. Closed fields are left out - flying to
        # a runway that is not there any more helps nobody.
        codes = {}
        reader = csv.DictReader(io.StringIO(raw.decode("utf-8", "replace")))
        for r in reader:
            if r.get("type") == "closed":
                continue
            try:
                lat = float(r["latitude_deg"])
                lon = float(r["longitude_deg"])
            except (KeyError, TypeError, ValueError):
                continue
            record = {
                "icao": (r.get("icao_code") or r.get("ident") or "").strip(),
                "iata": (r.get("iata_code") or "").strip(),
                "name": (r.get("name") or "")[:70],
                "lat": lat, "lon": lon,
                "kind": (r.get("type") or "").replace("_", " "),
                "town": (r.get("municipality") or "")[:40],
                "country": (r.get("iso_country") or "")[:2],
            }
            for code in (record["icao"], record["iata"]):
                if code and code.upper() not in codes:
                    codes[code.upper()] = record
        _airport_codes = codes
        log("airports: %d codes indexed for search" % len(codes))
        _airports_at = time.time()
        log("airports: %d large and medium loaded \u00b7 OurAirports" % len(rows))


def airports(bbox):
    """Airports in view, biggest first."""
    _load_airports()
    west, south, east, north = bbox
    wraps = west > east
    out = []
    for a in _airports:
        if not (south <= a["lat"] <= north):
            continue
        if wraps:
            if a["lon"] < west and a["lon"] > east:
                continue
        elif not (west <= a["lon"] <= east):
            continue
        out.append(a)

    out.sort(key=lambda a: (not a["big"], a["name"]))
    return json.dumps({
        "airports": out[:900],
        "total_in_view": len(out),
        "source": "OurAirports, public domain",
        "note": "large and medium fields only. Tower and approach are VHF and "
                "cannot be heard on the shortwave receivers in this app; the "
                "card links to LiveATC, which carries them.",
    }).encode(), "memory"


# ---------------------------------------------------------------- broadcast

# Ordinary radio. Not shortwave, not a dispatcher, not a tower - the station
# somebody in that town actually has on in the car.
#
# None of the other radio layers can do this: FM broadcasting is 88-108 MHz and
# the KiwiSDR network stops at 30, so a receiver in Florida physically cannot
# hear a Florida FM station. What can is the station's own internet stream, and
# Radio Browser is the community catalogue of those - open, keyless, and asking
# only for a User-Agent that says who is calling.
#
# Only stations with coordinates are any use on a globe, so has_geo_info is not
# optional here. Plenty of good stations are therefore missing: the catalogue is
# volunteer-maintained and a station without a pin cannot be drawn.
RADIO_BROWSER = "https://de1.api.radio-browser.info/json/stations/search"
BROADCAST_TTL = 43200


def broadcast_stations(lat, lon, radius_km):
    """Internet streams of broadcast stations near a point."""
    radius = max(20, min(int(radius_km), 800))
    key = "broadcast_%.1f_%.1f_%d" % (round(lat, 1), round(lon, 1), radius)
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < BROADCAST_TTL:
        return hit[1], "memory"

    params = urllib.parse.urlencode({
        "geo_lat": "%.4f" % lat,
        "geo_long": "%.4f" % lon,
        "geo_distance": int(radius * 1000),
        "has_geo_info": "true",
        "hidebroken": "true",
        "limit": 250,
        "order": "clickcount",
        "reverse": "true",
    })
    try:
        raw = fetch(RADIO_BROWSER + "?" + params)
    except Exception as exc:  # noqa: BLE001
        log("broadcast unavailable (%s)" % exc)
        return json.dumps({"stations": [], "error": str(exc)}).encode(), "error"

    out = []
    for st in json.loads(raw):
        try:
            slat = float(st.get("geo_lat"))
            slon = float(st.get("geo_long"))
        except (TypeError, ValueError):
            continue
        url = (st.get("url_resolved") or st.get("url") or "").strip()
        if not url.startswith("http"):
            continue
        out.append({
            "name": (st.get("name") or "").strip()[:60],
            "lat": slat,
            "lon": slon,
            "url": url[:300],
            "codec": (st.get("codec") or "")[:10],
            "bitrate": st.get("bitrate") or 0,
            # An m3u8 playlist is HLS, which a plain audio element will not play
            # in every browser. Marked so the card can say so rather than
            # offering a play button that does nothing.
            "hls": bool(st.get("hls")) or url.endswith(".m3u8"),
            "tags": (st.get("tags") or "")[:70],
            "country": (st.get("country") or "")[:40],
            "state": (st.get("state") or "")[:40],
            "homepage": (st.get("homepage") or "")[:200],
            "clicks": st.get("clickcount") or 0,
        })

    data = json.dumps({
        "stations": out,
        "source": "Radio Browser, community catalogue",
        "note": "internet streams of broadcast stations. Only those with "
                "coordinates are listed, because a station without a pin cannot "
                "be drawn - so this is a subset of what is on the air.",
    }).encode()
    _mem_put(key, data)
    return data, "network"


# ----------------------------------------------------------------- incidents

# Where traffic is actually stopped, and why.
#
# The flow tiles colour a road by how fast it is moving, which is the picture.
# This is the reason: roadworks, a closure, a crash, a queue - each with the road
# it is on, how long the stretch is, and how many seconds it is costing.
#
# TomTom grade the delay from 1 to 4, and grade most things 0 for "unknown".
# That is not a failure to report, it is roadworks and closures, which block a
# road without there being a measured delay to quote. Both are drawn; only the
# graded ones get a colour that says how bad.
INCIDENT_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
INCIDENT_FIELDS = (
    "{incidents{type,geometry{type,coordinates},properties{iconCategory,"
    "magnitudeOfDelay,events{description,code},startTime,endTime,from,to,"
    "length,delay,roadNumbers}}}"
)
INCIDENT_TTL = 90   # the client asks every two minutes, so this has to be
                    # shorter than that or every other refresh is a no-op


def incidents(south, west, north, east):
    """Live traffic incidents in a box, from TomTom."""
    key = KEYS.get("tomtom", "")
    if not key:
        return json.dumps({
            "incidents": [],
            "needs_key": "tomtom",
            "how": "free tier at developer.tomtom.com - put it in keys.json as tomtom",
        }).encode(), "no key"

    # A whole-country box comes back as tens of thousands of roadworks and is
    # neither drawable nor useful, so this is refused rather than truncated.
    if north - south > 3.0 or east - west > 6.0:
        return json.dumps({
            "incidents": [],
            "too_wide": True,
            "note": "zoom in - incidents are a street-level answer",
        }).encode(), "refused"

    box = "%.3f,%.3f,%.3f,%.3f" % (west, south, east, north)
    cache = "tt_inc_" + box.replace(",", "_").replace(".", "p").replace("-", "m")
    hit = _mem_get(cache)
    if hit and time.time() - hit[0] < INCIDENT_TTL:
        return hit[1], "memory"

    url = INCIDENT_URL + "?" + urllib.parse.urlencode({
        "bbox": box,
        "fields": INCIDENT_FIELDS,
        "language": "en-GB",
        "key": key,
    })
    try:
        # The key is referrer-restricted in the dashboard, so the server has to
        # send one. It is the address this app is served from, which is true.
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Referer": "http://127.0.0.1:8820/",
        })
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = ("the key was refused - check the domain whitelist"
                  if exc.code == 403 else "HTTP %d" % exc.code)
        log("incidents: %s" % detail)
        return json.dumps({"incidents": [], "error": detail}).encode(), "error"
    except Exception as exc:  # noqa: BLE001
        log("incidents: %s" % exc)
        return json.dumps({"incidents": [], "error": str(exc)}).encode(), "error"

    out = []
    for row in body.get("incidents", []):
        geo = row.get("geometry") or {}
        coords = geo.get("coordinates")
        if not coords:
            continue
        if geo.get("type") == "Point":
            coords = [coords]
        props = row.get("properties") or {}
        events = props.get("events") or []
        out.append({
            "what": (events[0].get("description") if events else "") or "",
            "kind": props.get("iconCategory"),
            "magnitude": props.get("magnitudeOfDelay"),
            "delay_s": props.get("delay"),
            "length_m": props.get("length"),
            "road": ", ".join(props.get("roadNumbers") or []),
            "from": props.get("from", ""),
            "to": props.get("to", ""),
            "start": props.get("startTime", ""),
            "end": props.get("endTime", ""),
            # Flattened for the client, which draws it as a ground polyline.
            "line": [round(c, 5) for pair in coords for c in pair[:2]],
        })
    data = json.dumps({
        "incidents": out,
        "source": "TomTom Traffic Incidents",
    }).encode()
    _mem_put(cache, data)
    jams = sum(1 for x in out if (x["magnitude"] or 0) in (1, 2, 3))
    log("incidents: %d in view, %d with a graded delay" % (len(out), jams))
    return data, "network"


# ------------------------------------------------------------------ launches

# The satellite layer shows what is already up there. This is what is on its way,
# which is the more watchable half: a launch has a place and a time, so it is the
# one thing on this globe you can plan to look at.
#
# The Launch Library is open and needs no key. It is also rate limited hard, so
# this is cached for hours rather than minutes - the schedule does not move often
# enough to justify asking again, and a slipped launch slips by hours anyway.
LAUNCH_URL = ("https://ll.thespacedevs.com/2.2.0/launch/upcoming/"
              "?limit=40&hide_recent_previous=true")
LAUNCH_TTL = 3 * 3600


def launches():
    """The next launches, with the pad they go from."""
    key = "launches"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < LAUNCH_TTL:
        return hit[1], "memory"
    path = _disk_path(key)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < LAUNCH_TTL:
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    try:
        body = json.loads(fetch(LAUNCH_URL))
    except Exception as exc:  # noqa: BLE001
        log("launches: %s" % exc)
        return json.dumps({"launches": [], "error": str(exc)}).encode(), "error"

    out = []
    for row in body.get("results", []):
        pad = row.get("pad") or {}
        lat, lon = pad.get("latitude"), pad.get("longitude")
        if lat is None or lon is None:
            continue
        status = row.get("status") or {}
        out.append({
            "name": row.get("name", ""),
            "when": row.get("net", ""),
            # "Go", "TBD", "Hold" - a scheduled launch is a plan, not a fact, and
            # the abbreviation is the honest way to say which.
            "status": status.get("abbrev", ""),
            "status_why": status.get("description", ""),
            "provider": ((row.get("launch_service_provider") or {}).get("name", "")),
            "pad": pad.get("name", ""),
            "place": ((pad.get("location") or {}).get("name", "")),
            "lat": float(lat),
            "lon": float(lon),
            "mission": ((row.get("mission") or {}).get("name", "")),
            "orbit": (((row.get("mission") or {}).get("orbit") or {}).get("abbrev", "")),
            "url": row.get("url", ""),
        })
    data = json.dumps({
        "launches": out,
        "source": "Launch Library 2, The Space Devs",
    }).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    log("launches: %d scheduled" % len(out))
    return data, "network"


# ------------------------------------------------------------- infrastructure

# Two kinds of thing that are enormous, quietly critical, and absent from every
# other layer here: the buildings the internet actually runs in, and the walls
# holding back the water above towns.
#
# Both come from OpenStreetMap through Overpass, queried live for the view rather
# than bundled - a bundled extract would be a copy of somebody's database under
# ODbL, with share-alike attached to it, and asking for what is on screen avoids
# both the licence question and a file that goes stale.
#
# Overpass is a shared free service and will refuse a query that is too greedy,
# so the box is capped and the result cached hard.
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
INFRA_TTL = 7 * 86400
INFRA_MAX_SPAN = 12.0  # degrees; wider than this and Overpass times out


def infrastructure(south, west, north, east):
    """Data centres and dams inside a box, from OpenStreetMap."""
    if north - south > INFRA_MAX_SPAN or east - west > INFRA_MAX_SPAN:
        return json.dumps({
            "sites": [],
            "too_wide": True,
            "note": "zoom in - Overpass will not answer for a box this large",
        }).encode(), "refused"

    box = "%.2f,%.2f,%.2f,%.2f" % (south, west, north, east)
    key = "infra_" + box.replace(",", "_").replace(".", "p").replace("-", "m")
    hit = _mem_get(key)
    if hit:
        return hit[1], "memory"
    path = _disk_path(key)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < INFRA_TTL:
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    query = (
        "[out:json][timeout:40];("
        'nwr["telecom"="data_center"](%s);'
        'nwr["building"="data_center"](%s);'
        'nwr["waterway"="dam"](%s);'
        ");out center 800;" % (box, box, box)
    )
    try:
        req = urllib.request.Request(
            OVERPASS_URL,
            data=urllib.parse.urlencode({"data": query}).encode(),
            headers={"User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
    except Exception as exc:  # noqa: BLE001
        log("infrastructure: Overpass %s" % exc)
        return json.dumps({"sites": [], "error": str(exc)}).encode(), "error"

    sites = []
    for el in body.get("elements", []):
        tags = el.get("tags") or {}
        centre = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
        if centre.get("lat") is None or centre.get("lon") is None:
            continue
        if tags.get("waterway") == "dam":
            kind = "dam"
        else:
            kind = "datacenter"
        sites.append({
            "kind": kind,
            "lat": centre["lat"],
            "lon": centre["lon"],
            # Most dams in OSM have no name at all. Saying so beats inventing one.
            "name": tags.get("name") or tags.get("operator") or "",
            "operator": tags.get("operator", ""),
            "height_m": tags.get("height", ""),
            "osm": "%s/%s" % (el.get("type", "node"), el.get("id", "")),
        })
    data = json.dumps({
        "sites": sites,
        "source": "OpenStreetMap via Overpass, ODbL 1.0",
    }).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    dams = sum(1 for x in sites if x["kind"] == "dam")
    log("infrastructure: %d sites (%d dams, %d data centres)"
        % (len(sites), dams, len(sites) - dams))
    return data, "network"


# -------------------------------------------------------------------- traffic

# Real traffic flow, from TomTom. The simulated version this replaces was removed
# on the grounds that a moving dot which is not a car is worse than no dot: it
# looks like information and is not. This is measured, and needs a key to say so.
#
# Served as tiles rather than points, which is why it is a URL and not a feed:
# the browser fetches them directly. The key goes to the page because TomTom
# restrict browser keys by referrer, exactly like Google.
def tomtom_key():
    key = KEYS.get("tomtom", "")
    if not key:
        return json.dumps({
            "key": "",
            "needs_key": "tomtom",
            "how": "free tier at developer.tomtom.com - put it in keys.json as tomtom",
        }).encode(), "no key"
    return json.dumps({"key": key, "source": "TomTom Traffic Flow"}).encode(), "memory"


# --------------------------------------------------------------------- search

# One box that takes whatever you have: a coordinate off a kneeboard, an ICAO
# code, an airport name, or a town.
#
# The order matters and is deliberate. Coordinates and airport codes are answered
# from here without touching the network, so the common cases are instant and
# cost nobody anything. Only a query that looks like neither goes out to
# Nominatim, which is a volunteer service and paced accordingly.

# Coordinates as they are actually written down. A flight simulator kneeboard
# gives degrees and decimal minutes; a chart gives degrees, minutes, seconds; a
# map application gives decimal degrees. All three turn up, in either order, with
# the hemisphere letter before or after, and with any combination of the degree,
# minute and second marks or none at all.
#
# Rather than a pattern per format, this reads the hemisphere letters, then the
# runs of digits, and lets the count decide: one number is degrees, two is
# degrees and minutes, three is degrees, minutes and seconds.
_HEMI = re.compile(r"[NSEW]", re.I)
_NUM = re.compile(r"\d+(?:[.,]\d+)?")


def _to_degrees(parts):
    """[d], [d, m] or [d, m, s] -> decimal degrees."""
    if not parts or len(parts) > 3:
        return None
    out = 0.0
    for n, value in enumerate(parts):
        out += value / (60.0 ** n)
    return out


def parse_coordinates(text):
    """(lat, lon) from a written coordinate, or None if it is not one."""
    raw = text.strip()
    if not raw or len(raw) > 120:
        return None

    letters = [(m.start(), m.group(0).upper()) for m in _HEMI.finditer(raw)]
    # A place name is full of letters; a coordinate has at most two, and they are
    # one from NS and one from EW. Anything else is a name and not a position.
    if letters and (len(letters) > 2
                    or len({c for _, c in letters if c in "NS"}) > 1
                    or len({c for _, c in letters if c in "EW"}) > 1):
        return None
    if not letters and _HEMI.sub("", raw) != raw:
        return None
    # Reject anything with other letters in it: "Malmo" has no digits, but
    # "Hangar 3 West" would otherwise parse as a longitude.
    if re.search(r"[A-MO-Za-mo-z]", _HEMI.sub("", raw)):
        return None

    numbers = [float(m.group(0).replace(",", ".")) for m in _NUM.finditer(raw)]
    if len(numbers) < 2:
        return None

    if letters:
        ns = next((c for _, c in letters if c in "NS"), None)
        ew = next((c for _, c in letters if c in "EW"), None)
        if not ns or not ew:
            return None
        # Split the numbers where the second hemisphere letter falls, so
        # "N 59 19.8 E 018 04.2" divides into two groups of two.
        cut = max(i for i, _ in letters)
        first, second = [], []
        for m in _NUM.finditer(raw):
            (first if m.start() < cut else second).append(
                float(m.group(0).replace(",", ".")))
        # A leading letter puts both groups after it, so fall back to halving.
        if not first or not second:
            half = len(numbers) // 2
            first, second = numbers[:half], numbers[half:]
        lat, lon = _to_degrees(first), _to_degrees(second)
        if lat is None or lon is None:
            return None
        first_is_lat = _HEMI.search(raw).group(0).upper() in "NS"
        if not first_is_lat:
            lat, lon = lon, lat
            ns, ew = ns, ew
        if ns == "S":
            lat = -lat
        if ew == "W":
            lon = -lon
    else:
        # No letters: decimal degrees, latitude first, as every map writes it.
        if len(numbers) != 2:
            return None
        lat, lon = numbers[0], numbers[1]
        if raw.lstrip().startswith("-"):
            lat = -lat
        if re.search(r"[,\s]\s*-", raw):
            lon = -lon

    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return None
    return round(lat, 6), round(lon, 6)


def search(q):
    """Somewhere to fly to, from a coordinate, an airport code or a name."""
    q = (q or "").strip()
    if not q:
        return json.dumps({"error": "nothing to look for"}).encode(), "empty"

    point = parse_coordinates(q)
    if point:
        return json.dumps({
            "kind": "coordinates",
            "label": "%.5f, %.5f" % point,
            "detail": "read as a position, not looked up anywhere",
            "lat": point[0], "lon": point[1],
            "height": 6000,
        }).encode(), "parsed"

    _load_airports()
    upper = q.upper()
    if 3 <= len(upper) <= 4 and upper.isalnum():
        a = _airport_codes.get(upper)
        if a:
            return json.dumps({
                "kind": "airport",
                "label": "%s %s" % (a["icao"] or a["iata"], a["name"]),
                "detail": ", ".join(x for x in (a["town"], a["country"], a["kind"]) if x),
                "lat": a["lat"], "lon": a["lon"],
                # A small field wants a closer look than an international one.
                "height": 9000 if "large" in a["kind"] else 4000,
            }).encode(), "airports"

    # Names go to the geocoder before the airport list, and that ordering was
    # earned: matching names first sent "Stockholm" to Skavsta, a minor field a
    # hundred kilometres from the city, because its name happens to contain the
    # word. Somebody typing a town wants the town. An airport is what a code is
    # for, and codes are matched above without touching the network.
    where = country_point(q[:120])
    if where:
        return json.dumps({
            "kind": "place",
            "label": q,
            "detail": "geocoded by OpenStreetMap Nominatim",
            "lat": where[0], "lon": where[1],
            "height": 30000,
        }).encode(), "nominatim"

    # Nothing by that name anywhere, so try the airport list after all: it
    # carries names no gazetteer has, like Landvetter or Kastrup.
    lower = q.lower()
    hits = [a for a in _airports
            if lower in a["name"].lower() or lower == a["town"].lower()]
    if hits:
        hits.sort(key=lambda a: (not a["big"], len(a["name"])))
        a = hits[0]
        return json.dumps({
            "kind": "airport",
            "label": "%s %s" % (a["icao"] or a["iata"], a["name"]),
            "detail": ", ".join(x for x in (a["town"], a["country"]) if x),
            "lat": a["lat"], "lon": a["lon"],
            "height": 9000,
            "others": len(hits) - 1,
        }).encode(), "airports"

    return json.dumps({
        "error": "nothing found",
        "tried": "coordinates, airport codes and names, then Nominatim",
    }).encode(), "miss"


# --------------------------------------------------------------- air quality

# What people are actually breathing, from OpenAQ: reference monitors run by
# environment agencies alongside low-cost sensors run by anyone, all reported the
# same way. It is the one layer here that measures a thing happening to people
# rather than a thing happening to the ground.
#
# Needs a free key from openaq.org - the API answers 401 without one. That is
# stated where a key is missing rather than the layer silently drawing nothing.
#
# One request per view. Asking /locations would give names but no readings, and
# then a second request per station to get them, which is a hundred requests for
# one glance. This asks the parameter endpoint instead: every recent PM2.5
# reading in the circle, in one call. The cost is that a reading carries a
# station id rather than a station name, which the card says plainly.
OPENAQ_PM25 = 2  # OpenAQ's parameter id for PM2.5
AQ_TTL = 900


def air_quality(lat, lon, radius_km):
    key = KEYS.get("openaq", "")
    if not key:
        return json.dumps({
            "readings": [],
            "needs_key": "openaq",
            "how": "free from openaq.org/developers - put it in keys.json as openaq",
        }).encode(), "no key"

    # OpenAQ caps the radius at 25 km, and asking for more is an error rather
    # than a truncation, so it is clamped here where the reason can be written down.
    metres = int(max(1000, min(radius_km * 1000, 25000)))
    cache = "openaq_%.2f_%.2f_%d" % (lat, lon, metres)
    hit = _mem_get(cache)
    if hit and time.time() - hit[0] < AQ_TTL:
        return hit[1], "memory"

    url = ("https://api.openaq.org/v3/parameters/%d/latest?coordinates=%.4f,%.4f"
           "&radius=%d&limit=200" % (OPENAQ_PM25, lat, lon, metres))
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "X-API-Key": key, "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = "the key was refused" if exc.code == 401 else "HTTP %d" % exc.code
        log("openaq: %s" % detail)
        return json.dumps({"readings": [], "error": detail}).encode(), "error"
    except Exception as exc:  # noqa: BLE001 - one layer, not the whole globe
        log("openaq: %s" % exc)
        return json.dumps({"readings": [], "error": str(exc)}).encode(), "error"

    readings = []
    for row in body.get("results", []):
        where = row.get("coordinates") or {}
        if where.get("latitude") is None or where.get("longitude") is None:
            continue
        readings.append({
            "lat": where["latitude"],
            "lon": where["longitude"],
            "pm25": row.get("value"),
            "when": (row.get("datetime") or {}).get("utc", ""),
            "sensor": row.get("sensorsId"),
            "station": row.get("locationsId"),
        })
    data = json.dumps({
        "readings": readings,
        "parameter": "PM2.5, micrograms per cubic metre",
        "source": "OpenAQ, CC BY 4.0",
        "radius_km": round(metres / 1000, 1),
    }).encode()
    _mem_put(cache, data)
    log("openaq: %d PM2.5 readings within %d km" % (len(readings), metres / 1000))
    return data, "network"


# ------------------------------------------------------------------- fishing

# Global Fishing Watch turn AIS into behaviour: not where a vessel is, but what it
# appears to be doing. Three of their event types are worth a marker.
#
#   fishing     the track pattern matches fishing rather than transit
#   encounter   two vessels close together, slow, long enough to transfer
#   gap         the transponder stopped and later resumed somewhere else
#
# The gaps are the interesting ones, and the reason to be careful with them. A
# vessel goes dark for a great many innocent reasons - equipment, coverage, a
# receiver missing a pass - so a gap is a question, not an accusation. The card
# says so, because a map that quietly implies smuggling is worse than no map.
#
# Needs a free token from globalfishingwatch.org. Refused without one.
GFW_EVENTS = "https://gateway.api.globalfishingwatch.org/v3/events"
GFW_DATASETS = (
    "public-global-fishing-events:latest",
    "public-global-encounters-events:latest",
    "public-global-gaps-events:latest",
)
GFW_TTL = 3600


def _circle(lat, lon, radius_km, points=24):
    """A circle as a GeoJSON polygon, because the API takes geometry not radii."""
    ring = []
    for n in range(points + 1):
        angle = 2 * math.pi * n / points
        dy = radius_km / 110.574
        dx = radius_km / (111.320 * max(0.05, math.cos(math.radians(lat))))
        ring.append([round(lon + dx * math.sin(angle), 4),
                     round(lat + dy * math.cos(angle), 4)])
    return {"type": "Polygon", "coordinates": [ring]}


def fishing(lat, lon, radius_km, days=14):
    token = KEYS.get("gfw", "")
    if not token:
        return json.dumps({
            "events": [],
            "needs_key": "gfw",
            "how": "free from globalfishingwatch.org/our-apis - put it in keys.json as gfw",
        }).encode(), "no key"

    radius_km = max(20, min(radius_km, 600))
    cache = "gfw_%.1f_%.1f_%d" % (lat, lon, radius_km)
    hit = _mem_get(cache)
    if hit and time.time() - hit[0] < GFW_TTL:
        return hit[1], "memory"

    today = datetime.datetime.now(datetime.timezone.utc).date()
    payload = json.dumps({
        "datasets": list(GFW_DATASETS),
        "startDate": (today - datetime.timedelta(days=days)).isoformat(),
        "endDate": today.isoformat(),
        "geometry": _circle(lat, lon, radius_km),
    }).encode()
    req = urllib.request.Request(GFW_EVENTS + "?limit=200&offset=0", data=payload, headers={
        "User-Agent": USER_AGENT,
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = "the token was refused" if exc.code in (401, 403) else "HTTP %d" % exc.code
        log("gfw: %s" % detail)
        return json.dumps({"events": [], "error": detail}).encode(), "error"
    except Exception as exc:  # noqa: BLE001
        log("gfw: %s" % exc)
        return json.dumps({"events": [], "error": str(exc)}).encode(), "error"

    events = []
    for row in body.get("entries", body.get("data", [])):
        where = row.get("position") or {}
        if where.get("lat") is None or where.get("lon") is None:
            continue
        vessel = (row.get("vessel") or {})
        events.append({
            "lat": where["lat"],
            "lon": where["lon"],
            "kind": row.get("type", ""),
            "start": row.get("start", ""),
            "end": row.get("end", ""),
            "hours": row.get("durationHours"),
            "vessel": vessel.get("name") or vessel.get("ssvid") or "",
            "flag": vessel.get("flag", ""),
        })
    data = json.dumps({
        "events": events,
        "days": days,
        "radius_km": radius_km,
        "source": "Global Fishing Watch, CC BY-SA 4.0",
    }).encode()
    _mem_put(cache, data)
    log("gfw: %d events in %d days within %d km" % (len(events), days, radius_km))
    return data, "network"


# ------------------------------------------------------------------ borders

# Over satellite imagery and false colour there are no names at all, which is
# exactly when you lose track of where you are. Two halves to fixing that: names,
# which come from a label tile layer drawn client-side, and lines, which come
# from here.
#
# Natural Earth is public domain and has not moved a border in years, so this is
# cached hard and on disk - it is a fixture, not a feed. Country lines and the
# internal ones are fetched separately because they want drawing differently: a
# national border is a fact worth a bright line, a provincial one is context.
BORDER_SOURCES = (
    ("countries", "https://raw.githubusercontent.com/nvkelso/natural-earth-vector"
                  "/master/geojson/ne_50m_admin_0_boundary_lines_land.geojson"),
    ("states", "https://raw.githubusercontent.com/nvkelso/natural-earth-vector"
               "/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson"),
)
BORDER_TTL = 30 * 86400


def borders():
    """Country and province outlines, as line strings."""
    key = "borders"
    hit = _mem_get(key)
    if hit:
        return hit[1], "memory"
    path = _disk_path(key)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < BORDER_TTL:
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    out = {"countries": [], "states": []}
    for kind, url in BORDER_SOURCES:
        try:
            raw = fetch(url)
        except Exception as exc:  # noqa: BLE001 - one half is better than none
            log("borders: %s unavailable (%s)" % (kind, exc))
            continue
        for feature in json.loads(raw).get("features", []):
            geometry = feature.get("geometry") or {}
            parts = (geometry.get("coordinates") or [])
            if geometry.get("type") == "LineString":
                parts = [parts]
            elif geometry.get("type") != "MultiLineString":
                continue
            for part in parts:
                if not part or len(part) < 2:
                    continue
                # Flattened and rounded: five decimals is a metre, and a border
                # drawn to the millimetre is a megabyte of pointless precision.
                flat = []
                for point in part:
                    flat.append(round(point[0], 4))
                    flat.append(round(point[1], 4))
                out[kind].append(flat)

    data = json.dumps({
        "countries": out["countries"],
        "states": out["states"],
        "source": "Natural Earth, public domain",
    }).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    log(f"borders: {len(out['countries'])} country lines, "
        f"{len(out['states'])} internal \u00b7 Natural Earth")
    return data, "network"


def briefing():
    """What is worth pointing a camera at, ranked, with coordinates."""
    key = "briefing"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < BRIEF_TTL:
        return hit[1], "memory"

    events = []
    events.extend(_fire_clusters(6))
    events.extend(_quake_events(5))
    events.extend(_gdacs_events(3))
    events.extend(_volcano_events(3))
    events.extend(_outbreak_events(3))
    events.extend(_military_air(4))

    # Scores are not comparable across kinds - megawatts against magnitudes
    # against altitude - so ranking is done inside each kind and the list is
    # interleaved. Claiming one global ordering would be inventing a comparison.
    by_kind = {}
    for event in events:
        by_kind.setdefault(event["kind"], []).append(event)
    for group in by_kind.values():
        group.sort(key=lambda e: e["score"], reverse=True)

    ordered = []
    round_no = 0
    while any(len(g) > round_no for g in by_kind.values()):
        for kind in ("fire", "quake", "cyclone", "flood", "volcano", "drought",
                     "outbreak", "military"):
            group = by_kind.get(kind) or []
            if len(group) > round_no:
                ordered.append(group[round_no])
        round_no += 1

    # Nominatim is paced at one request a second by their terms, so a briefing
    # full of fresh coordinates could sit here for half a minute. Two defences:
    #
    # Aircraft are rounded to a whole degree. They move, so a tenth of a degree
    # would miss the cache on every rebuild, and "over Norway" does not need
    # 11 km precision. Fire cells sit still, so they keep the finer rounding.
    #
    # And the whole pass runs to a deadline. Past it, events go out without a
    # place rather than holding the response open - a missing label is a smaller
    # failure than a briefing that never arrives.
    place_deadline = time.time() + 6.0
    for event in ordered:
        # Quakes arrive from the USGS with a place in the headline already.
        # Quakes carry a USGS place; GDACS and WHO events carry their own. Only
        # the ones with nothing but a coordinate need looking up - and for an
        # outbreak, reverse geocoding a country centroid would print a province
        # name WHO never reported, which claims a precision that does not exist.
        if event["kind"] not in ("quake", "outbreak") and not event.get("place"):
            precision = 0 if event["kind"] == "military" else 1
            lat = round(event["lat"], precision)
            lon = round(event["lon"], precision)
            cached_only = time.time() > place_deadline
            if cached_only:
                hit = _mem_get("place_%.1f_%.1f" % (lat, lon))
                event["place"] = json.loads(hit[1]).get("place", "") if hit else ""
            else:
                event["place"] = place_name(lat, lon)
        news = news_search(event)
        if news:
            event["news"] = news

    data = json.dumps({
        "events": _attach_alerts(ordered),
        "counts": {k: len(v) for k, v in by_kind.items()},
        "note": "ranked within each kind; megawatts and magnitudes are not "
                "comparable, so there is no single ordering",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }).encode()
    _mem_put(key, data)
    return data, "network"


# ----------------------------------------------------------- capital ships

# Carriers do not broadcast AIS, so data/carriers.json is read and typed in by
# hand from the newest USNI Fleet and Marine Tracker. That worked until one of
# them moved between trackers and the file went on saying otherwise, quietly,
# with a date on it that made it look checked.
#
# This does not fix that by parsing the tracker. Turning "operating in the
# Arabian Sea" into a latitude is exactly the guess the rest of the app refuses
# to make. What it does is cheap and reliable: read the index of published
# trackers, and compare the newest date there against the date in the file. It
# cannot tell you a ship has moved. It can tell you that nobody has looked since
# something newer came out, which is the part that was invisible before.
USNI_FEED = "https://news.usni.org/feed"
USNI_TTL = 6 * 3600
TRACKER_TITLE = "Fleet and Marine Tracker"
BIG_DECKS = re.compile(r"\b(CVN|LHD|LHA)-(\d+)\b")
AREA_PREFIX = re.compile(r"^(in the|in|off the|off|near the|near)\s+", re.I)


def _html_text(raw):
    """Entities out, one line of text back. USNI write curly quotes as entities."""
    return re.sub(r"\s+", " ", _html.unescape(raw)).strip()


def _area_key(heading):
    key = AREA_PREFIX.sub("", _html_text(heading).lower())
    return re.sub(r"[^a-z ]", "", key).strip()


# The site itself refuses a plain Python client - it answers 403 to anything whose
# TLS handshake does not look like a browser, however polite the User-Agent. The
# right response to that is not to dress up as one. USNI publish an RSS feed, which
# is the channel that exists for programs, and it carries the whole article rather
# than a summary: one request gets the newest tracker and the days of reporting
# since. The category feed looked like the tidier choice and is served from a cache
# weeks behind, so this reads the main feed and picks the trackers out of it.
def usni_feed():
    """[{date, title, url, body}] newest first, or None if the feed is unreachable."""
    key = "usni_feed"
    hit = _mem_get(key)
    if hit:
        return json.loads(hit[1])
    path = _disk_path(key)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < USNI_TTL:
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return json.loads(data)

    try:
        body = fetch(USNI_FEED).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - the hand-kept file still works
        log("carriers: USNI feed unreachable (%s)" % exc)
        return None

    items = []
    for chunk in re.findall(r"<item>(.*?)</item>", body, re.S):
        title = re.search(r"<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", chunk, re.S)
        link = re.search(r"<link>(.*?)</link>", chunk, re.S)
        when = re.search(r"<pubDate>(.*?)</pubDate>", chunk, re.S)
        content = re.search(
            r"<content:encoded>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</content:encoded>",
            chunk, re.S)
        if not (title and when):
            continue
        try:
            stamp = email.utils.parsedate_to_datetime(when.group(1)).date().isoformat()
        except Exception:  # noqa: BLE001 - one bad date is not worth the whole feed
            continue
        items.append({
            "date": stamp,
            "title": _html_text(title.group(1)),
            "url": link.group(1).strip() if link else "",
            "body": content.group(1) if content else "",
        })
    if not items:
        log("carriers: the USNI feed parsed to nothing")
        return None

    items.sort(key=lambda i: i["date"], reverse=True)
    data = json.dumps(items).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    log("carriers: USNI feed read \u00b7 %d items through %s"
        % (len(items), items[0]["date"]))
    return items


# The tracker is prose, but it is *organised* prose: an <h2> per area with the
# ships listed underneath. So the area a ship is in can be read reliably, and the
# area is all USNI ever give - there is no latitude anywhere in the document.
#
# Which is why this stops where it does. It reads which named area each big deck
# is under and places her at the centre of that area with a ring covering the
# whole of it, from a gazetteer of plain geography. It does not mine the prose for
# hints and turn "transiting westbound" into a course. An area is not a position,
# and the ring is what keeps the picture honest about which one you are seeing.
#
# An area that is not in the gazetteer is not guessed at. The ship comes back in
# `unplaced`, is named in the feed, and is simply not drawn - a missing pin is
# recoverable, a confidently wrong one is not.
def parse_tracker(item):
    """[{hull, name, area, lat, lon, ...}] read from one tracker item, or None."""
    # Photo captions name the ship that was photographed, which is regularly one
    # that is somewhere else entirely.
    body = re.sub(r"<figcaption.*?</figcaption>", " ", item["body"], flags=re.S)

    with open(os.path.join(ROOT, "data", "sea_areas.json"), "rb") as fh:
        gazetteer = json.loads(fh.read())["areas"]

    ships, unplaced, seen = [], [], set()
    parts = re.split(r"<h2[^>]*>(.*?)</h2>", body, flags=re.S)
    for i in range(1, len(parts) - 1, 2):
        heading = _html_text(re.sub(r"<[^>]+>", "", parts[i]))
        text = _html_text(re.sub(r"<[^>]+>", " ", parts[i + 1]))
        area = gazetteer.get(_area_key(heading))
        for m in BIG_DECKS.finditer(text):
            hull = "%s-%s" % m.groups()
            if hull in seen:
                continue
            seen.add(hull)
            # The name sits immediately before the hull number: "USS Boxer (LHD-4)".
            back = text.rfind("USS ", max(0, m.start() - 70), m.start())
            name = text[back:m.start()].strip().rstrip("(").strip() if back != -1 else hull
            if not area:
                unplaced.append({"hull": hull, "name": name, "area": heading})
                continue
            ships.append({
                "hull": hull,
                "name": name,
                "kind": "carrier" if hull.startswith("CVN") else "amphib",
                "area": heading,
                "lat": area["lat"],
                "lon": area["lon"],
                "uncertainty_km": area["radius_km"],
                "status": ("alongside" if area["kind"] == "port"
                           else "listed under this area in the tracker"),
                "origin": "usni",
                "placed": "centre of the area named in the tracker",
            })
    if not ships:
        log("carriers: %s parsed to nothing, keeping the hand-kept file" % item["date"])
        return None
    return {"ships": ships, "unplaced": unplaced}


# A tracker is a week old the day after it goes out, and carriers move. The feed
# already holds the days since, so anything published later whose *headline* names
# a ship is attached to her as later coverage: the headline, the date and the link.
#
# The headline, and not the article body. Matching the body flagged the Bush and
# the George Washington with a piece about the Lincoln, purely because it mentioned
# their hull numbers in passing - which is worse than no flag at all, because it
# implies their pins are in question when nothing said so. A ship named in the
# headline is a piece about that ship.
#
# It is deliberately not called stale, either. Some of what comes back is a court
# case rather than a movement. This says "USNI wrote about her after this tracker,
# here it is" and leaves the reading to a person, because the difference between a
# ship sailing and a ship being in the news is not something a regex should rule on.
def later_reporting(items, after, ships):
    news = [i for i in items
            if i["date"] > after and TRACKER_TITLE not in i["title"]]
    for ship in ships:
        short = ship["name"].replace("USS ", "").strip()
        if len(short) < 4:
            continue
        for item in news:
            if ship["hull"] in item["title"] or short in item["title"]:
                ship["later"] = {"date": item["date"], "title": item["title"],
                                 "url": item["url"]}
                break
    return sum(1 for s in ships if s.get("later"))


# Three ships listed "In San Diego" land on one point, and two of them become
# impossible to click - the same way an outbreak marker used to hide under another
# at a shared country centroid. They are fanned around the area centre so each can
# be reached.
#
# Nothing is being claimed by the offset: it is a fraction of a ring that is
# already drawn, and the card says the position is the centre of an area rather
# than the ship. Spreading them inside the circle asserts no more than stacking
# them at its middle did, and it can be read.
def fan_out(ships):
    groups = {}
    for ship in ships:
        groups.setdefault((ship["lat"], ship["lon"]), []).append(ship)
    for (lat, lon), group in groups.items():
        if len(group) < 2:
            continue
        spread = min(group[0]["uncertainty_km"] * 0.45, 90.0)
        for n, ship in enumerate(sorted(group, key=lambda s: s["hull"])):
            angle = 2 * math.pi * n / len(group)
            ship["lat"] = round(lat + (spread * math.cos(angle)) / 110.574, 4)
            ship["lon"] = round(
                lon + (spread * math.sin(angle))
                / (111.320 * max(0.05, math.cos(math.radians(lat)))), 4)
            ship["placed"] = "area centre, offset so each ship can be clicked"


def carriers():
    """The fleet picture: read from the newest tracker, corrected by hand where read."""
    with open(os.path.join(ROOT, "data", "carriers.json"), "rb") as fh:
        payload = json.loads(fh.read())
    hand = {ship["hull"]: ship for ship in payload.get("ships", [])}
    for ship in hand.values():
        ship.setdefault("origin", "hand")
        ship.setdefault("as_of", payload.get("as_of", ""))
    typed_through = max([""] + [s["as_of"] for s in hand.values()])

    def fallback(reason, latest=None):
        payload["ships"] = list(hand.values())
        payload["latest_tracker"] = latest
        payload["stale"] = None if latest is None else latest["date"] > typed_through
        payload["unplaced"] = []
        payload["degraded"] = reason
        return json.dumps(payload).encode(), "file"

    items = usni_feed()
    if not items:
        # Unreachable is not the same as unchanged, and must not read as fine.
        return fallback("the USNI feed could not be read, so this is the hand-kept file")

    trackers = [i for i in items if TRACKER_TITLE in i["title"]]
    if not trackers:
        return fallback("no tracker in the current feed window")
    latest = {"date": trackers[0]["date"], "url": trackers[0]["url"]}

    # The feed window is a few days wide. If it ever serves a tracker older than
    # the one the file already reflects - a cache, a re-post - reading it would
    # walk the fleet backwards, so it is refused rather than merged.
    #
    # The comparison is against the file's own tracker date, not against the
    # newest hand correction in it. Someone reading a Thursday article about one
    # ship must not stop Monday's tracker from updating the other eight; that
    # single ship is protected by the merge below, which is the right scope for it.
    if latest["date"] < payload.get("as_of", ""):
        return fallback("the newest tracker in the feed is older than the file", latest)

    parsed = parse_tracker(trackers[0])
    if not parsed:
        return fallback("the tracker could not be parsed", latest)

    # The tracker is the baseline. A hand entry only survives where somebody read
    # something *newer* - which is the whole reason the file exists, and the only
    # case where typing beats fetching.
    merged, overridden = {}, []
    for ship in parsed["ships"]:
        ship = dict(ship, as_of=latest["date"],
                    source="USNI News Fleet and Marine Tracker", url=latest["url"])
        typed = hand.get(ship["hull"])
        if typed and typed.get("as_of", "") > latest["date"]:
            overridden.append(ship["hull"])
            merged[ship["hull"]] = typed
            continue
        for key in ("class", "wiki"):  # detail the tracker never carries
            if typed and typed.get(key) and not ship.get(key):
                ship[key] = typed[key]
        merged[ship["hull"]] = ship

    # Anything typed in that the tracker does not mention stays, clearly dated.
    for hull, ship in hand.items():
        merged.setdefault(hull, ship)

    ships = sorted(merged.values(), key=lambda s: s["hull"])
    fan_out([s for s in ships if s.get("origin") == "usni"])
    flagged = later_reporting(items, latest["date"], ships)

    payload["ships"] = ships
    payload["as_of"] = latest["date"]
    payload["url"] = latest["url"]
    payload["source"] = "USNI News Fleet and Marine Tracker"
    payload["latest_tracker"] = latest
    payload["stale"] = False
    payload["unplaced"] = parsed["unplaced"]
    payload["from_tracker"] = sum(1 for s in ships if s.get("origin") == "usni")
    payload["overridden"] = overridden
    payload["with_later_news"] = flagged
    payload["degraded"] = ""
    return json.dumps(payload).encode(), "network"


# ------------------------------------------------------------ own entries

# The feeds cover what the feeds cover. WHO publishes an outbreak when it crosses
# an international threshold, GDACS alerts above a severity, and a national
# measles outbreak of 27 cases appears in neither - it goes to
# Folkhalsomyndigheten and stops there.
#
# So there is a file for things read in the news. It follows the pattern
# carriers.json already set: hand-edited, dated, and labelled loudly enough that
# it can never be mistaken for something a satellite saw. A globe that can only
# show what has an API is a globe that misses most of what happens.
MANUAL_PATH = os.path.join(ROOT, "data", "manual_events.json")
# Shipped empty on purpose: the live file is gitignored, because what
# somebody chose to type in is theirs and not part of the program.
MANUAL_EXAMPLE = os.path.join(ROOT, "data", "manual_events.example.json")


def read_manual():
    if not os.path.exists(MANUAL_PATH):
        return json.dumps({"events": []}).encode(), "empty"
    with open(MANUAL_PATH, "rb") as fh:
        return fh.read(), "disk"


def write_manual(raw):
    """Add or remove one entry. The camera supplies the position.

    Kept deliberately small: an id, a place, words, and where the words came
    from. An entry without a source is worth less than no entry, so the source
    is required.
    """
    incoming = json.loads(raw)
    stored = {"events": []}
    if os.path.exists(MANUAL_PATH):
        with open(MANUAL_PATH, encoding="utf-8") as fh:
            stored = json.load(fh)
    events = stored.setdefault("events", [])

    if incoming.get("remove"):
        target = incoming["remove"]
        before = len(events)
        stored["events"] = [e for e in events if e.get("id") != target]
        removed = before - len(stored["events"])
        with open(MANUAL_PATH, "w", encoding="utf-8") as fh:
            json.dump(stored, fh, indent=2, ensure_ascii=False)
        log(f"own entry removed: {target}" if removed else f"no entry {target}")
        return json.dumps({"ok": True, "removed": removed}).encode()

    title = (incoming.get("title") or "").strip()
    url = (incoming.get("url") or "").strip()
    if not title:
        raise ValueError("a title is required")
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("a source link starting with http is required")
    try:
        lat = float(incoming["lat"])
        lon = float(incoming["lon"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("lat and lon are required")

    entry = {
        # Readable and unique enough for a hand-kept file.
        "id": re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40]
              + "-" + time.strftime("%Y%m%d%H%M", time.gmtime()),
        "kind": (incoming.get("kind") or "note").strip()[:24],
        "title": title[:80],
        "detail": (incoming.get("detail") or "").strip()[:1200],
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "place": (incoming.get("place") or "").strip()[:120],
        "date": time.strftime("%Y-%m-%d", time.gmtime()),
        "source": (incoming.get("source") or "").strip()[:80],
        "url": url[:400],
    }
    events.append(entry)
    os.makedirs(os.path.dirname(MANUAL_PATH), exist_ok=True)
    with open(MANUAL_PATH, "w", encoding="utf-8") as fh:
        json.dump(stored, fh, indent=2, ensure_ascii=False)
    log(f"own entry added: {entry['title']} at {entry['lat']:.3f},{entry['lon']:.3f}")
    return json.dumps({"ok": True, "entry": entry}).encode()


def read_marks():
    """Saved viewpoints, kept on disk rather than in the browser.

    localStorage is scoped to the exact origin, so a server started on a
    different port loses them silently. A file in the app folder does not care
    about ports, browsers or cleared site data.
    """
    if not os.path.exists(MARKS_PATH):
        return b'{"marks": []}', "empty"
    with open(MARKS_PATH, "rb") as fh:
        return fh.read(), "disk"


def write_marks(raw):
    payload = json.loads(raw)
    marks = payload.get("marks")
    if not isinstance(marks, list):
        raise ValueError("expected a marks array")
    with _marks_lock:
        os.makedirs(os.path.dirname(MARKS_PATH), exist_ok=True)
        with open(MARKS_PATH, "w", encoding="utf-8") as fh:
            json.dump({"marks": marks}, fh, indent=2, ensure_ascii=False)
    log(f"marks: {len(marks)} saved")
    return json.dumps({"ok": True, "count": len(marks)}).encode()


def imagery_date(lat, lon):
    """When the satellite image under this point was actually taken.

    A basemap is a mosaic of scenes flown years apart, and a picture that looks
    live can be eighteen months old — which matters when you are counting ships
    at a pier. Esri publishes the acquisition date per scene, so the app can say.
    """
    key = f"imgdate_{lat:.2f}_{lon:.2f}"
    # A week, not forever: Esri republishes World Imagery on a rolling basis, and
    # a long-running server would otherwise keep reporting the old capture date
    # for imagery that has already been replaced under it.
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < 604800:
        return hit[1], "memory"

    query = urllib.parse.urlencode({
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "sr": "4326",
        "layers": "all",
        "tolerance": "2",
        "mapExtent": f"{lon - 0.03},{lat - 0.03},{lon + 0.03},{lat + 0.03}",
        "imageDisplay": "1024,768,96",
        "returnGeometry": "false",
        "f": "json",
    })
    payload = json.loads(fetch(f"{ESRI_IDENTIFY}?{query}"))

    out = {}
    for result in payload.get("results", []):
        attrs = result.get("attributes", {})
        stamp = attrs.get("SRC_DATE2") or attrs.get("DATE (YYYYMMDD)")
        if stamp and stamp != "Null":
            out = {
                "date": stamp,
                "resolution_m": attrs.get("RESOLUTION (M)"),
                "source": attrs.get("DESCRIPTION"),
            }
            break

    data = json.dumps(out).encode()
    _mem_put(key, data)
    return data, "network"


COMMONS_API = "https://commons.wikimedia.org/w/api.php?{query}"


def vessel_photo(name):
    """A photograph of a named ship, from Wikimedia Commons.

    There is no free registry of ship photographs the way planespotters covers
    aircraft. Commons has a great many, searchable by name — but a name search
    matches loosely, so a candidate is only accepted when the ship's name is
    actually in the file title, and the title is handed to the client so the
    match can be judged rather than trusted.
    """
    name = (name or "").strip()
    if len(name) < 3 or name.upper().startswith("MMSI"):
        return {}

    key = f"vesselphoto_{name.lower()}"
    hit = _mem_get(key)
    if hit:
        return json.loads(hit[1])
    path = _disk_path(key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            raw = fh.read()
        _mem_put(key, raw)
        return json.loads(raw)

    record = {}
    try:
        query = urllib.parse.urlencode({
            "action": "query", "generator": "search", "format": "json",
            "gsrsearch": f'"{name}" ship', "gsrnamespace": "6", "gsrlimit": "8",
            "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": "420",
        })
        payload = json.loads(fetch(COMMONS_API.format(query=query)))
        pages = (payload.get("query") or {}).get("pages") or {}
        wanted = name.lower()
        # A name in a file title is not enough: searching for LUCA finds a lion
        # photographed by Luca Galuzzi. Either the title opens with the ship's
        # name, or it has to read like a ship somewhere in it.
        maritime = ("ship", "vessel", "boat", "imo", "ferry", "tanker", "cargo",
                    "port ", "harbour", "harbor", "shipyard", "at sea", "mv ", "ms ")
        for page in sorted(pages.values(), key=lambda p: p.get("index", 99)):
            title = page.get("title", "")
            bare = title.replace("File:", "").lower()
            if wanted not in bare:
                continue                      # a loose search match, not this ship
            if not (bare.startswith(wanted) or any(w in bare for w in maritime)):
                continue                      # the name belongs to something else
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata") or {}
            if not info.get("thumburl"):
                continue
            record = {
                "url": info["thumburl"],
                "full": info.get("url"),
                "title": title.replace("File:", ""),
                "license": (meta.get("LicenseShortName") or {}).get("value", ""),
                "credit": re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", ""))[:80],
            }
            break
    except Exception as exc:  # noqa: BLE001 - most ships are not photographed
        log(f"no photo for vessel {name}: {exc}")

    raw = json.dumps(record).encode()
    _mem_put(key, raw)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    _sweep_disk()
    return record


WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"


def ship_summary(title):
    """Photo and one-line history for a named ship, from Wikipedia.

    US Navy photographs are public domain, so the encyclopaedia is the free
    source for what a hull actually looks like. Nothing here changes, so it is
    cached on disk and never asked for twice.
    """
    key = f"ship_{title}"
    hit = _mem_get(key)
    if hit:
        return hit[1], "memory"
    path = _disk_path(key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    req = urllib.request.Request(
        WIKI_SUMMARY.format(title=urllib.parse.quote(title)),
        headers={"User-Agent": PHOTO_AGENT, "Accept-Encoding": "gzip"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    page = json.loads(raw)

    out = {
        "title": page.get("title"),
        "extract": page.get("extract", ""),
        "thumb": (page.get("thumbnail") or {}).get("source", ""),
        "full": (page.get("originalimage") or {}).get("source", ""),
        "url": ((page.get("content_urls") or {}).get("desktop") or {}).get("page", ""),
    }
    data = json.dumps(out).encode()
    _mem_put(key, data)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    log(f"ship: {out['title']} looked up")
    return data, "network"


WIKI_SEARCH = "https://en.wikipedia.org/w/api.php?{query}"

# ICAO type designators are four letters, not names: searching an encyclopaedia
# for "AS50" finds nothing useful. These are the ones that turn up over a city.
TYPE_NAMES = {
    "AS50": "Eurocopter AS350 Ecureuil", "AS55": "Eurocopter AS555 Fennec",
    "AS65": "Eurocopter AS365 Dauphin", "EC20": "Eurocopter EC120 Colibri",
    "EC25": "Eurocopter EC225 Super Puma", "EC30": "Eurocopter EC130",
    "EC35": "Eurocopter EC135", "EC45": "Eurocopter EC145",
    "EC55": "Eurocopter EC155", "EC75": "Eurocopter EC175",
    "H125": "Airbus Helicopters H125", "H135": "Airbus Helicopters H135",
    "H145": "Airbus Helicopters H145", "H155": "Eurocopter EC155",
    "H160": "Airbus Helicopters H160", "H175": "Airbus Helicopters H175",
    "H500": "Hughes OH-6 Cayuse", "H60": "Sikorsky UH-60 Black Hawk",
    "A109": "AgustaWestland AW109", "A139": "AgustaWestland AW139",
    "A169": "Leonardo AW169", "A189": "AgustaWestland AW189",
    "B06": "Bell 206", "B407": "Bell 407", "B412": "Bell 412",
    "B429": "Bell 429 GlobalRanger", "B505": "Bell 505 Jet Ranger X",
    "BK17": "Kawasaki MBB BK 117", "R44": "Robinson R44", "R66": "Robinson R66",
    "S76": "Sikorsky S-76", "S92": "Sikorsky S-92",
    "MI8": "Mil Mi-8", "KA32": "Kamov Ka-32", "NH90": "NHIndustries NH90",
    "PUMA": "Aerospatiale SA 330 Puma", "LYNX": "Westland Lynx",
    "UH1": "Bell UH-1 Iroquois", "GAZL": "Aerospatiale Gazelle",
}


def type_photo(model):
    """A picture of the model when nobody has photographed this airframe.

    Rarer hulls — police helicopters especially — are often missing from the
    spotter databases entirely. Showing what the type looks like is more useful
    than an empty panel, as long as the card says which it is.
    """
    if not model:
        return None
    key = f"typephoto_{model}"
    hit = _mem_get(key)
    if hit:
        return json.loads(hit[1]) or None
    path = _disk_path(key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            record = json.loads(fh.read())
        _mem_put(key, json.dumps(record).encode())
        return record or None

    record = {}
    try:
        query = urllib.parse.urlencode({
            "action": "query", "list": "search", "format": "json", "srlimit": 1,
            "srsearch": f"{model} aircraft",
        })
        found = json.loads(fetch(WIKI_SEARCH.format(query=query)))
        results = (found.get("query") or {}).get("search") or []
        if results:
            title = results[0]["title"]
            page = json.loads(fetch(
                "https://en.wikipedia.org/api/rest_v1/page/summary/"
                + urllib.parse.quote(title)
            ))
            thumb = (page.get("thumbnail") or {}).get("source")
            if thumb:
                record = {
                    "url": thumb,
                    "full": (page.get("originalimage") or {}).get("source", thumb),
                    "credit": f"Wikipedia \u00b7 {title}",
                    "kind": "type",
                }
    except Exception:  # noqa: BLE001 - no picture is an acceptable answer
        record = {}

    raw = json.dumps(record).encode()
    _mem_put(key, raw)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    _sweep_disk()
    return record or None


def aircraft_dossier(icao_hex, callsign, type_code=""):
    """Photo and scheduled route for one airframe, from two free registries.

    Both are static facts about the aircraft rather than live telemetry, so they
    are cached for a day and looked up only when a contact is actually selected.
    """
    key = f"aircraft_{icao_hex}_{callsign}"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < 86400:
        return hit[1], "memory"

    dossier = {}
    if icao_hex:
        try:
            req = urllib.request.Request(
                PHOTO_URL.format(hex=icao_hex),
                headers={"User-Agent": PHOTO_AGENT, "Accept-Encoding": "gzip"},
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
            photos = json.loads(raw).get("photos") or []
            if photos:
                photo = photos[0]
                dossier["photo"] = {
                    "url": (photo.get("thumbnail_large") or photo["thumbnail"])["src"],
                    "link": photo.get("link"),
                    "credit": photo.get("photographer"),
                    "kind": "airframe",
                }
        except Exception as exc:  # noqa: BLE001 - a missing photo is normal
            log(f"no photo for {icao_hex}: {exc}")

    if "photo" not in dossier and (icao_hex or type_code):
        # Nobody has shot this hull; fall back to the model, clearly labelled.
        # The registry is thin outside the big fleets, so the type code that came
        # down on the air itself is the more reliable of the two.
        registry = aircraft_type(icao_hex) if icao_hex else {}
        model = (
            TYPE_NAMES.get(type_code)
            or TYPE_NAMES.get(registry.get("icao_type", ""))
            or registry.get("type")
            or registry.get("icao_type")
            or type_code
        )
        picture = type_photo(model)
        if picture:
            dossier["photo"] = picture
            dossier["model"] = model

    if callsign:
        try:
            raw = fetch(ROUTE_URL.format(callsign=urllib.parse.quote(callsign)))
            route = (json.loads(raw).get("response") or {}).get("flightroute") or {}
            origin = route.get("origin") or {}
            destination = route.get("destination") or {}
            if origin and destination:
                dossier["route"] = {
                    "airline": (route.get("airline") or {}).get("name", ""),
                    "origin": {
                        "code": origin.get("iata_code") or origin.get("icao_code"),
                        "name": origin.get("name"),
                        "city": origin.get("municipality"),
                        "lat": origin.get("latitude"),
                        "lon": origin.get("longitude"),
                    },
                    "destination": {
                        "code": destination.get("iata_code") or destination.get("icao_code"),
                        "name": destination.get("name"),
                        "city": destination.get("municipality"),
                        "lat": destination.get("latitude"),
                        "lon": destination.get("longitude"),
                    },
                }
        except Exception as exc:  # noqa: BLE001 - unscheduled flights have no route
            log(f"no route for {callsign}: {exc}")

    data = json.dumps(dossier).encode()
    _mem_put(key, data)
    return data, "network"


WINDY_NEARBY = (
    "https://api.windy.com/webcams/api/v3/webcams"
    "?limit=50&include=location,images&nearby={lat:.2f},{lon:.2f},250"
)


def cameras_nearby(lat, lon):
    """Windy webcams around a point, so coverage follows where you are looking.

    Cached per whole degree: panning around a city reuses one upstream call.
    """
    key = f"nearby_{round(lat)}_{round(lon)}"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < 86400:
        return hit[1], "memory"
    if not KEYS.get("windy"):
        return json.dumps({"stations": []}).encode(), "memory"

    req = urllib.request.Request(
        WINDY_NEARBY.format(lat=lat, lon=lon),
        headers={"x-windy-api-key": KEYS["windy"], "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        payload = json.loads(resp.read())

    stations = []
    for cam in payload.get("webcams") or []:
        location = cam.get("location") or {}
        images = (cam.get("images") or {}).get("current") or {}
        if not images.get("preview") or location.get("latitude") is None:
            continue
        stations.append({
            "id": str(cam.get("webcamId", "")),
            "name": cam.get("title") or "Webcam",
            "area": ", ".join(filter(None, [location.get("city"), location.get("country")])),
            "lat": location["latitude"],
            "lon": location["longitude"],
            "image": images["preview"],
            "source": "Windy",
        })
    data = json.dumps({"stations": stations}).encode()
    _mem_put(key, data)
    return data, "network"


KARTAVIEW_URL = (
    "https://api.kartaview.org/2.0/photo/"
    "?lat={lat:.5f}&lng={lon:.5f}&radius={radius}&itemsPerPage=60"
)


def streetview(lat, lon, radius=400):
    """Crowdsourced street-level photos around a point, from KartaView.

    Google Street View needs a paid key; KartaView is the open equivalent and
    answers anonymously. Coverage is wherever someone has driven with a camera.
    """
    key = f"street_{lat:.3f}_{lon:.3f}"
    hit = _mem_get(key)
    if hit and time.time() - hit[0] < 86400:
        return hit[1], "memory"

    payload = json.loads(fetch(KARTAVIEW_URL.format(lat=lat, lon=lon, radius=radius)))
    shots = []
    for photo in (payload.get("result") or {}).get("data") or []:
        try:
            shots.append({
                "id": photo["id"],
                "lat": float(photo["lat"]),
                "lon": float(photo["lng"]),
                "heading": float(photo.get("heading") or 0),
                "date": (photo.get("shotDate") or "")[:10],
                "image": photo["fileurlProc"],
                "thumb": photo["fileurlTh"],
            })
        except (KeyError, TypeError, ValueError):
            continue
    data = json.dumps({"shots": shots}).encode()
    _mem_put(key, data)
    log(f"streetview {lat:.3f},{lon:.3f}: {len(shots)} photos")
    return data, "network"


SHIP_KINDS = [
    (80, 89, "Tanker"), (70, 79, "Cargo"), (60, 69, "Passenger"),
    (50, 59, "Service / tug"), (40, 49, "High-speed craft"),
]
SHIP_SINGLES = {30: "Fishing", 35: "Military", 36: "Sailing", 37: "Pleasure craft"}


def ship_kind(ship_type):
    if not ship_type:
        return "Unknown"
    if ship_type in SHIP_SINGLES:
        return SHIP_SINGLES[ship_type]
    for low, high, name in SHIP_KINDS:
        if low <= ship_type <= high:
            return name
    return "Other"


def vessels(bbox):
    """Every ship we can see in this view, from whichever feeds cover it.

    Digitraffic is complete but Baltic-only; aisstream (with a key) is worldwide
    but only reports what it is subscribed to, so the view is passed upstream.
    """
    lamin, lomin, lamax, lomax = bbox
    out = {}

    try:
        raw, _ = cached("vessels", *FEEDS["vessels"])
        meta_raw, _ = cached("vessel-meta", *FEEDS["vessel-meta"])
        meta = {v["mmsi"]: v for v in json.loads(meta_raw)}
        for feature in json.loads(raw).get("features", []):
            lon, lat = feature["geometry"]["coordinates"][:2]
            if not (lamin <= lat <= lamax and lomin <= lon <= lomax):
                continue  # the Baltic feed is national; the view is not
            props = feature["properties"]
            mmsi = feature.get("mmsi") or props.get("mmsi")
            record = meta.get(mmsi, {})
            heading = props.get("heading")
            out[mmsi] = {
                "mmsi": mmsi,
                "lat": lat,
                "lon": lon,
                "sog": props.get("sog") or 0.0,
                "track": heading if isinstance(heading, (int, float)) and heading < 360
                         else props.get("cog") or 0.0,
                "name": (record.get("name") or "").strip() or f"MMSI {mmsi}",
                "kind": ship_kind(record.get("shipType")),
                "destination": (record.get("destination") or "").strip(),
                "callSign": (record.get("callSign") or "").strip(),
                "imo": record.get("imo") or 0,
                "draught": (record.get("draught") or 0) / 10,
                "source": "Digitraffic",
            }
    except Exception as exc:  # noqa: BLE001 - one feed down must not empty the layer
        log(f"digitraffic AIS unavailable: {exc}")

    if AIS:
        AIS.want(lamin, lomin, lamax, lomax)
        for ship in AIS.snapshot():
            if not (lamin <= ship["lat"] <= lamax and lomin <= ship["lon"] <= lomax):
                continue
            if ship["mmsi"] in out:  # Digitraffic already has it, with fuller metadata
                continue
            out[ship["mmsi"]] = {
                "mmsi": ship["mmsi"],
                "lat": ship["lat"],
                "lon": ship["lon"],
                "sog": ship["sog"],
                "track": ship["track"],
                "name": ship["name"] or f"MMSI {ship['mmsi']}",
                "kind": ship_kind(ship.get("shipType")),
                "destination": ship.get("destination", ""),
                "callSign": ship.get("callSign", ""),
                "imo": ship.get("imo", 0),
                "draught": 0,
                "source": "aisstream",
            }

    return json.dumps({
        "vessels": list(out.values()),
        # Why the view is empty matters: outside the Baltic there is simply no
        # keyless AIS, and aisstream can be connected without delivering.
        "coverage": {
            "aisstream": "off" if not AIS else
                         ("live" if AIS.messages else
                          ("connected" if AIS.connected else "reconnecting")),
            "aisstream_messages": AIS.messages if AIS else 0,
            "digitraffic_area": "Baltic Sea",
        },
    }).encode(), "network"


def cameras():
    """Merge every public camera network into one flat list of stations.

    Each network describes itself differently, so the normalising happens here
    and the client only ever sees {id, name, area, lat, lon, image, source}.
    """
    hit = _mem_get("cameras")
    if hit and time.time() - hit[0] < 900:
        return hit[1], "memory"

    stations = []
    try:
        url, mem_ttl, disk_ttl = FEEDS["cameras-fi"]
        geo = json.loads(cached("cameras-fi", url, mem_ttl, disk_ttl)[0])
        for feature in geo.get("features", []):
            props = feature["properties"]
            presets = [p for p in (props.get("presets") or []) if p.get("inCollection")]
            presets = presets or (props.get("presets") or [])
            if not presets:
                continue
            lon, lat = feature["geometry"]["coordinates"][:2]
            # A Finnish station is usually several cameras pointing different
            # ways; keep every direction so the viewer can look around.
            views = [
                {"id": p["id"], "image": f"https://weathercam.digitraffic.fi/{p['id']}.jpg"}
                for p in presets
            ]
            stations.append({
                "id": props["id"],
                "name": (props.get("names") or {}).get("en") or props.get("name"),
                "area": props.get("municipality") or "Finland",
                "lat": lat,
                "lon": lon,
                "image": views[0]["image"],
                "views": views,
                "source": "Digitraffic",
            })
    except Exception as exc:  # noqa: BLE001 - one network down must not sink the layer
        log(f"camera network FI unavailable: {exc}")

    try:
        url, mem_ttl, disk_ttl = FEEDS["cameras-uk"]
        for place in json.loads(cached("cameras-uk", url, mem_ttl, disk_ttl)[0]):
            props = {p["key"]: p["value"] for p in place.get("additionalProperties", [])}
            if props.get("available") == "false" or not props.get("imageUrl"):
                continue
            stations.append({
                "id": place["id"].replace("JamCams_", ""),
                "name": place.get("commonName"),
                "area": "London",
                "lat": place["lat"],
                "lon": place["lon"],
                "image": props["imageUrl"],
                "source": "Transport for London",
            })
    except Exception as exc:  # noqa: BLE001
        log(f"camera network UK unavailable: {exc}")

    if KEYS.get("trafikverket"):
        try:
            stations.extend(trafikverket_cameras())
        except Exception as exc:  # noqa: BLE001
            log(f"camera network SE unavailable: {exc}")

    if KEYS.get("windy"):
        try:
            stations.extend(windy_cameras())
        except Exception as exc:  # noqa: BLE001
            log(f"camera network Windy unavailable: {exc}")

    data = json.dumps({"stations": stations}).encode()
    if stations:
        _mem_put("cameras", data)
    log(f"cameras: {len(stations)} stations merged")
    return data, "network"


# The main Overpass instance is often saturated; the mirrors are not, and a
# request that fails on one usually succeeds on the next.
# Planet-wide instances only. Regional mirrors (overpass.osm.ch, for one) answer
# fast and empty outside their country, which poisons the cache silently.
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
]
OVERPASS_TIMEOUT = 15  # fail over quickly rather than waiting out a busy mirror
OVERPASS_COOLDOWN = 300  # when every mirror is down, stop trying for a while

# Without this, a mirror outage is worse than useless: each request holds a slot
# for a minute and a half while it walks the dead mirrors, and the queue starves
# every other request behind it — including ones that only needed the cache.
_overpass_break = {"until": 0.0, "fails": 0}
OVERPASS_QUERY = (
    '[out:json][timeout:40];way["building"]({s:.4f},{w:.4f},{n:.4f},{e:.4f});out geom;'
)
TILE = 0.01  # degrees; roughly a city block grid, and the unit that gets cached
_overpass_slots = threading.Semaphore(3)  # Overpass gives each IP very few slots


def overpass(query):
    """Run an Overpass query, walking the mirrors until one answers."""
    if time.time() < _overpass_break["until"]:
        raise ConnectionError("overpass paused after repeated failures")
    last = None
    with _overpass_slots:
        for mirror in OVERPASS_MIRRORS:
            try:
                req = urllib.request.Request(
                    mirror,
                    data=query.encode(),
                    headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"},
                )
                with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT) as resp:
                    raw = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                if not json.loads(raw).get("elements"):
                    # An empty answer is usually a mirror that does not hold this
                    # part of the planet; ask the next one before believing it.
                    last = ValueError("empty result")
                    continue
                _overpass_break["fails"] = 0
                return raw
            except Exception as exc:  # noqa: BLE001 - try the next mirror
                last = exc
                log(f"overpass mirror {mirror.split('/')[2]} failed: {exc}")
    _overpass_break["fails"] += 1
    if _overpass_break["fails"] >= 2:
        _overpass_break["until"] = time.time() + OVERPASS_COOLDOWN
        log(f"overpass: every mirror down, pausing for {OVERPASS_COOLDOWN // 60} min")
    raise last


def buildings(tile_lat, tile_lon):
    """OSM building footprints for one 0.01° tile, extruded client-side.

    Photorealistic 3D tiles need a paid key; OSM footprints plus building:levels
    are the free way to have a skyline to fly through at street level.
    """
    key = f"buildings_{tile_lat}_{tile_lon}"
    hit = _mem_get(key)
    if hit:
        return hit[1], "memory"

    path = _disk_path(key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            data = fh.read()
        _mem_put(key, data)
        return data, "disk"

    south = tile_lat * TILE
    west = tile_lon * TILE
    query = OVERPASS_QUERY.format(s=south, w=west, n=south + TILE, e=west + TILE)
    raw = overpass(query)

    out = []
    for way in json.loads(raw).get("elements", []):
        geometry = way.get("geometry") or []
        if len(geometry) < 4:
            continue
        tags = way.get("tags", {})
        height = None
        try:
            if tags.get("height"):
                height = float(str(tags["height"]).split()[0])
            elif tags.get("building:levels"):
                height = float(tags["building:levels"]) * 3.2
        except ValueError:
            height = None
        ring = []
        for point in geometry:
            ring.append(round(point["lon"], 6))
            ring.append(round(point["lat"], 6))
        out.append({
            "h": round(height or 8.0, 1),
            "ring": ring,
            "name": tags.get("name") or "",
            "kind": tags.get("building") or "yes",
        })

    data = json.dumps({"buildings": out}).encode()
    _mem_put(key, data)
    if not out:
        return data, "empty"  # do not cache a blank tile; the next visit retries
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    _sweep_disk()
    log(f"buildings {tile_lat},{tile_lon}: {len(out)} footprints")
    return data, "network"


def _adsb_circle(lat, lon):
    """One circle of aircraft, from whichever community feed answers first."""
    last = None
    for url in ADSB_URLS:
        try:
            return fetch(url.format(lat=lat, lon=lon, radius=ADSB_RADIUS_NM))
        except Exception as exc:  # noqa: BLE001 - try the next network
            last = exc
    raise last


def adsb_states(bbox, circles=None):
    """Fetch the same picture from adsb.lol and reshape it into OpenSky state vectors.

    adsb.lol asks for a centre and a radius in nautical miles instead of a box,
    so the view rectangle becomes the circle that contains it (capped at the
    3000 nm the API will serve).
    """
    lamin, lomin, lamax, lomax = bbox

    # One 250 nm circle covers ~8° of latitude, so lay circles across the view on
    # that spacing — then spend the call budget from the middle of the view
    # outwards, because a wide view cannot be covered and the centre is what the
    # viewer is actually looking at.
    step = ADSB_RADIUS_NM / 60 * 1.4
    mid_lat = (lamin + lamax) / 2
    mid_lon = (lomin + lomax) / 2
    centres = []
    lat = lamin + step / 2
    while lat < lamax + step / 2:
        squeeze = max(0.15, abs(math.cos(math.radians(lat))))
        lon = lomin + step / squeeze / 2
        while lon < lomax + step / squeeze / 2:
            centres.append((min(lat, 89.0), ((lon + 180) % 360) - 180))
            lon += step / squeeze
        lat += step
    if not centres:
        centres = [(mid_lat, mid_lon)]
    centres.sort(key=lambda c: (c[0] - mid_lat) ** 2 + ((c[1] - mid_lon) * 0.6) ** 2)
    wanted_circles = len(centres)
    centres = centres[:circles or ADSB_MAX_CALLS]

    merged = {}
    now = time.time()
    for index, (lat, lon) in enumerate(centres):
        if index:
            time.sleep(ADSB_PACE)  # adsb.fi answers 429 to back-to-back calls
        try:
            data = json.loads(
                _adsb_circle(lat, lon)
            )
        except Exception as exc:  # noqa: BLE001 - one blank circle is not fatal
            log(f"adsb circle {lat:.0f},{lon:.0f} failed on every feed: {exc}")
            time.sleep(ADSB_PACE)
            continue
        now = data.get("now", now)
        for ac in data.get("aircraft") or []:
            if ac.get("hex"):
                merged[ac["hex"]] = ac

    states = []
    for ac in merged.values():
        if ac.get("lat") is None or ac.get("lon") is None:
            continue
        baro = ac.get("alt_baro")
        on_ground = baro == "ground"
        geo = ac.get("alt_geom")
        states.append([
            ac.get("hex", ""),
            (ac.get("flight") or "").strip(),
            "",  # OpenSky puts the country of registry here; adsb.lol has none
            now - (ac.get("seen_pos") or 0),
            now - (ac.get("seen") or 0),
            ac["lon"],
            ac["lat"],
            None if on_ground or not isinstance(baro, (int, float)) else baro * 0.3048,
            on_ground,
            (ac.get("gs") or 0) * 0.514444,
            ac.get("track") or 0,
            (ac.get("baro_rate") or 0) * 0.00508,
            None,
            geo * 0.3048 if isinstance(geo, (int, float)) else None,
            ac.get("squawk"),
            False,
            0,
            ac.get("r") or "",  # extras beyond the OpenSky schema: registration
            ac.get("t") or "",  # and ICAO type code
            1 if (ac.get("dbFlags") or 0) & 1 else 0,  # military
        ])
    return {
        "time": now,
        "states": states,
        "source": "adsb.fi",
        # A wide view cannot be covered by 250 nm circles, so say how much of it
        # was actually sampled rather than letting an empty ocean read as a fault.
        "sampled": {
            "circles": len(centres),
            "radius_nm": ADSB_RADIUS_NM,
            "covers_view": len(centres) >= wanted_circles,
        },
    }


def flights(bbox):
    """bbox is (lamin, lomin, lamax, lomax); rounded so nearby views share a cache slot."""
    global _opensky_blocked_until

    lamin, lomin, lamax, lomax = bbox
    key = "flights:%.0f,%.0f,%.0f,%.0f" % bbox
    now = time.time()
    hit = _mem_get(key)
    if hit and now - hit[0] < FLIGHTS_TTL:
        return hit[1], "memory"

    with _lock_for(key):
        hit = _mem_get(key)
        if hit and time.time() - hit[0] < FLIGHTS_TTL:
            return hit[1], "memory"

        payload = None
        source = "network"
        if time.time() >= _opensky_blocked_until:
            url = FLIGHTS_URL + "?" + urllib.parse.urlencode(
                {"lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax}
            )
            try:
                token = opensky_token()
                if token:
                    req = urllib.request.Request(
                        url,
                        headers={
                            "Authorization": f"Bearer {token}",
                            "User-Agent": USER_AGENT,
                            "Accept-Encoding": "gzip",
                        },
                    )
                    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                        raw = resp.read()
                        if resp.headers.get("Content-Encoding") == "gzip":
                            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                    payload = json.loads(raw)
                else:
                    payload = json.loads(fetch(url))
                payload["source"] = "opensky"
                payload["sampled"] = {"circles": 1, "radius_nm": 0, "covers_view": True}
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    wait = int(exc.headers.get("X-Rate-Limit-Retry-After-Seconds", 3600))
                    _opensky_blocked_until = time.time() + min(wait, 86400)
                    log(f"opensky quota spent, falling back to adsb.fi for {wait // 3600} h")
                else:
                    log(f"opensky error {exc.code}, falling back to adsb.fi")
            except Exception as exc:  # noqa: BLE001 - network hiccup, try the other feed
                log(f"opensky unreachable ({exc}), falling back to adsb.fi")

        # The two networks see different aircraft: OpenSky covers the planet,
        # the community feeders often see more inside one region. When the view
        # is tight enough for it to matter, take both.
        if payload is not None and (lamax - lamin) < 8 and (lomax - lomin) < 12:
            try:
                extra = adsb_states(bbox, circles=1)
                known = {s[0] for s in payload.get("states") or []}
                added = [s for s in extra["states"] if s[0] not in known]
                if added:
                    payload.setdefault("states", []).extend(added)
                    payload["source"] = "opensky + adsb.fi"
            except Exception as exc:  # noqa: BLE001 - the main picture still stands
                log(f"local top-up failed: {exc}")

        if payload is None:
            try:
                payload = adsb_states(bbox)
                source = "fallback"
            except Exception as exc:  # noqa: BLE001 - both feeds down
                log(f"adsb.lol failed too: {exc}")
                if hit:
                    return hit[1], "stale"
                raise

        # Tag military airframes whichever feed produced the picture. OpenSky
        # state vectors are 17 long, so index 17-19 are ours: registration, type
        # and the military flag.
        mil = military_hexes()
        for state in payload.get("states") or []:
            while len(state) < 20:
                state.append("" if len(state) < 19 else 0)
            if state[0] and state[0].lower() in mil:
                state[19] = 1

        data = json.dumps(payload).encode()
        _mem_put(key, data)
        return data, source


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def end_headers(self):
        # Static files are edited while the server runs; a cached index.html that
        # silently drops a new <script> tag is a nasty way to lose an afternoon.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter than the default access log
        if "/api/" in (self.path or ""):
            return
        return

    def _send(self, code, body, ctype="application/json", source=""):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if source:
            self.send_header("X-Cache", source)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 - http.server API
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/api/marks", "/api/keys", "/api/usage",
                               "/api/manual"):
            return self._send(404, b'{"error":"not a writable endpoint"}')
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            if parsed.path == "/api/marks":
                return self._send(200, write_marks(body))
            if parsed.path == "/api/usage":
                return self._send(200, bump_usage(body))
            if parsed.path == "/api/manual":
                return self._send(200, write_manual(body))
            return self._send(200, write_keys(body))
        except Exception as exc:  # noqa: BLE001 - report bad input as JSON
            return self._send(400, json.dumps({"error": str(exc)}).encode())

    def do_GET(self):  # noqa: N802 - http.server API
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return super().do_GET()

        name = parsed.path[len("/api/"):].strip("/")
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if name == "flights":
                bbox = self._bbox(query)
                data, source = flights(bbox)
            elif name == "vessels":
                data, source = vessels(self._bbox(query))
            elif name == "cameras":
                data, source = cameras()
            elif name == "streetview":
                try:
                    data, source = streetview(
                        float(query["lat"][0]), float(query["lon"][0])
                    )
                except (KeyError, ValueError, IndexError):
                    return self._send(400, b'{"error":"lat and lon required"}')
            elif name == "cameras-nearby":
                try:
                    data, source = cameras_nearby(
                        float(query["lat"][0]), float(query["lon"][0])
                    )
                except (KeyError, ValueError, IndexError):
                    return self._send(400, b'{"error":"lat and lon required"}')
            elif name == "aircraft":
                data, source = aircraft_dossier(
                    (query.get("hex") or [""])[0].lower(),
                    (query.get("callsign") or [""])[0].strip().upper(),
                    (query.get("type") or [""])[0].strip().upper(),
                )
            elif name == "buildings":
                try:
                    tile_lat = int(query["lat"][0])
                    tile_lon = int(query["lon"][0])
                except (KeyError, ValueError, IndexError):
                    return self._send(400, b'{"error":"lat and lon tile indices required"}')
                data, source = buildings(tile_lat, tile_lon)
            elif name in FEEDS:
                url, mem_ttl, disk_ttl = FEEDS[name]
                data, source = cached(name, url, mem_ttl, disk_ttl)
            elif name == "aircraft-types":
                wanted = [h.strip().lower() for h in (query.get("hex") or [""])[0].split(",")]
                wanted = [h for h in wanted if h][:25]
                data = json.dumps({h: aircraft_type(h) for h in wanted}).encode()
                source = "registry"
            elif name == "imagery-date":
                try:
                    data, source = imagery_date(
                        float(query["lat"][0]), float(query["lon"][0])
                    )
                except (KeyError, ValueError, IndexError):
                    return self._send(400, b'{"error":"lat and lon required"}')
            elif name == "vessel-photo":
                data = json.dumps(
                    vessel_photo((query.get("name") or [""])[0])
                ).encode()
                source = "commons"
            elif name == "ship":
                title = (query.get("title") or [""])[0]
                if not title:
                    return self._send(400, b'{"error":"title required"}')
                data, source = ship_summary(title)
            elif name == "ion-token":
                # Two keys must reach the browser, because Cesium streams terrain,
                # buildings and photogrammetry from the page itself rather than
                # through us. Both are designed to be public: ion tokens are
                # scoped in the ion dashboard, and Google Maps browser keys are
                # meant to be restricted by HTTP referrer. Neither is a secret
                # that hiding would protect. The server listens on 127.0.0.1, so
                # nothing off this machine can ask for them anyway.
                data = json.dumps({
                    "token": KEYS.get("cesium_ion", ""),
                    "google": KEYS.get("google_maps", ""),
                }).encode()
                source = "memory"
            elif name == "keys":
                # Never the values: the page only ever learns whether one is set.
                #
                # Built from ALLOWED_KEYS rather than its own list. It used to
                # carry a copy of the seven names that existed when it was
                # written, so every key added afterwards read as "not set" in
                # SETUP however correctly it was saved - the field was telling
                # the truth about a list, not about the key.
                data = json.dumps({
                    k: bool(KEYS.get(k)) for k in ALLOWED_KEYS
                }).encode()
                source = "memory"
            elif name == "place":
                try:
                    lat = round(float(query.get("lat", ["0"])[0]), 1)
                    lon = round(float(query.get("lon", ["0"])[0]), 1)
                except ValueError:
                    return self._send(400, b'{"error":"lat and lon required"}')
                data = json.dumps({"place": place_name(lat, lon)}).encode()
                source = "memory"
            elif name == "trains":
                data, source = trains()
            elif name == "mesh":
                box = query.get("bbox", [""])[0].split(",")
                if len(box) != 4:
                    return self._send(400, b'{"error":"bbox=w,s,e,n required"}')
                data, source = mesh_nodes(tuple(float(v) for v in box))
            elif name == "newsheat":
                data, source = news_heat()
            elif name == "netoutages":
                data, source = internet_outages()
            elif name == "recon":
                data, source = recon(query.get("kind", [""])[0],
                                     query.get("target", [""])[0])
            elif name == "spaceweather":
                data, source = space_weather()
            elif name == "weather":
                data, source = weather_alerts()
            elif name == "powerplants":
                box = query.get("bbox", [""])[0].split(",")
                if len(box) != 4:
                    return self._send(400, b'{"error":"bbox=w,s,e,n required"}')
                data, source = power_plants(tuple(float(v) for v in box),
                                            float(query.get("min_mw", ["0"])[0]))
            elif name == "headofstate":
                who = query.get("country", [""])[0]
                if not who:
                    return self._send(400, b'{"error":"country required"}')
                data = json.dumps(head_of_state(who)).encode()
                source = "memory"
            elif name == "broadcast":
                try:
                    lat = float(query.get("lat", ["0"])[0])
                    lon = float(query.get("lon", ["0"])[0])
                    radius = float(query.get("radius", ["200"])[0])
                except ValueError:
                    return self._send(400, b'{"error":"lat, lon, radius"}')
                data, source = broadcast_stations(lat, lon, radius)
            elif name == "airports":
                box = query.get("bbox", [""])[0].split(",")
                if len(box) != 4:
                    return self._send(400, b'{"error":"bbox=w,s,e,n required"}')
                data, source = airports(tuple(float(v) for v in box))
            elif name == "entity":
                q = query.get("q", [""])[0].strip()
                if not q:
                    return self._send(400, b'{"error":"q required"}')
                data, source = entity_graph(q[:80])
            elif name == "aprs":
                box = query.get("bbox", [""])[0].split(",")
                if len(box) != 4:
                    return self._send(400, b'{"error":"bbox=w,s,e,n required"}')
                data, source = aprs_stations(tuple(float(v) for v in box))
            elif name == "search":
                data, source = search(query.get("q", [""])[0])
            elif name == "geocode":
                # The page cannot pace Nominatim politely on its own, and every
                # open tab would pace separately. One queue, here.
                q = query.get("q", [""])[0].strip()
                if not q:
                    return self._send(400, b'{"error":"q required"}')
                point = country_point(q[:120])
                data = json.dumps({
                    "q": q,
                    "lat": point[0] if point else None,
                    "lon": point[1] if point else None,
                }).encode()
                source = "memory"
            elif name == "kiwisdr":
                data, source = kiwisdr()
            elif name == "incidents":
                data, source = incidents(
                    float(query.get("south", ["0"])[0]),
                    float(query.get("west", ["0"])[0]),
                    float(query.get("north", ["0"])[0]),
                    float(query.get("east", ["0"])[0]))
            elif name == "launches":
                data, source = launches()
            elif name == "infrastructure":
                data, source = infrastructure(
                    float(query.get("south", ["0"])[0]),
                    float(query.get("west", ["0"])[0]),
                    float(query.get("north", ["0"])[0]),
                    float(query.get("east", ["0"])[0]))
            elif name == "tomtom":
                data, source = tomtom_key()
            elif name == "airquality":
                data, source = air_quality(
                    float(query.get("lat", ["0"])[0]),
                    float(query.get("lon", ["0"])[0]),
                    float(query.get("radius", ["25"])[0]))
            elif name == "fishing":
                data, source = fishing(
                    float(query.get("lat", ["0"])[0]),
                    float(query.get("lon", ["0"])[0]),
                    float(query.get("radius", ["200"])[0]))
            elif name == "borders":
                data, source = borders()
            elif name == "volcanoes":
                data, source = volcanoes()
            elif name == "outbreaks":
                data, source = outbreaks()
            elif name == "briefing":
                data, source = briefing()
            elif name == "satellite":
                norad = query.get("norad", [""])[0]
                if not norad.isdigit():
                    return self._send(400, b'{"error":"norad required"}')
                data, source = satellite_dossier(norad, query.get("name", [""])[0])
            elif name == "fires":
                box = query.get("bbox", [""])[0].split(",")
                if len(box) != 4:
                    return self._send(400, b'{"error":"bbox=w,s,e,n required"}')
                data, source = fires(tuple(float(v) for v in box))
            elif name == "usage":
                data, source = read_usage()
            elif name == "manual":
                data, source = read_manual()
            elif name == "marks":
                data, source = read_marks()
            elif name == "submarine-bases":
                with open(os.path.join(ROOT, "data", "submarine_bases.json"), "rb") as fh:
                    data = fh.read()
                source = "file"
            elif name == "carriers":
                data, source = carriers()
            elif name in ("health", "version"):
                data = json.dumps({
                    "ok": True,
                    "version": VERSION,
                    "built": BUILT,
                    "keys": sorted(KEYS),  # which optional networks are enabled
                }).encode()
                source = "memory"
            else:
                return self._send(404, b'{"error":"unknown feed"}')
        except ValueError as exc:
            # Our own validation refusing the request: that is the caller's
            # fault, and 502 would blame a provider that was never asked.
            body = json.dumps({"error": str(exc), "feed": name}).encode()
            return self._send(400, body)
        except Exception as exc:  # noqa: BLE001 - report upstream trouble as JSON
            body = json.dumps({"error": str(exc), "feed": name}).encode()
            return self._send(502, body)
        ctype = "text/plain; charset=utf-8" if name in TEXT_FEEDS else "application/json"
        return self._send(200, data, ctype=ctype, source=source)

    @staticmethod
    def _bbox(query):
        def num(key, default, lo, hi):
            try:
                value = float(query.get(key, [default])[0])
            except (TypeError, ValueError):
                value = default
            return max(lo, min(hi, value))

        lamin = num("lamin", -90, -90, 90)
        lamax = num("lamax", 90, -90, 90)
        lomin = num("lomin", -180, -180, 180)
        lomax = num("lomax", 180, -180, 180)
        if lamin > lamax:
            lamin, lamax = lamax, lamin
        if lomin > lomax:
            lomin, lomax = lomax, lomin
        return round(lamin), round(lomin), round(lamax), round(lomax)


def main():
    parser = argparse.ArgumentParser(description="Global Command View local server")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    global AIS
    if KEYS.get("aisstream"):
        try:
            from aisstream import AisStream
            AIS = AisStream(KEYS["aisstream"], log=log)
        except Exception as exc:  # noqa: BLE001 - the rest of the app is fine without
            log(f"aisstream unavailable: {exc}")

    url = f"http://{args.host}:{args.port}"
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        log(f"cannot listen on port {args.port}: {exc}")
        log(f"something is already using it — open {url} or start with --port 8821")
        raise SystemExit(1)

    log(f"Global Command View v{VERSION} ({BUILT}) on {url}")
    log("feeds: flights (OpenSky), vessels + cameras (Digitraffic), cables (TeleGeography)")
    log("press Ctrl+C to stop")
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
