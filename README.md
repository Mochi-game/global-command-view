# Global Command View — working build

A live spatial-intelligence globe built only from public, key-free feeds. Aircraft,
ships, submarine cables and public road cameras on one photorealistic 3D earth, with
a thermal optics mode.

Double-click **Global Command View** on the desktop — the cyan globe. It starts the
server and opens the browser; the amber icon beside it stops the server. Or from
a terminal:

```bash
python I:/global-command-view/server.py --port 8820
```

It opens your browser at <http://localhost:8820> by itself; `--no-open` skips that
and `--port 8821` moves it if something already holds the port. Leave the window
running — closing it stops the server. Ctrl+C shuts it down.

No API keys, no build step, no npm install — Python 3 and a browser is the whole
dependency list. Cesium is loaded from a CDN, so the first load needs internet.

## What is on the globe

| Layer | Source | Refresh | Coverage |
| --- | --- | --- | --- |
| Air traffic | [OpenSky Network](https://opensky-network.org/) (whole planet per call), topped up by [adsb.fi](https://adsb.fi/) when zoomed in | 15 s | worldwide, ~13 000 aircraft |
| Military aircraft | adsb.lol military register | 2 min | worldwide, tagged inside the air layer |
| Helicopters and operators | [adsbdb](https://www.adsbdb.com/) civil registry | on sight | worldwide, police / medical / military / coastguard |
| Ship photographs | [Wikimedia Commons](https://commons.wikimedia.org/) | on click | by name, where a photograph exists |
| Vessels (AIS) | [Digitraffic](https://www.digitraffic.fi/en/marine-traffic/) + [aisstream](https://aisstream.io/) with a key | 20 s | Baltic without a key, worldwide with one |
| Submarine cables | [TeleGeography](https://www.submarinecablemap.com/) | on load | worldwide, 724 systems |
| Public cameras | [Digitraffic](https://www.digitraffic.fi/en/road-traffic/), [TfL JamCams](https://api.tfl.gov.uk/), [Trafikverket](https://api.trafikinfo.trafikverket.se/), [Windy](https://api.windy.com/) | on click | 4 112 stations: Sweden 1 528 · Finland 812 · London 787 · Windy 985 worldwide |
| Satellites | [CelesTrak](https://celestrak.org/) orbital elements | continuous | worldwide, 16 076 objects |
| Buildings | [OSM via Overpass](https://overpass-api.de/) | on descent | worldwide, wherever OSM has footprints |
| Street photos | [KartaView](https://kartaview.org/) | on descent | worldwide, wherever someone has driven with a camera |
| Seismic | [USGS](https://earthquake.usgs.gov/) | 10 min | worldwide, M2.5+ over the last week |
| Thermal / fires | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) | 30 min | worldwide VIIRS detections, last 24 h — heat, not only wildfire |
| Street traffic | simulated on [OSM](https://overpass-api.de/) roads | continuous | worldwide, wherever OSM has roads |
| Capital ships | [USNI Fleet Tracker](https://news.usni.org/category/fleet-tracker), by hand | weekly, manual | US Navy carriers and big-deck amphibs |
| Submarine bases | Wikipedia coordinates, curated | static | 16 bases, six navies |

The vessel layer is the regional one, and that is a source problem rather than a
design one: every AIS feed with worldwide coverage sits behind a paid or registered
key, and Digitraffic (Baltic) is what is available without one. Air, cables,
satellites and buildings are worldwide; cameras are worldwide once a Windy key is
present.

Swedish images come back at 1280×720 because the bare `PhotoUrl` serves a 10 kB
thumbnail and `?type=fullsize` serves the real frame.

Adding a camera network is a dozen lines in `cameras()` in `server.py` — normalise
it to `{id, name, area, lat, lon, image, source}` and it appears on the globe.

Selecting an aircraft also fetches a photo of that airframe from
[planespotters](https://www.planespotters.net/) and its scheduled route from
[adsbdb](https://www.adsbdb.com/), and draws the route on the globe: solid from the
origin airport to where it is now, dashed onward to the destination.

Selecting a moving contact gives you a **FOLLOW** button: the camera locks onto it
and stays locked while you orbit and zoom around it. Clicking a camera image opens
a full-screen viewer — scroll to zoom, drag to pan, Esc to close — and stations
with several directions get ‹ › to cycle through them.

Selecting a camera offers **PROJECT ONTO GROUND**: the live frame is painted onto
the earth as a footprint with a coverage cone. No public camera feed carries its
orientation, so heading, field of view and range are sliders you aim by eye —
`SAVE CAL` remembers each station's setting in the browser.

Click any contact for a detail card: callsign, altitude and track for aircraft;
MMSI, IMO, draught and destination for ships; the live image for a camera; NORAD
number, altitude, orbital speed, period and inclination for a satellite, whose
full revolution is then drawn as a track.

The satellite layer is the odd one out: CelesTrak publishes *orbital elements*,
not positions, so nothing is polled. The browser runs SGP4 (satellite.js) against
the wall clock and computes every position itself — a slice of 2 000 objects per
frame, the whole catalogue swept about every 150 ms. Verified against the ISS:
418 km, 7.66 km/s, 92.9 min period. The elements themselves are refreshed from
CelesTrak every 2 hours, which is how often they are re-issued.

## Military traffic

Neither air feed marks what it returns, so the server pulls adsb.lol's military
register (ICAO hex codes of airframes currently airborne, ~320 worldwide) every two
minutes and tags the picture with it, whichever feed produced it. Military contacts
are drawn red, a size larger, designated `MIL-` instead of `AIR-`, and they always
win their cell in detection mode. The feed log counts them: `air: 2 479 contacts in
view · adsb.lol · 44 military`.

## Tip link

The panel carries a fixed link to <https://buymeacoffee.com/myriskdashk>, worded
as a thank-you rather than a condition. It has to stay that way: every feature is
free for everyone, because four of the sources permit non-commercial use only and
a payment somebody must make would break them.

## Handing it to someone else

Copy the `app` folder and the two desktop shortcuts. `keys.json` is per-machine
and gitignored, so nobody inherits your keys — the new user opens **SETUP** in the
top bar, which lists every service worth an account with numbered steps and a
field to paste each key into. **HELP** beside it explains the whole app.

Nothing needs a key to work; keys only widen coverage.

## Optional API keys

Copy `keys.example.json` to `keys.json` (gitignored) and paste in whichever you have.
Everything works without it — a key only adds camera networks that refuse anonymous
callers.

| Key | Adds | Where to get it |
| --- | --- | --- |
| `cesium_ion` | world terrain and 3D buildings | <https://cesium.com/ion/signup> → Community tier, free for personal use |
| `google_maps` | photorealistic 3D mesh | <https://console.cloud.google.com/google/maps-apis/start> → enable Map Tiles API; 1000 root requests/month free, card required |
| `windy` | ~1 000 webcams worldwide | <https://api.windy.com/webcams> → Get API key (free tier) |
| `opensky_client_id` + `opensky_client_secret` | whole-planet air traffic in one call | <https://opensky-network.org/> → register → API client |
| `aisstream` | worldwide ship traffic | <https://aisstream.io/> → sign up → API key |
| `trafikverket` | 1 528 Swedish road cameras | <https://api.trafikinfo.trafikverket.se/> → Registrera → Mina nycklar |

Windy holds ~70 000 webcams but the free tier stops paging at about 1 050, so an
unfiltered pull returns whatever is most popular — which turns out to be the Alps.
`WINDY_REGIONS` in `server.py` spends that budget on country buckets instead, so the
result is a global spread: US 151, Norway 149, Italy 88, Japan 83, Sweden 67,
Chile 45, South Africa 40. Adjust the buckets to taste; the list is cached for a day
on disk, so editing them costs one refetch.

Restart the server after editing `keys.json`. Both networks normalise into the same
station shape as the others; the layer count and the feed log will name them.

## Ruler and marks

`MEASURE DISTANCE` turns clicks into geodesic legs with labels and a running
total — the way to tell a 170 m submarine from a 110 m one. `MARK` saves the
current camera under a name and lists it for one-click return. Marks are written
to `data/marks.json`, so they survive restarts, port changes and cleared browser
data, and they show as pins on the globe.

## How old the picture is

The top bar carries the acquisition date of the satellite imagery under the view
— `IMG 2025-02-14 · 15 cm` — from Esri's own per-scene metadata, warm-coloured
once it is over two years old. A basemap always looks live and never is, and for
counting things at a pier the difference matters.

## What the fleet layer is and is not

Carriers do not broadcast AIS. Nothing published gives their position, and anyone
showing you a live carrier track is showing you a guess. What exists is the U.S.
Naval Institute's weekly tracker of operating areas, and that is what this layer
draws — with a dashed ring around each ship for the uncertainty, and the as-of
date on the card. `data/carriers.json` holds it; to refresh, read the newest
tracker and edit the file.

## Detection mode

The `DETECTION` button puts a corner reticle and a designator on every contact the
sensor can see — `SAT-37218 / STARLINK-37218`, `AIR-SAS1402`, `SEA-265068000 / FREJ`,
`CAM-01503`. Labelling 20 000 contacts at once would be unreadable, so the screen is
divided into cells and each cell surrenders its most central contact; the `Density`
slider sets how many cells get a label (8–120). One pass costs 3–19 ms and runs
about twice a second.

## Ground level

`STAND HERE` arms a viewpoint tool: click a spot and the camera stands there at
1.70 m, where dragging turns your head rather than orbiting the globe and the wheel
works as a zoom lens. Esc lifts you back out.

Bear in mind what street level actually looks like here: OSM boxes with real
heights on top of aerial imagery, not photogrammetry — stand next to a building and
you are standing next to a grey box. The photographic street view is the KartaView
layer: the little arrows on the ground are real photos, and clicking one opens the
full frame.

`DROP TO GROUND` dives to ~320 m and the camera can then descend to 1.5 m. Google's
photorealistic 3D tiles need a paid key, so the skyline is built from OSM building
footprints extruded by `building:levels` — fetched from Overpass one 0.01° tile at a
time, nearest tile first, three requests in flight, and cached on disk forever after.
Expect a city view to fill in over ten or twenty seconds the first time; instantly
after that.

The buildings are grey boxes with real heights, not photogrammetry. Turn them off
with the `OSM buildings` checkbox.

## Controls

- **Layers** — click a row to toggle it; the number is the live contact count.
- **Optics** — `OPS` dark cartographic, `THERMAL` black-body ramp over satellite
  imagery, `SATELLITE` plain Esri imagery, `NIGHT VIS` and `FLIR` sensor emulations,
  `CRT` a real post-process pass on the
  rendered scene: barrel distortion, phosphor scan lines, chromatic separation at
  the edges and a vignette.
- **Sun terminator** — real-time day/night lighting on the globe.
- **Jump to** — preset viewpoints (Palm Jumeirah, Gulf of Finland, Suez, …).
- Drag to rotate, scroll to zoom, middle-drag or ctrl-drag to tilt.

## How it works

`server.py` serves `web/` and proxies each upstream feed. The proxy is not
decoration: none of these APIs send permissive CORS headers, and all of them are
rate limited, so responses are cached in memory (and on disk for the slow-moving
ones) and shared by every open tab. A failed upstream falls back to the last good
response instead of blanking the layer.

`web/app.js` draws everything with Cesium *primitives* rather than entities, which
is what keeps ~7 000 aircraft interactive. Between polls each contact is
dead-reckoned from its own speed and track, so the picture moves continuously
instead of snapping every 15 seconds.

### Rate limits worth knowing

With an API client registered (see keys.json) OpenSky allows 4 000 credits a day
and answers with the whole planet in one call. Anonymously it is 400 credits per
IP per day — a wide view costs 4, a tight one costs 1 — and continuous polling
exhausts that in a few hours. When it does,
OpenSky answers 429 with a retry hint in hours, and the server switches the air
layer to the community ADS-B feeders at [adsb.lol](https://adsb.lol/) until the
quota returns — the HUD log names whichever feed is live. adsb.lol sees fewer
aircraft (roughly 2 500 worldwide against OpenSky's 7 500) because it only has
volunteer receivers. Adding OpenSky credentials to `server.py` lifts the ceiling.

## Layout

```
app/
  server.py      static server + caching feed proxy
  web/index.html HUD markup
  web/style.css  HUD styling and the thermal ramp
  web/app.js     globe, layers, polling, dead reckoning, picking
```

`window.godsEye` exposes `{ viewer, scene, flights, vessels, layers, collections }`
in the browser console for poking at the scene.

## Attribution

Imagery © Esri and its licensors · © OpenStreetMap contributors © CARTO ·
ADS-B via OpenSky Network · AIS and camera data via Fintraffic / Digitraffic
(CC BY 4.0) · submarine cable geometry via TeleGeography.
