You can pick out whose satellites you are looking at, and the two counting bugs
that turned up while checking it are fixed.

## Download

**GlobalCommandView-1.7.7.zip** below.

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

## Satellites by owner

Asked for a way to see American, Swedish and Russian satellites separately. A
two-line element carries a name and an orbit and nothing else — no country, no
operator — so the layer had no means to answer.

CelesTrak publish ownership in the satellite catalogue, and the active set is
1.5 MB as CSV against 5.6 MB as JSON. The server parses it once a day and hands
the page a lookup table.

**Satellites by owner** in the left panel: ninety-nine owners, commonest first,
with a filter box because the interesting ones are not at the top. Click one or
several. An empty selection means everything, because choosing nothing is what
the panel looks like before you have chosen, and hiding sixteen thousand
satellites at that moment would read as the layer breaking.

Measured 5 September 2026:

| owner | active objects |
|---|---|
| United States | 12 850 |
| China | 1 489 |
| United Kingdom | 698 |
| Russia | 386 |
| **Sweden** | **2** |

16 954 active objects across 99 owners. Sweden's two are `MATS` and `OVZON-3`,
and that figure is why the whole list ships rather than a convenient top ten.

## The satellite layer doubled every time you switched it off and on

Found while checking the filter: Sweden reported four satellites, and Sweden has
two.

The event that loads a layer fires each time it is turned on, and the satellite
loader added to its array without clearing it. Off and on gave **32 064**
objects where there are 16 032, then 48 096 — each duplicate carrying its own
point on the globe and its own orbit propagation every frame. Somebody switching
the layer while filming was quietly halving their own frame rate.

It loads once now, and a load that failed can still be retried.

## A count beside a picture has to count what is in the picture

The owner note first added up CelesTrak's figures and said *13 236 of 16 032
shown* while 12 418 dots were drawn. The catalogue lists 16 954 active objects
and the element set carries 16 032, so several hundred have an owner and no
orbit to fly. It counts the objects on the globe now.

Full detail in `CHANGELOG.md`.
