Rain radar you can play, the weather where you click, and a search that reaches
the fifty-three thousand radio stations the globe cannot draw.

## Download

**GlobalCommandView-1.7.1.zip** below.

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

## Find a radio station

Only **12 411** of Radio Browser's **52 988** working stations carry
coordinates, and a station with no position cannot be drawn on a globe. Four
fifths of the catalogue was unreachable however long you flew around.

The new search box asks the catalogue directly, and asks in five senses at once:
as a station name, a country, a state, a genre tag, and as a place on the map.

Type **Varberg** and nothing is named that — but there is a town there, so it
finds what is on the air near it, nearest first. Type **jazz** and you get the
tag and the names together. Type **Sweden** and you get the country. Every result
says which of the five matched it.

Click one and it plays, and flies you there if it knows where it is. The ones
with no position simply play, which is the point.

## Rain radar

The last two hours of precipitation as thirteen frames, ten minutes apart, from
RainViewer. The strip at the bottom right says which minute is on screen and how
old it is; play stops it, and the step button walks a frame at a time.

It is the past, not a forecast, and every frame carries its own timestamp rather
than the layer implying it is now. Empty is not dry either: coverage follows
where radars exist, dense over Europe, North America and Japan and thin
elsewhere.

## Weather where you click

Switch it on and clicking empty ground answers with the forecast there:
temperature and what it feels like, wind and gusts with the direction, cloud,
humidity, pressure, ground height and five days ahead. Clicking a marker still
opens the marker.

The card is headed by the place — *Varberg, Halland County, Sweden* — rather
than by the coordinates, and says plainly that it is a model's forecast and not a
measurement. Airfield weather (METAR) beside it is the measured one, and the two
will disagree.

## Also

**The performance switch** is on its own above the layer list now, instead of
folded away inside a section it had nothing to do with. The person who needs it
is the one whose globe is already stuttering.

**Adverts** on a foreign station are explained where you meet them. Commercial
internet radio inserts them by the listener's address, so an Ibiza-branded
station registered in Germany plays Swedish adverts in Sweden. Nothing here did
that, and the card now says so.

**Certificates** on machines that could not verify them are fixed at install
rather than explained afterwards, with a bundled fallback for machines Windows
Update cannot reach.

**Windows** no longer treats the folder as untrusted, the server runs with no
window, and the launcher notices when it is being run from inside the ZIP.

**macOS** has an install note in the folder, because *unidentified developer* is
Gatekeeper and not a broken file — and Wine is not needed.

Full detail in `CHANGELOG.md`.
