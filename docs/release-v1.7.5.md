A new layer that shows every name a place carries, and eight fixes — most of
them found by using the thing.

## Download

**GlobalCommandView-1.7.5.zip** below.

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

## What it is called

A new layer under **Reference**. Click any spot and the app asks the map sources
what they call it, then shows every answer with the source attached.

In August 2026 an executive order renamed Lake Ontario to Lake America. Google
and Apple relabelled it for users in the United States. MapQuest refused, and
went to number one in the App Store for it.

Which one is *the* name depends entirely on whose map you are holding — and a
globe that prints one label has quietly taken a side. So this shows the
disagreement rather than settling it, which is the rule every other layer here
follows: the answer arrives attached to whoever said it.

From the middle of that lake it returns **Ontariosjön**, **Ontariosee**,
**Lac Ontario**, **Jezioro Ontario**, **озеро Онтарио**, **オンタリオ湖** and
eighteen more. OpenStreetMap also carries *Ganyadáiyoˀ* in Cayuga and
*ᑭᐦᒋ ᓵᑲᐦᐃᑲᐣ* in Cree. A map with room for one label drops all of them.

It works with no account at all, on OpenStreetMap and Wikidata. **`mapquest`**
is a new optional key that adds a third opinion, from the mapmaker that took a
public position on this.

### Reverse geocoding was the wrong tool, and it took a measurement to find out

The obvious build is a reverse geocoder. From the middle of Lake Ontario,
Nominatim answers **"Central Ontario, Ontario, Canada"** — at zoom 8, 10, 12 and
14 alike. Reverse geocoders find the nearest address, and open water has none.

Overpass `is_in` asks a different question — which mapped areas contain this
point — and answers with the lake, its province, its country, and every name
each of them carries. And because the high seas are inside no mapped area at
all, a second query finds the nearest `place=sea` node, which is what makes the
Gulf of Mexico work.

## Real place names on the globe

Reported with two pictures of New Guinea side by side. Google's photoreal view
named Jayapura, Nabire, Serui, Merauke, Lae, two provinces, two seas and the
country. This globe, on the same island, named **Port Moresby** and stopped.

The labels came from Esri's dark-canvas reference layer — drawn to sit on their
own pale-on-charcoal basemap, so deliberately sparse and low contrast. Over
satellite imagery it disappears. Measured on one tile over Papua at zoom 6:

| | Visible pixels of 65 536 |
|---|---|
| before | **11** |
| now | **3 531** |

Not sparse. Blank. It is the layer Esri publish for overlaying imagery now —
black text with a near-white halo — and it is capped at the zoom where the
service actually stops carrying content, so the names no longer vanish at
exactly the height you fly in to read them.

## The search box said what you typed, not what it found

Reported as a search for Lake Ontario landing somewhere else. It was a
misspelling — *Lake Onatario* — but the app made that impossible to see.

The result was labelled with **the words you typed**, never with the place that
was found. So it flew six hundred kilometres north of the lake under a heading
that read *Lake Onatario*, with nothing suggesting a different match.

The heading is what was actually matched now. And because a geocoder always
answers — a misspelling comes back as somewhere else rather than as nothing —
the longest word typed is checked against it:

> geocoded by OpenStreetMap Nominatim — onatario does not appear in this name,
> so it is a loose match. Check the spelling.

## Also

**Google's 3D view was labelling the world in Swedish.** The Maps loader carried
no language at all, so Google read the browser's. It asks for English now. No
region is set on purpose: Google serves different names for disputed places
depending on it, and choosing one would be this app taking the side it built a
whole layer to avoid taking.

**The daylight switch was named after the wrong thing.** *Sun terminator* is the
phenomenon; a person who cannot see the United States is looking for light. It
is **Night side** now, with a line saying that off lights the whole globe
whatever the local time.

**Small lakes were being missed** because the click was rounded to a
kilometre-wide grid. Three of four named lakes near Varberg returned nothing;
all four return their names now.

**Mark labels stopped printing on top of each other.** Where several marks share
a coordinate the nearest keeps its name and the rest are counted onto it —
`The Don CeSar +2` — rather than three names superimposed into nonsense.

**Red and green on the key badges.** Colour says whether a key is there; the
word beside it says whether it has been seen to work. And the browser can now
vouch for the two keys only it uses, so Cesium ion reads **WORKING** instead of
*the server cannot vouch for it*.

**The self-check stopped blaming sixty feeds for one dead server** — it asks
whether the server is answering before it asks it about the world.

Full detail in `CHANGELOG.md`.
