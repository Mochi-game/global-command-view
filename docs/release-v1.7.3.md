Four things that were switched on and invisible, or switched on and wrong.

## Download

**GlobalCommandView-1.7.3.zip** below.

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

## Your marks were being buried by their own terrain

Reported as not being able to see marks that had been placed, and worst when
zoomed in.

A mark is drawn at ellipsoid height zero — sea level — while terrain depth
testing is on. Anywhere the ground is above sea level, that puts the mark
*inside* the hill it was placed on, and zooming in resolves the terrain to finer
detail and buries it deeper. That is why it got worse the closer you went: more
solid ground stood between the camera and the dot.

Every other marker in the app — airports, ships, aircraft, stations, cameras —
already stops being depth tested within fifty kilometres, so it shows through
the slope in front while the far side of the planet still hides what is behind
you. Marks were the one thing on the globe without it.

Two more things in the same place. **The name stopped being drawn past three
thousand kilometres**, leaving an unlabelled dot at exactly the height you fly
to when you are looking for where you put something. And **eight pixels of
mid-blue with a hairline ring** lost against sea, against rain radar and against
satellite shadow alike; it is twelve pixels in a dark ring now, the same
combination the airport dot needed before it stayed visible.

## STAND HERE armed itself with nothing to click

Reported as no longer being able to get down to Street View — and correctly
self-diagnosed: photoreal 3D was on.

Photoreal 3D hides the Cesium globe and puts Google's renderer over it. Standing
somewhere works by clicking a spot on the globe, which is no longer there. The
button armed anyway: the label changed to CLICK A SPOT ON THE MAP, the click
went to Google's element instead, and nothing happened and nothing was said.

The two cannot both be up, and pressing the button says which one you want. So
photoreal switches off, and the log says why rather than leaving you to work it
out.

## The Google key instructions told you to fence the key off from the app

Asked whether the setup text was any good for somebody who is not technical. It
was not — but the readability was the smaller half.

The app reaches Street View and photoreal 3D through the **Maps JavaScript
API**. Yet step 3 said to restrict the key to *Map Tiles API*, which is the one
Google API the app never calls. Following that step fenced the key away from
everything it was for.

And step 6 told European readers they could not have the 3D half. That blockade
is on Map Tiles — which is precisely why this route was chosen. Both features
run on a Swedish account with Swedish billing.

The rest is legibility. The verdict — *you probably do not need this* — sat in
the same grey text as everything else with six numbered steps under it, and a
numbered list reads as an instruction whatever stands above it. It has its own
block now, the steps fold away behind a summary, and the two facts that actually
decide it (Google wants a card; what you have read about Europe) come before the
steps rather than buried at 1 and 6.

## The line under Street View stopped at the door and never walked

Asked whether a wrong address under a Street View picture could be corrected at
Google. It could not — that card names the panorama, not the building, and
Google label it with the nearest address they hold to where the camera car
stood. But checking the claim found one of ours instead.

Reverse geocoding the coordinates the app printed for a house returned a
building eighty metres up the road. The footer was written once, on arrival, and
never again: the arrows exist to move you to a different panorama, and the line
went on reporting where you first landed.

The capture date was the worse half. A date is a claim about the photograph on
screen, and drives along one road are flown in different months, so carrying it
forward states something false rather than merely stale. It is now shown for the
panorama whose metadata we hold, and simply absent for the ones you walked to.

Position and description are read off the panorama itself, so keeping them
current costs no request — and the line now also carries Google's own name for
the spot, which is the thing people take for the address of the house.

Full detail in `CHANGELOG.md`.
