Thirty-two markers were half-buried in the ground, and a source that had stopped
answering was reporting zero.

## Download

**GlobalCommandView-1.7.6.zip** below.

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

## Half-moons everywhere

Reported first as the Swedish trains being small half-round dots, then as
*"radio stations too, and my own marks, and vessels — can you look yourself, it
seems to be a lot"*. It was.

A point drawn at ellipsoid height zero sits inside any ground above sea level.
Depth tested against that ground, half of it disappears into the hill, and what
is left is drawn as half a point.

A survey of the file found **thirty-three markers drawn on the ground**:

| | |
|---|---|
| no depth exemption at all | **17** |
| the fifty kilometres a saved mark uses | **15** |
| already fixed | 1 |

Fifty kilometres is the distance you have flown down to a valley from. It is not
the distance you look at a country from, and at national scale every marker on
screen was past it.

### The right value falls out of the geometry, and both bounds bite

| camera height | horizon | antipode |
|---|---|---|
| 80 km | 1 013 km | 12 822 km |
| 300 km | 1 978 km | 13 042 km |
| 1 000 km | 3 707 km | 13 742 km |
| 20 000 km | 25 590 km | 32 742 km |

Larger than the horizon and markers beyond the curve of the Earth shine through
the ground in front of them. Larger than the antipode and a dot from the far
side follows the view around — which is the complaint that produced the fifty
kilometres in the first place.

**A thousand kilometres** sits inside the horizon from eighty kilometres up and
everywhere above it, and is nowhere near the antipode at any height. Below
eighty you are looking at a town, where everything on screen is a few kilometres
away and none of this applies.

All thirty-three now: vessels, earthquakes, fires, power stations, radio
stations, shortwave receivers, scanners, APRS, mesh nodes, volcanoes, outbreaks,
airports, navaids, METAR, launch pads, submarine bases, capital ships, news
attention, internet outages, disaster alerts, both train layers, Swedish road
disruption, your own marks and entries, and the two click markers.

The measuring tool and the aircraft tracking brackets keep the old value.
Neither stands on the ground.

## A source that did not answer is not a count of zero

Reported mid-recording: **Fishing & AIS gaps** showing 0 when it had worked
earlier.

Global Fishing Watch had stopped answering. Their gateway replies in two tenths
of a second with *invalid token* when called without one, so the host is up — but
a real query with a real key times out. Measured three ways: three datasets over
fourteen days, one dataset over fourteen days, three datasets over three days.
All timed out at forty-five seconds. Nothing to do with the query, and nothing to
do with this app.

**But the panel said 0, and that was ours.** Here a zero means the feed replied
and there was nothing there. The client logged the failure and returned without
touching the count, so the row kept reading 0 and looked like an empty ocean
rather than a service that was down. The reason was in the log, and logs scroll.

The counter had two states: a dot for a layer that has not been asked, and a
figure for one that answered. It has a third now — **an em dash in amber, for
asked and no reply** — and the row's tooltip says *the source did not answer, so
this is not a count of zero*.

## And the trains

Ten pixels instead of seven, a proper dark ring, and eight at the far end of the
distance scale instead of three and a half. Three and a half pixels of pale green
on a satellite photograph is a speck, not a train.

Full detail in `CHANGELOG.md`.
