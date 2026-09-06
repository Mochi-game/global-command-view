The radar layer was asking for a day the satellite was somewhere else, so it
drew nothing at all — and there is now a section in HELP on how to read what it
does draw.

## Download

**GlobalCommandView-1.7.10.zip** below.

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

## Most days there is no pass over where you are looking

The OPERA products hold one day's acquisitions, not a mosaic of the world. The
layer asked for a fixed two days ago — right about the processing lag, wrong
about everything else. **Sentinel-1 revisits a given place about every six
days**, so on most days there is no swath over the place on screen and every
tile answers 404.

Measured over the Öresund bridge across fifteen days: seven had data, eight had
none, and the day the layer asked for by default was one of the eight. Switching
**Radar backscatter** on drew nothing whatsoever. Not an error, not a note — an
empty map, which reads as a broken layer rather than as a satellite that was
elsewhere.

It searches back a day at a time now, up to twelve, and prints the date it
landed on and how old it is:

| | day found | |
|---|---|---|
| Gibraltar | 2026-09-03 | the default day happened to work |
| Öresund bridge | 2026-09-02 | one day further back |
| Stockholm | 2026-08-30 | four days further back |
| mid-Pacific | none | says so, and says why |

The search is cached per region and re-asked only when the middle of the view
crosses into a different tile, so panning about is free and holding still is
free.

## Reading Sentinel-1, written down

A new section in **HELP**, because this is the layer people expect the wrong
thing from.

**What the brightness means.** It is not a photograph — the satellite sends its
own pulse sideways and draws what comes back. Dark is smooth, because a smooth
surface mirrors the pulse away: calm water is nearly black, and so is new
asphalt. Bright is anything with a corner in it — a wall meeting the ground, a
hull, a bridge's girders — so cities glare. Which gives you two useful things: a
**flood** is new black where land used to be grey, at night, through the storm
that caused it, and a **ship** on open water is a white point on black.

**What it cannot do**, with the arithmetic, because the question keeps coming.
One pixel is 30 m across and covers 900 m². A car is about 8 m² — under one per
cent of a single pixel. Sentinel-1's native resolution before this product grids
it is 5 × 20 m, a dozen cars to a cell. No zoom recovers detail that was never
sampled.

And a second reason, which is stranger. **A radar image puts moving things in
the wrong place.** The picture is built from Doppler shift, so a target moving
towards or away from the satellite is drawn displaced along the satellite's
flight path — for a car at 90 km/h on a road lying across the beam, roughly
**two kilometres**. It is why trains appear out in the fields beside their
tracks. Even a vehicle bright enough to see would not be drawn on the bridge it
was crossing.

Seeing individual vehicles needs 25 cm commercial radar, or optical at 30–50 cm,
all of it tasked and paid for. The section says so, rather than leaving somebody
hunting through settings for a resolution that does not exist.

Full detail in `CHANGELOG.md`.
