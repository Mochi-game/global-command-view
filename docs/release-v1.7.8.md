Thirteen satellites nobody could pick out, labels printed on top of each other,
and a panel seven screens tall.

## Download

**GlobalCommandView-1.7.8.zip** below.

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

## Thirteen satellites had no owner, and it was the leading zeros

An element set has five columns for the catalogue number and pads them with
zeros, so LAGEOS 1 is `08820`. CelesTrak's satellite catalogue writes the same
object as `8820`. The owner filter added in 1.7.7 matched the two as strings.

Every active object numbered below 10 000 fell out — **exactly thirteen**, and
not one of them had an owner: the calibration spheres and geodetic targets from
the sixties and seventies. `CALSPHERE 1`, `2` and `4A`, `LCS 1`, `TEMPSAT 1`,
two `OPS 5712` payloads, `LES-5`, `SURCAL 159`, `RIGIDSPHERE 2`, `OSCAR 7` and
`LAGEOS 1` — twelve American — and `STARLETTE`, French. They flew while no owner
was chosen, and vanished the moment you picked the country that owns them.

**0 of 16 032 without an owner now**, against thirteen before.

## A count of satellites that counts the satellites

The layer said 16 032 because that is how many element sets were held in memory.
It is not how many are on the globe.

An object the orbital model cannot place — decayed, or an element set it cannot
integrate — had its dot switched off and stayed in the total. The same shape as
the zero that meant *the source never answered* in 1.7.6: a figure that looks
like an observation and is really a placeholder.

**16 030 of 16 032.** The two are `STARLINK-1595` and `STARLINK-2159`, both on
the way down, and the feed log names them rather than absorbing them.

The owner list had the same fault from the other direction: a row read
**United States 12 850** beside 12 061 dots, because it was quoting CelesTrak's
catalogue rather than counting the globe. 922 objects are catalogued with no
orbit published yet — 546 of them launched this year. Every row counts what is
actually up there now, and the catalogue's total is said once, underneath,
because *no orbit published yet* is a different thing from *missing*.

## Eight more layers that reported a nought for a source that was down

1.7.6 gave the layer counter a third state — an em dash in amber, for *asked and
no reply* — and said the same shape was available to every other layer that
swallowed a failure. One layer used it. Forty-four did not.

Eight of them already had the error in hand and were throwing it away. Four
wrote a plain zero when the source had failed — **open network vessels**, **rain
radar**, **taxiways & aprons**, **Swedish road disruption** — a nought standing
for an empty ocean, an empty sky, an airport with no taxiways. Four more left
the last good figure on screen as though it had just been observed: **air
quality**, **jams & roadworks**, **rocket launches**, **data centres & dams**.

All eight say so now. Nine layers of forty-five can report a source that did not
answer, against one before.

## Forty labels printed on top of each other

The detection overlay gave each contact a screen cell, which guarantees a cell
and not any room: two contacts either side of a shared edge can be four pixels
apart. With the satellite layer on, the globe filled with two-line designators
stacked over one another. Readable text under a stack of other text is not a
label, and forty of them is worse than twelve.

They are laid out for real now, nearest the crosshair first, and one that would
land on a label already placed is dropped. Measured with 9 274 contacts on
screen: **no overlapping pairs, and still all forty labels** — the declutter
did not cost a single one, it just spent them on better-spaced contacts.

## A panel you can navigate

Three things, measured in an 885 pixel window:

| | before | after |
|---|---|---|
| the section index | 147 px, eight wrapped rows | **32 px**, one line |
| the briefing | 3 071 px | **398 px**, scrolling inside itself |
| the whole panel | 6 172 px | **3 465 px** |

The index used to lay all seventeen section names out flat and hold them there
whether or not you were navigating — and it never said which section you were
in, which is the one thing somebody scrolling a six-screen column wants to know.
It names where you are now, and drops the full list on a click, over the panel
rather than in it, so opening it moves nothing.

The briefing is a feed, and a feed is the one thing that has always been allowed
its own scrollbar. It used to sit at full height above Satellites by owner, the
radio search, Jump to and the feed log, so reaching any of those meant scrolling
past every earthquake on Earth.

Layers is left exactly as it was. It is the control surface you scroll on
purpose, not a feed you scroll past.

## The top strip stopped running off the edge

Nine readouts and their gaps measure 1 202 pixels and start 477 in. On a 1100
pixel window **579 pixels of them were outside it** — the eye altitude, the
imagery source and the place under the cursor, gone, with nothing to say they
had ever been there.

Clipping decides what to lose by what happens to be last in the markup, which is
not a decision anybody made. The ambient readouts go first now — the moon, then
space weather, then the detection telemetry — and what survives to the narrowest
window is what you navigate by: the clock, the coordinates under the cursor,
where that is, and how high you are. Checked at 1100, 1400 and 1920 pixels.

Full detail in `CHANGELOG.md`.
