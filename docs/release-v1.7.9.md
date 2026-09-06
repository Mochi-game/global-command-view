Every layer in the app can now tell you that its source went quiet, instead of
showing you a number it no longer has any reason to believe.

## Download

**GlobalCommandView-1.7.9.zip** below.

Right-click the ZIP before unpacking it, choose Properties, tick **Unblock**,
then extract — that saves you every Windows warning afterwards. Then run
**Install Global Command View.cmd**.

> ### ⚠ Upgrading? Copy two things first
>
> Copy **`keys.json`** and the **`data`** folder somewhere safe before you
> install over an existing copy. That is every key you have set up and every view
> you have saved.
>
> Unpacking over the old folder does not touch them — they are kept out of the
> download on purpose. The ways people lose them are deleting the old folder to
> start clean, or unpacking somewhere new and later tidying away the folder the
> keys were still in. Ten seconds, and the risk is gone. Nothing here is
> recoverable from anyone else.

## Thirty feeds that logged a failure and dropped it

Every feed in this app ended the same way: a `catch` that wrote the reason to the
feed log and returned. The log was right, and the log scrolls. What stayed on
screen was the row — holding whatever number it last managed to fetch, or a
nought, or nothing at all. A figure beside a layer is read as a count of what is
out there, and after the source stopped answering it was a count of nothing but
its own history.

Thirty more report it now: air traffic and police & state air, both vessel feeds,
submarine cables, public cameras, names & borders, satellites, seismic, thermal,
disease outbreaks, volcanoes, FM stations, shortwave receivers, police & fire
radio, APRS, airports, severe weather, power stations, internet outages, mesh
radio, news attention, both train layers, own entries, capital ships, navigation
beacons, METAR, runways, SMHI warnings and submarine bases.

| | can say the source went quiet |
|---|---|
| before 1.7.6 | 0 of 39 |
| 1.7.6 | 1 |
| 1.7.8 | 9 |
| **1.7.9** | **39 of 39** |

Checked by driving every row through both states in the running app: all
thirty-nine draw a figure when the feed answers, and an em dash in amber when it
does not, with the tooltip saying *the source did not answer, so this is not a
count of zero*.

**Trains (Sweden)** and **SMHI warnings** were also writing a plain nought when
their source had failed, rather than when it had answered with nothing. The
nought they write when a key is missing stays — that one is true, because
nothing was asked.

## A layer that counted to zero forever

**Weather where you click** carried a count of 0 that nothing ever set. Switch it
on, and the row read 0 — which in this app means the feed answered and there was
nothing there. There is no feed and nothing to tally: you click a spot and read
one forecast.

It shows a dot now, the same as **What it is called**, which is the same shape
and was already marked that way.

## What is still a nought, on purpose

Runways, METAR and navigation beacons answer *too wide* when the view is bigger
than the server will draw. That is not a source going quiet and it is not an
empty sky — it is the app declining to ask. Calling it *no reply* would put a
wrong reason on a row for the sake of a tidy sweep, so it keeps its own message
and is left for a state of its own.

Full detail in `CHANGELOG.md`.
