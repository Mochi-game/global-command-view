Windows stops treating the folder as untrusted, the server no longer leaves a
window on your taskbar, taxiways survive a refresh, and clicking a runway gives
you the field's frequencies.

## Download

**Source code (zip)** below. Unpack it anywhere, then double-click
**Install Global Command View.cmd**. It installs Python for your user account
only if you do not have it, needs no administrator rights, and asks before it
downloads anything.

## Windows no longer treats the folder as untrusted

Everything unpacked from a downloaded ZIP carries Windows' Mark of the Web. It
is what raises the *Windows protected your PC* box on the launchers, and why
`stop.ps1` would not run at all.

The installer now takes that mark off the whole folder before doing anything
else, using Windows' own `Unblock-File` — the same thing the **Unblock** tick
box in a file's Properties dialog does. No security setting is changed, nothing
outside the folder is touched, no administrator rights are needed.

`Trust these files.ps1` does it on its own if you already have the app. It works
only on the folder it sits in and refuses to run unless `server.py` is beside
it, so it cannot be pointed at a directory of things nobody looked at.

You will still meet SmartScreen once, on the installer itself. Something has to
be the first thing you trust. Right-clicking the **ZIP** before unpacking it and
ticking *Unblock* avoids even that.

## The server runs with no window

It used to sit in a console window for as long as the app was up, and closing
that window was how you shut it down — which made a black box on the taskbar
into load-bearing UI.

The launcher now shows a window only while it starts, says it will close itself,
and does, usually inside four seconds. Use the stop icon to shut the app down.

It waits rather than walking away: a server that died on startup would leave you
with no window, no browser and nothing to read, so the launcher polls until the
server answers and, if nothing comes up, stays open and prints the reason. What
used to scroll past in the console goes to `server.log` beside the app.

## Taxiways stay put

Four faults were stacked here, and each hid the next.

The taxiway cache had never actually worked: it was keyed on the exact camera
box, so panning a hundred metres made a new key and asked OpenStreetMap all over
again — a minute each time, and an empty layer whenever Overpass was busy. Eight
cache files were found for one airport, four of them identical. It now asks
whether anything already fetched covers the ground in view, so a second look is
free and zooming in re-uses what zooming out paid for.

The app remembered which layers were on but not where you were looking, so a
reload came back with the taxiway layer lit and the camera in orbit — which
draws nothing and looks exactly like a broken layer. Your view is kept now.

Cesium's view rectangle was also reporting the whole planet for a camera four
kilometres above Arlanda, which drew nine hundred airports on top of the one
underneath you. Airports, runways, weather and beacons now measure the view the
way the taxiway layer already did.

## Click a runway for the frequencies

The airport marker is fifteen pixels wide. A runway is the largest thing on the
airfield, and clicking one now opens the same card: tower, ground, approach,
ATIS and clearance frequencies, the beacons that belong to the field with their
DME channels, and a link to that country's AIP.

There are still no procedures in it — no SID, no STAR, no approach, no minima.
Those belong to Jeppesen and to each country's AIP, and an invented approach
would be worse than none.

Taxiway designators are bold now, and pinned to the ground instead of floating
below the lines they label. The airport marker is solid white in a dark ring,
which survives both pale concrete and yellow paint.

## Credits are visible

The basemap attribution was being built correctly and then hidden by a
stylesheet rule. *Imagery © Esri and its licensors*, the OpenStreetMap ODbL
notice and Cesium ion's credit now appear at the bottom right, which is what
those licences ask for.

## The self-check stops blaming the wrong party

A first install on a second computer reported three registration links as dead
and one feed as HTTP 502. All of them carried `CERTIFICATE_VERIFY_FAILED` —
nothing was wrong with any of those services. That machine could not verify a
certificate.

Those failures are now told apart from real faults and explained once, with what
fixes them. Worth saying plainly, because the report made it look otherwise:
**no feed that needs a key is ever contacted until you have entered one.**

## Also

Air quality and fishing ran against real keys for the first time. OpenAQ's
endpoint accepts a coordinate and a radius and ignores both — a query around
Stockholm was answering with South Korea and California — so it goes a different
way now and drops readings more than a day old. Fishing events had no duration
because the field does not exist; it is worked out from the two ends.

Full detail in `CHANGELOG.md`.
