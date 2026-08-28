# Changelog

The running version is shown in the HUD panel footer and printed by the server on
startup. `GET /api/version` returns it as JSON along with which optional keys are
active. Bump `VERSION` in `server.py` when something here changes.

All of this was built on 2026-08-19, so the entries are in order rather than by date.

## 1.1.0 — taxiways, with the letters a controller speaks

Asked whether taxiways were possible. OurAirports has runways and stops there,
but OpenStreetMap has the whole ground chart, and the app already walks Overpass
for the buildings layer - same mirrors, same circuit breaker.

**Taxiways, taxilanes and aprons**, drawn in the yellow they are actually
painted, because that is what the surface looks like from a cockpit and there is
no reason to invent a different convention for a map of the same ground.

**The letters are the point.** A controller says *taxi via Whisky One, hold
short of Uniform*, and until you can read W1 and U off the map that instruction
is noise. Arlanda has 206 taxiways and OpenStreetMap has labelled 191 of them:
W1, U, W7, X, JV, LY. The labels appear below about 25 km, because a screenful
of them from higher up is a smear and taxiway names mean nothing at that
distance anyway.

Two things this needed that the other layers did not.

The request is refused above roughly one airport's worth of view. A taxiway is a
few hundred metres of paint, and asking OpenStreetMap for a country of them
would time out and deserve to.

And **the layer now says it is waiting.** Overpass walks a list of mirrors with a
fifteen-second timeout each, so a cold fetch can take most of a minute — during
which this drew nothing and said nothing. Found by testing it: I waited fourteen
seconds, saw an empty globe and an empty log, and concluded it was broken. It
was not. Silence that long is indistinguishable from failure, so it announces
the wait now.

The card and the layer note both say the same caveat: this is volunteer-surveyed,
a new taxiway can be missing and a closed one can linger, and it is a map of the
ground rather than a clearance to drive on it.

## 1.0.2 — the app pointing at its own switches

Reported that the flown-track checkbox had gone. It had not: it was in the
Tracks section, which had been folded, and folds are remembered per browser. But
that is twice I have had to explain where that switch lives, which is the
definition of something the app should be saying itself.

Switching a layer on now prints a line about the parts of it that live
somewhere else:

- **Air traffic** points at Flown track, says it is under Tracks in the section
  row, and says that section starts folded — which is the actual obstacle.
- **Vessels** points at Wake the same way.
- **Airports** says to click one for its frequencies and beacons.
- **Runways** repeats that the green line is arithmetic, not a procedure.

The aircraft and vessel hints only appear when the switch is not already doing
its job, so turning a layer off and on again with tracks already drawing says
nothing. Verified both ways: it fires with the section folded, and stays quiet
when the box is ticked.

This is the same problem as the layer counts reading zero when a feed had not
been asked. The app knows something the person in front of it does not, and the
fix is to say it at the moment it matters rather than to document it.

## 1.0.1 — the airport you could not see

Reported straight after the last release: clicking the blue dot at Arlanda gave
the beacon, and the airport carrying the frequencies could not be found at all.
Only a green dot and a blue one were visible.

The airport marker was there and was invisible for two reasons, and the second
one is the interesting one.

It had **no depth-test exemption** while the weather and beacon layers both did.
A marker on the ground therefore vanished behind a terminal building the moment
you descended to look at it — which is precisely when you want it. The other two
drew through and it did not, so at close range the airport was the one thing
missing from its own airfield.

And it was **the faintest of the three**: 0.7 alpha on a 9-pixel dot against
0.85 and 0.9 on the others. Three layers competing on the same ground, and the
one everything else belongs to was drawn quietest.

It is now the largest of them — a 14-pixel amber ring with a solid edge, drawn
through buildings like its neighbours. The other two sit inside it, which is the
right relationship: the weather and the beacon belong to the airport.

The help now says which dot is which, because three layers putting dots on one
airfield is a guess otherwise, and the previous instructions said "click the
airport dot" without ever mentioning its colour.

## 1.0.0 — frequencies and beacons, and saying plainly what is not here

Asked whether the ILS information, VOR channels and frequencies published for
airports could go on the airports. Two of those three, yes, from a file the app
was already half using.

**Frequencies.** OurAirports publish them as a sister file to the airports and
runways: tower, ground, approach, ATIS, clearance delivery, weather office, each
with the code that gets spoken. Clicking an airport now fills in the strip a
pilot would have beside them. Arlanda: tower 118.500, ground 121.700, ATIS
119.000, approach 123.750.

**Beacons.** Eleven thousand navaids worldwide with frequencies and DME
channels, on the airport card for the field they belong to and as a layer of
their own. A VOR is quoted in MHz and an NDB in kHz, the way a chart quotes
them, rather than both in whatever the file happened to store.

**And there is no ILS in any of it.** The dataset carries NDB, VOR, VOR-DME,
VORTAC, TACAN and DME and nothing else: no localiser, no glideslope, no minima,
no approach plate. That is stated on the card, in the help and in the layer note
rather than left to be discovered by somebody looking for it.

What the card does instead is link to the publisher for the country the airport
is in - LFV for Sweden, Avinor for Norway, the FAA for the United States where
the plates are free. Pointing at the authority is honest; copying it is not, and
an invented approach would be worse than no approach.

Found while building it: a multi-line value in a detail card collapsed into one
run-on line, because the values render with normal white space. Six frequencies
arrived as a single unreadable string. Values keep their line breaks now, which
also helps every other card that lists things.

## 0.99.1 — saying where the aviation switches are

The flown track could not be found, and the reason was fair: it lives in the
Tracks section, which starts folded, next to two ship settings. Nothing said so.

The help now has an **Aviation** section that gives the click path rather than
the feature list. It names the fold, because that is the actual obstacle. It
says to zoom in for runways and why — a runway is two kilometres long and the
request is refused for anything wider than a country. And it separates the three
things in that folded section, which are easy to mistake for each other:

- **Course vector** is a pale blue line *ahead* of the aircraft, ten minutes of
  projection. A guess, drawn as one.
- **Flown track** is an amber line *behind* it, through reported positions at
  reported altitude. It guesses nothing.
- **Wake** is the same idea for ships.

Also in it: the METAR colours as the terms they are, why a field with weather is
drawn larger, and that the raw line at the bottom of the card is the authority —
if it and the decoded rows ever disagree, the raw line wins.

## 0.99.0 — aviation: runways, the track that was flown, and the weather pilots read

Asked what could be had in the aviation direction — approach routes, Jeppesen
charts, that sort of thing.

**Jeppesen is closed.** Commercial, licensed per pilot, no open API, and putting
their plates in an app would be a straight licence breach. That is the honest
answer and there is no way around it. But three things next to it are open, and
two of them turned out better than the question assumed.

**Runways.** OurAirports publish them as a sister file to the airports already
used here: both threshold coordinates, length, width, surface, lighting and the
true heading of each direction. Public domain, no key. Drawn as the thing it is,
fetched for the view because there are forty thousand of them.

Each end carries ten nautical miles of extended centreline, computed from the
published heading. The card is explicit about what that is: where a straight-in
would be, not a procedure. Real approaches have step-downs, offsets and turns
that only a chart carries, and the card says *do not fly this*.

**The track that was flown.** A published plate says what should happen; ADS-B
says what did. The app already received every position report and threw them
away. It keeps the last forty now and draws the line through them *at altitude*,
so a descent reads as a descent. Fifteen aircraft queuing for one runway draw the
real pattern, and no licensed chart is involved anywhere.

That one exposed a bug that had been sitting there: the redraw was only ever
called from the vessel poll, so with ships switched off the aircraft trails were
collected faithfully and never drawn once.

**METAR and TAF.** Asked whether an OpenAIP key was needed for this. It is not,
and OpenAIP would not have helped: it carries airspaces and navaids, not
weather. NOAA's Aviation Weather Center serves official observations and
forecasts for the whole planet **with no account at all**. Asking the right
service turned a key into no key.

Fields are coloured by flight category in the colours aviation already uses —
VFR, MVFR, IFR, LIFR are kept as the terms they are, because they mean something
precise about whether you may fly by looking out of the window and "good" and
"bad" would lose it. A field with something falling is drawn larger, because
that is the one you are looking for among fifty that are not. The card decodes
the present-weather codes and keeps them: `+RA — heavy rain` teaches the code
rather than replacing it. The raw line is shown last and labelled as the
authority.

Verified over the Nordics: 51 fields reporting, 11 with weather, EKAH Tirstrup
reading MVFR with heavy rain, its TAF arriving after the card as a second
request. Three ESSA runways with 01L/19R at 10,830 ft and its approach line
landing 9.8 NM out on bearing 010.

## 0.98.0 — two tiles that answer 200 and say nothing

Two reports in a row, and they turned out to be the same bug wearing different
clothes: a tile server that returns a perfectly valid image containing no map.
Nothing in the app can detect that. HTTP says fine, the decoder says fine, and
the globe comes up covered in somebody's branding.

**CARTO started watermarking.** Their tiles still answer 200 with a real PNG,
but the PNG now reads API KEY REQUIRED across it. That hit the default optic —
so a fresh install opened on a globe tiled with the words — and the labels for
**Names & borders**, which is one of only two layers the welcome page suggests
turning on first.

Both now come from Esri's dark canvas, which needs no key and does the same two
jobs: `World_Dark_Gray_Base` for the chart, `World_Dark_Gray_Reference` for the
labels. The trade is licensing rather than looks. CARTO was one of the clean
sources and Esri is not, so commercial-safe mode swaps this out along with the
rest of them — which is machinery that already existed for exactly this, and
which turns OPS into NASA Blue Marble.

**Copernicus watermarks every tile.** Not a no-data placeholder, which is what
it looked like over open ocean: the logo is burned into each 256-pixel square,
over real imagery as much as over empty sea. Verified by fetching one tile over
Gothenburg and looking at it — Sentinel-2 imagery with the logo in the corner.

Which makes it arithmetic. A screen at continental zoom holds about thirty
tiles, so thirty logos and no picture. Zoomed in, one tile covers much of the
screen and it is one mark in a corner, which is what attribution is meant to
look like. So the Copernicus optics are held back below zoom level 8, and say so
rather than drawing nothing in silence. That costs nothing real: a 10 m product
read from orbit height was never showing anything 10 m wide.

**`showLogo=false` removes it.** The rate limit that stopped the first attempt
reopened, one more request went out, and the tile came back clean — same
imagery, no logo. The request carries it now, and the credit line underneath
carries the attribution where attribution belongs.

The zoom gate stays, for two reasons that both survive the logo going away. A
10 m product read from orbit height shows nothing 10 m wide. And every tile is
one request against a monthly allowance of thirty thousand, so a screen filled
at continental zoom spends thirty of them on a blur. Requests are the quota
anyone meets first, and this is the cheapest place not to waste them. The
message says that now instead of talking about logos.

One thing worth knowing that is not a fault: **Sentinel-2 is optical.** The
first clean tile fetched over Skåne farmland is mostly cloud, because Skåne was
under cloud that week. That is what the satellite saw. SWIR and the radar layers
are the ones that see through it.

## 0.97.1 — an address in the DNS box is a question, not a mistake

Reported: put an external IP into Recon and got **400 dns takes a hostname**
back, followed by a fair offer to delete the whole tool if it could not be made
to work.

It worked. It just refused the thing that was asked. Four of the five lookups
take an address and only DNS does not, and the one that was picked answered by
naming what it would not do rather than doing the obvious other thing.

An address typed into a DNS box is not an error to reject, it is a different
question: **what is this called?** So it does a reverse lookup now. The reported
address comes back as `78-69-116-2-no600.tbcn.telia.com`, and the answer says
which of the two questions was asked so the direction is never ambiguous.

Fixing the server exposed the same fault on the client: the summary filtered DNS
answers to `type === 1`, which is an A record. A PTR is type 12, so the reverse
answer would have been dropped and shown as *no A record* — technically true,
and hiding the answer sitting right there. Both types are read now.

The other error messages name the lookup that *would* have worked instead of
only the one that did not. A hostname in the RDAP box now says to resolve it
first and look the address up, rather than "that is not a public IP address".
The dropdown reads **DNS → name to address, or back**, and the field suggests
both shapes.

Nothing was deleted. It was a good tool with a bad answer.

## 0.97.0 — every optic says what it is

Nineteen buttons reading FIRE IR, SWIR, NDVI, BATHYMETRIC, ATMOS PENETRATION,
and nothing anywhere saying what any of them shows. A nine-character label is
not an explanation, and half of these are not what they sound like.

Each optic now carries a sentence on what you see and a sentence on when it is
the right one. Hovering a button shows it; picking one prints it under the row.
The Copernicus visualisations are described too, keyed on the layer id, so they
explain themselves even though which of them exist is decided in somebody else's
dashboard rather than here.

The help section was rewritten around the distinction that actually matters, and
it is not the one the old list implied. Some of these are **measurements** and
some are only **a look**:

- FIRE IR, SMOKE, SENTINEL 10M, SATELLITE and the Copernicus set are sensed.
  Something was measured and this is what it measured.
- THERMAL, NIGHT VIS, FLIR and CRT are daylight imagery recoloured. **THERMAL
  and FLIR contain nothing warm, and NIGHT VIS contains nothing dark.** They are
  here because footage sometimes wants that look, and nothing in them can be
  measured.

Both are useful and they are not interchangeable, so they are listed apart
instead of together. The old section had them in one list with "sensor
emulations" as the only hint, which is exactly the sort of phrase that reads as
a feature rather than a warning.

## 0.96.2 — a welcome page that overclaimed on its first line

The welcome page written yesterday said **Public cameras** gives you four
thousand of them straight away. Asked whether that only holds with an account,
and it does. Counted:

    Trafikverket             1 525    needs a key
    Windy                      986    needs a key
    Digitraffic                811    no key
    Transport for London       804    no key

With no account at all it is **1 615**, not four thousand — the claim was out by
more than half, on the first thing a new arrival reads, in the app whose whole
argument is that it does not say more than it can support. Worse than a wrong
number: a promise that fails the moment somebody acts on it.

It now says about sixteen hundred with no account, names which two feeds those
are, and says four thousand comes once the free Trafikverket and Windy keys are
in. The same claim was repeated three times on the HTML page and is qualified
there too.

The screenshot captions that read "4 143 public cameras" are left alone. A
caption describing what a particular screenshot showed is true about that
screenshot, and the picture was taken with the keys in.

## 0.96.1 — a switch that protects somebody who is not you

Asked to put a screenshot of the train card on GitHub. Two of the marks were in
frame with their names on: a flying club and a person. One of them is a home.

That would have put a private address on a public repository — permanent,
searchable, and copied by everyone who forks it. But the screenshot was the
small half of the problem. This app is used to film a YouTube channel, and
marks are drawn on the globe with their names at a readable size, always. Every
video published from it would have carried the author's private addresses,
labelled, and nobody would have noticed until it had happened a dozen times.

**Hide my marks on the globe**, under Marks. The list in the panel stays; only
the globe stops showing them. Remembered across reloads, so it stays on once
switched on, and the feed log says *safe to record* when it does.

The help has a section called *Before you record anything* that says what this
is for in plain words, and says the part worth saying out loud: this is the one
setting in the app that protects somebody who is not you. A published video
carries every label in frame to everyone who watches, and a home address does
not stop being one because it was only on screen for a second.

Verified: toggling hides the points and the labels while all eight marks stay in
the list, the setting survives a reload, and it is re-applied whenever the marks
are redrawn.

## 0.96.0 — the globe opens empty, and says why

Asked for a first run that starts with nothing on and welcomes people properly.
Both halves of that were fair.

**Nothing is on now.** Names and borders and the public cameras used to be
switched on at boot, which meant the first thing anyone saw was four thousand
camera markers over a world they had not asked about yet. The globe opens empty
and the first thing you turn on is the first thing you see. Layer choices were
never saved between visits, so this is simply the new default for everybody.

**And first run used to open the entire guide** after two and a half seconds:
a manual in the face of somebody who has not yet seen the thing it documents.

A welcome page instead. What this is in two sentences, then three things to try
— turn a layer on, use the Jump to box, click what you find — and a note that it
all runs locally and needs no account. Two ways out: **SHOW ME AROUND**, which
hands over to the guide, or **START LOOKING**, which gets out of the way.

There is a **Do not show this again** box, and next to it a line saying where the
door back in is: **WELCOME** in the top bar, which works whichever way the box is
ticked. A checkbox that hides something permanently without a way back is a trap
rather than a preference, and the page says so on itself rather than leaving it
to be discovered.

Verified through every path: first visit shows it with zero layers on and the
guide shut; SHOW ME AROUND closes it and opens the guide; the top-bar button
reopens it; ticking the box and closing saves; a reload after that draws the
globe with no welcome and no layers; and the button still opens it, with the box
remembered as ticked.

The help text that said everything starts off "except names and borders and the
public cameras" now says everything starts off, and names the two rows to click
if you want the old opening picture back.

## 0.95.0 — saying where the idea came from

The idea came from Bilawal Sidhu's gods-eye-view, seen on YouTube. That is now
in the README and in the app's WHAT THIS IS tab, because silence is what looks
like copying if somebody puts it together, and saying it plainly removes the
question.

Measured before writing it, rather than asserted. 944 kB of his code against
664 kB of this one: 28 identical ten-word sequences out of roughly 101 000 and
85 000, and every one of them is either the standard HTML head or the single
line Cesium gives you for turning a position into degrees. There is no other way
to write that line. No shared prose, no shared naming, no shared structure. His
is a Vite and npm application in JavaScript; this is one Python file with no
dependencies serving plain JavaScript. Same idea, built independently from the
other end.

The wording points at his project as the more finished one and lists what is
different here rather than claiming to be better. A README that argues it beats
another project is weaker than one that says what it does instead, and the
difference is real enough to stand on its own: nothing to install past Python,
Swedish road and rail and weather, and an editorial rule taken further than is
comfortable.

Also in this release: LICENSE is plain MIT again so it is recognised as MIT — the
note about third-party data that used to sit under a rule at the bottom of it now
lives in DATA-LICENCES.md, because an appended paragraph is exactly what stops a
licence detector matching the file. The repository has topics and a description
that says what it does. And the README still claimed thirty-four layers; it is
thirty-seven.

## 0.94.1 — two GET THE KEY buttons that led to a 404

Handed the working OpenAQ registration link, because the one in the app was
dead. Checking the other nine found a second: the Trafikverket API root, which
had been the right address when it was written and stopped answering at some
point since.

Both had been correct once. That is the whole problem with a link in an app —
it looks exactly as alive as a working one until somebody clicks it, and the
person clicking it is somebody deciding whether this is worth the trouble of an
account. The same thing cost real time here once already with a TomTom address.

- OpenAQ: `openaq.org/developers` → `explore.openaq.org/register`
- Trafikverket: `api.trafikinfo.trafikverket.se` →
  `data.trafikverket.se/oauth2/Account/register`
- Windy, which was not broken, now points at the key page rather than at the
  pricing page it was redirecting to.

The Trafikverket one landed on the site root first, which answers 200 and has no
title — a page, not the form. Checking what each link actually *lands on* rather
than whether it answers found that: the registration form is one level down, and
that is where it points now. Answering and being useful are not the same test,
and the smoke check only performs the first one.

**TomTom got the treatment it deserved two months ago.** Its steps said
"register and create a key", which is true and useless: the key is not on the
developer site where that implies. It is under MyTomTom, in **API & SDK Keys**,
behind the `…` menu on the row. The `developer.tomtom.com/user/me/apps` address
answers 200 and renders empty, which is exactly the dead end that cost real time
here. The card now says all of that, including which address not to bother
with.

Both cards say in their steps that the old address is dead, so anyone following
an older screenshot is not left wondering.

And this is now tested rather than trusted. The smoke test fetches every GET THE
KEY link and names the ones that do not answer. It is a network check, so it is
skipped by `--quick` along with the slow feeds. Verified by planting a dead link
and watching it fail, then restoring it.

## 0.94.0 — a setup page that says what to do first, and a badge that stops lying

Shown another app's onboarding as the standard to meet, and it was. Two things
it does that this did not, and the second one was a fault rather than a gap.

**Eleven keys in one undifferentiated column told nobody where to start.** Every
card looked as important as every other, the order was the order they happened
to be written in, and the only one that can charge money sat between two that
cannot.

There is now a summary that answers the question people actually arrive with —
**needed: nothing** — and then four tiers, numbered: the two worth doing first,
the ones that each add a layer, the narrow ones, and the one Google bills for
past a free allowance. The bare URL at the bottom of each card is a button.

**And SETUP said IN USE the moment a key was saved.** That is a claim about a
text field, not about the key. A key can be saved and wrong, saved and expired,
or saved and refused by a referrer rule, and all three read as IN USE. In an app
whose entire discipline is not stating more than it can support, that was the
worst-supported sentence in it.

The server now records when a call using a key actually came back with
something, at twelve points across the feeds that use one. Three states:

- **NOT SET** — no key.
- **SAVED** — a key is there and nothing has used it yet, with a line saying to
  switch on a layer that needs it.
- **WORKING** — a call using it succeeded, and when.

Cesium ion and Google Maps are used by the browser rather than by the server, so
the server has nothing to report about them and says exactly that instead of
guessing. Verified live: Trafikverket, Windy and Copernicus read WORKING with
timestamps; OpenSky, aisstream and TomTom read SAVED; OpenAQ and Global Fishing
Watch read NOT SET.

Also a **Handling the keys** block, and the setup tab now reads at a size meant
for reading rather than for glancing at. One of its five lines is there because
of something that happened in this very project: do not paste an API key into a
chat, an email or a screenshot. Most of these keys spend a quota rather than
money, which is what makes that kind of theft quiet.

## 0.93.1 — the documentation catching up with the app

Asked whether help, the README and the HTML page were up to date. Help was.
The other two were not, and checking rather than answering from memory found
three gaps.

The **HTML page** was the worst of it: still claiming thirty-four layers when
there are thirty-seven, with no Sweden group at all, no Copernicus in the key
table, and no mention of either the search box or performance mode. It listed
Trafikverket as a camera source, which had stopped being the whole truth two
releases ago. All of that is in now, including a Sweden group written the same
way as the others - what the layer is, and what kind of truth it is.

The **README** was missing performance mode entirely, and said nothing about
clicking a train to get its journey.

One thing worth recording about how this was checked: searching the HTML page
for "SMHI" found a hit, and there was no SMHI on the page. The match was inside
base64 image data. Stripping the data URIs before searching is the only way to
get an honest answer out of that file, which is the second time that particular
trap has cost a wrong conclusion here.

## 0.93.0 — a train number that says where it is going

Reported after clicking a train: I can see 1127, but I have no idea it runs
Gothenburg to Copenhagen, or whether it is late. Both are published. The
position layer answers where; a different object type answers what the journey
is and how it is going.

Clicking a train now looks the journey up. Route, the station it last passed
with the real time against the timetabled one, the next station with its
estimate, how many of its stops are done, and whether any of it is cancelled.
Train 1127 turns out to be Gothenburg C to Copenhagen H, and was running two
minutes late while this was being written.

Asked per train, on click. Fetching a journey for all four hundred dots on
screen would spend the quota on questions nobody asked. The card draws
immediately with what the position gave and fills the journey in when it
arrives, because a card that waits in silence looks broken.

Three schema hunts again, and the third was the awkward one: TrainAnnouncement
is 1.9 with no namespace, but the station names are TrainStation in
rail.infrastructure - not in the rail namespace the trains themselves live in,
and not without one. Without it G and Dk.kh stay G and Dk.kh, which is no use to
anyone. 1 750 names, cached for a day.

Two smaller things from the same screenshot.

**"Reported: -1 s ago"** on a train card, which is not a thing that can happen.
A clock a second or two out of step with Trafikverket produced a negative age.
Clamped, because the honest answer to a negative age is zero.

**The weather link did not work.** It pointed at api.weather.gov, which answers
200 with `application/geo+json` - so clicking it got a wall of braces rather
than a weather page. There is no human page in the NWS API to point at instead,
but the warning text was in the response all along and was being thrown away.
The card now carries the words: what the warning says and what to do about it.
The link stays, labelled Record (JSON), which is what it is.

That text arrives as a teleprinter product - a short all-caps identifier, then
paragraphs hard-wrapped at seventy characters - and the card renders with normal
white space, so it collapsed into one block starting with FFWPHI. The wrapping
is now undone rather than fought: identifier dropped, wrapped lines rejoined,
paragraphs separated by a middle dot that survives the collapse.

## 0.92.1 — a box that was not a box, and a clock that would not say which

Two reports from the same screenshot of the feed log.

**Traffic jams flickering.** The log alternated between counting incidents and
saying the layer was unavailable with HTTP 400. Both were true. A view rectangle
that wraps the globe comes back with west greater than east, and the width test
was `east - west > 6.0` — which for a wrapped box is a negative number, never
greater than six, so it passed. TomTom then answered 400 for a bbox that runs
backwards, and the log reported the layer as unavailable when what had actually
happened was that the app asked an impossible question.

A box is now checked for being a box before anything is asked of it:
non-finite values are refused with a plain reason, and a wrapped or inverted
rectangle is refused as too wide, which is the message that was always meant for
it. Verified against the five cases that used to fail.

**The log would not say what time it was.** Its timestamps were UTC, unlabelled.
The HUD clock beside them has always printed a Z. So a reader on CEST saw
15:26 in the log against a wall clock reading 17:26 and concluded the app had
been frozen for two hours — which is what was reported, and a reasonable thing
to conclude. The log now prints the Z as well. One character, and the two clocks
on screen now agree about what they are measuring.

## 0.92.0 — Sweden, off a key that was already here

The inventory found that Trafikverket's key had been doing exactly one job since
it was added: road cameras. The same key and the same endpoint answer for road
disruption and for where every train in the country is. Neither was being asked
for. SMHI publish warnings with no key at all, and the weather layer had been
saying "United States only" in its own note the whole time.

A **Sweden** group now sits at the bottom of the layer list.

**Swedish road disruption** — roadworks, traffic notices and ferry information
across the state road network, about 1 200 at a time, coloured by Trafikverket's
own severity from grey through to red for *mycket stor påverkan*. Refreshed
every three minutes. The wording is left in Swedish: that is what Trafikverket
publish and what the sign says, and translating it and back is a chance to be
wrong about something nobody needed changed.

**Swedish trains** — where trains report themselves, every thirty seconds. A
position, not a timetable: nothing here says whether a train is late.
Trafikverket keep a position after a train has finished with it, so anything
older than fifteen minutes is dropped rather than drawn standing still, and how
many were dropped is printed. Typically about a hundred of four hundred and
fifty.

**SMHI warnings** — drawn as the areas they are. A wind warning covers a
coastline, not a spot on it, so there is no pin and the middle of the shape is
not more warned than the edge. Yellow, orange and red are SMHI's scale, kept
unchanged; Meddelande is below yellow, is information rather than warning, and
is drawn faint. CC BY 4.0, no account.

None of the three schema versions were guessable and none were guessed. Situation
is 1.6 and lives in the road.trafficinfo namespace, where it does not exist
outside it and returns "ObjectType 'Situation' does not exists" for every version
tried without it. TrainPosition is 1.1 in the Swedish-spelled namespace. Both
were found by probing the live API for its own error messages before any of this
was written, and the SMHI shape was read from a live response rather than from
documentation.

Verified end to end: 1 241 disruptions, 349 trains and 20 warning areas drawn on
the globe, all three detail cards rendering, no console errors, and the two roads
with no single point reported in the feed log rather than dropped in silence.

## 0.91.5 — two missing sources, and a badge that could only say two things

Noticed that Copernicus was not in SOURCES & LICENCES. It was not, and neither
was Google Maps Platform - photorealistic 3D and Street View, listed nowhere,
while "Google DNS" for registry lookups was. Both are there now, 49 rows.

Adding Google exposed the real problem. The badge was a binary: ANY USE, or
NON-COMM. Google is neither. Their terms permit commercial use and bill for it
beyond a monthly allowance, which is a different answer from "you may not sell
this" - and it is the wrong warning to give somebody deciding what may go into
a monetised video. There is now a third state, PAID USE.

Widening it broke seven rows. Values the old code handled - `free key`,
`free token`, `non-commercial` - were absent from the new map and fell through
to a fallback, so NON-COMM silently became CHECK IT on four sources whose terms
had not changed, and three free-with-a-key sources lost their ANY USE. Found by
reading the rendered rows rather than the diff, which would not have shown it.

A licence badge that drifts is worse than no badge, because somebody reads it
before deciding what they may sell. So this is now tested: every licence value
in SOURCE_LICENCES must have a BADGE entry, and the smoke test names the ones
that do not. It caught a hyphen bug in its own pattern on the first run, which
is the right kind of first result.

Fifth time in this codebase a second copy of a list has drifted from the first.
Two of those classes are now under test.

## 0.91.4 — it runs on a Mac, and now it starts like one

Asked whether this can be installed on a Mac. The server always could: it is
plain Python, `webbrowser.open` rather than `os.startfile`, `os.path.join`
throughout, no registry, no drive letters. Only the launchers were Windows -
two `.cmd` files and a `.ps1` - so a Mac user had a terminal command where
everyone else had a double-click.

There is now a `.command` launcher, which macOS opens in Terminal when
double-clicked and which works on Linux as a shell script. It does what the
Windows one does: finds a Python new enough, runs the server from its own
folder, and explains itself if Python is missing instead of vanishing. On macOS
the advice it gives is `xcode-select --install`, which is the shortest route to
python3 there.

Two things that would have broken it, both caught before anyone met them:

The executable bit does not survive every zip download, and a `.command` file
without it does nothing when double-clicked. It is set in the repository, and
the README says to run `chmod +x` once if a download loses it.

More seriously, git was going to hand out that file with Windows line endings,
because it is written on Windows and nothing said otherwise. A shell script with
CRLF does not run at all - the interpreter reads the trailing carriage return as
part of its own path and reports `bad interpreter: /bin/sh^M`. Every Mac user
would have hit that. There is now a `.gitattributes` pinning `.command`, `.sh`
and `.py` to LF and the Windows launchers to CRLF, since that is the same
failure in the other direction, and the stored blob was checked rather than
assumed.

Untested on real hardware: I have no Mac. The shell syntax is checked, the
Python detection is exercised, and the line endings and file mode are verified
in the repository - but nobody has double-clicked it on macOS yet.

## 0.91.3 — how to move it, and a check for the drift that keeps happening

Asked for the move-to-another-machine instructions to be written down where
people will find them, rather than said once in a conversation. They are now in
the About tab and in the README.

Everything personal lives in four files in the app folder: `keys.json`, and the
marks, manual events and spend counters under `data/`. No `.env`, no profile,
no account. Copying `keys.json` alone is enough to be running again. Keys
restricted by referrer need no change, because the restriction is to
`127.0.0.1:8820` and that is localhost wherever it runs.

The catch that is written down with it: `usage.json` counts locally but a Google
quota belongs to the project, so two machines sharing one key each count only
their own calls and both bars read low. The console is the authority. The spend
panel already said so; now the moving instructions do too.

Writing that turned up the README key table missing `copernicus` entirely - a
key accepted by the server for a whole release with nothing telling anyone how
to get one. That is the fourth time in this codebase that a second copy of a
list has drifted from the first, after the keys endpoint keeping its own
hardcoded names, two layers landing in no group, and the help text falling
behind.

So the drift is now tested rather than trusted. Every key in `ALLOWED_KEYS` must
have a README row and a Setup field, and the smoke test says which is missing.
Verified by removing the copernicus row and watching it fail, then putting it
back and watching it pass.

## 0.91.2 — fourteen unasked questions that looked like fourteen empty feeds

Reported as a feeling rather than a fault: it sometimes seems like something is
missing from the layer panel. Nothing was. All 34 layers render, in 8 groups
that sum to 34, with no orphans - checked rather than eyeballed.

The fault was in what the numbers said. A switched-off layer showed 0, and in
this app a 0 means something specific and load-bearing: the feed answered, and
there was nothing there. An off layer has not asked anyone anything. So most of
the panel was reporting empty feeds when it should have been reporting silence,
which is the exact misreading the layer list exists to prevent - and it was
doing it fourteen rows at a time.

An off layer now reads as a dot, the same as an imagery overlay that has no
count to give. A zero from here on means what it has always been supposed to
mean.

## 0.91.1 — the Copernicus layer, run for the first time

Written blind in 0.91.0 and now run against a real instance, which is the only
way some of this could have been found.

**The tile matrix set was wrong.** The code took the first web mercator set the
instance offered. A real instance offers `PopularWebMercator512` first and
`PopularWebMercator256` second, and the 512 set numbers its tiles differently at
the same zoom - feeding it the row and column Cesium computes returns 400. Now
256 is asked for by name. It costs four times the requests for the same ground,
and requests are the quota anyone meets first, but a working layer beats a cheap
broken one.

**The labels were cut mid-word.** A chip is about eighteen characters and the
titles are longer: COLOR INFRARED (VE, NATURAL COLOR (TRU, VEGETATION INDEX -.
That reads as a bug rather than as a name. Parentheticals are dropped, since
they qualify rather than name; a title carrying its own abbreviation after a
dash uses the abbreviation, so "Vegetation Index - NDVI" is NDVI; and what is
still too long is cut on a word boundary.

**The quota figure was wrong.** Written as 10,000 processing units from a search
result, corrected against a dashboard to 30,000 processing units and 30,000
requests for a General user account. Requests is the limit anyone meets first.

**The Setup card now describes the real path**, which matters because the
obvious route is the wrong one: registering leaves you in an account console
that handles logins and OAuth clients and holds nothing you need. The Sentinel
Hub dashboard is a separate application, and Configuration Utility is inside
that.

Verified end to end bar one link: the instance answered with ten visualisations,
all ten became styles with readable names, and the URL the app builds returns a
real 256 by 256 JPEG over Gothenburg. What could not be checked here is Cesium
painting it, since this browser pane does not render while hidden.

## 0.91.0 — a switch for hardware that is not this one

Asked how this behaves for people who are not running it on a strong desktop.
Worth measuring rather than guessing, so: the per-frame loop costs 0.123 ms for
11,640 objects, about 0.7 percent of a 60 Hz budget. It is not the bottleneck,
and it culls to the view and skips layers that are off before doing any work.
Terrain and buildings turn out to be gated behind a Cesium ion key, so a first
run without one is already light. One thing I had assumed was wrong and is
corrected here: useBrowserRecommendedResolution is true by default, so Cesium
already renders at CSS pixels and a high-DPI screen was never paying four times.

What was real: the globe redraws continuously, sixty times a second, whether or
not anything has changed - and with the layers this app starts with, nothing on
screen is moving at all. On a laptop that is a loud fan and a flat battery
spent repainting a stationary picture.

**Performance mode**, under Broadcast. The saving is not lower quality, it is
not drawing what has not changed. Cesium already asks for a frame when the
camera moves or a tile lands; what it cannot know about is our own animation,
so anything that moves under its own steam pumps the renderer at twenty a
second instead of sixty. Fog, atmosphere and 3D buildings come off and terrain
is asked for at roughly half the detail. Nothing in it changes what the data
says.

The app also times its own frames now - the real gap between them, not the cost
of one function inside them - and if it is drawing below about thirty a second
once the tiles have settled it says so once and points at the switch. Once. A
hint that repeats is nagging.

**Dated Sentinel-2, at 10 m**, from a Copernicus instance. The Sentinel layer
already here is the EOX cloudless mosaic: a year of passes averaged into a
basemap with no clouds, no smoke, no ships and no flood in it. Sharp, and
undated. NASA's daily imagery is dated and 375 m, where a sediment plume is a
brown smudge. Nothing here was both. This is.

Which visualisations exist is not decided in this repo. A Copernicus
configuration holds whatever its owner set up, so the server asks the instance
what it offers and builds one style button per answer. Guessing at layer names
would produce buttons that fetch nothing, which is worse than no button. Needs
a free account; the Setup tab carries the steps and the two limits worth
knowing - a General user account shows 30,000 processing units and 30,000
requests a month, neither rolling over, and a five-day revisit that is why the
request asks for a ten-day window rather than a date.

The quota figure here was first written as 10,000 from a search result, and
corrected against a real dashboard. Requests, not processing units, is likely
the limit anyone meets first: every map tile is one request, and a screenful of
globe is twenty or thirty.

## 0.90.2 — two feeds checked without being able to run them

The air quality and fishing layers have never run against a live API, because
they need accounts nobody here has yet. That is not a reason to leave them
unchecked, only a reason to check what can be checked.

Both endpoints were probed with a well-formed but invalid key. That separates
the two failures worth telling apart: OpenAQ answers `Invalid credentials` for a
path that exists and `Not Found` for one that does not. The path is right, and
so is the rest - PM2.5 really is parameter id 2, coordinates really are written
latitude first, and the radius really does cap at 25 km, which is what the code
already clamps to. Every field the reader touches is in the published schema,
including that latitude and longitude may be null, which it already skips.

Global Fishing Watch confirmed the body fields and all three dataset names. The
one thing that could not be confirmed is which key the list of events arrives
under. The code guesses `entries`, then `data`.

So both now say when they cannot read an answer. A feed that replies in an
unfamiliar shape used to produce an empty list, and an empty list is a claim:
no fishing here, clean air here. It is not the same as "I could not tell", and
the difference is the whole point of the layer.

Found while testing that: the guard meant for air quality landed in the launch
feed instead, because both parsed a list called `results` and the first match
won. It would have reported a launch failure as an air quality one. Third time
a second copy of something has drifted from the first in this codebase.

## 0.90.1 — moving the camera nobody could see

Reported an hour after the search box shipped: put in a coordinate, and now
Jump to does nothing either. Neither globe nor palm.

Both worked. The screen did not, because photoreal 3D was on.

While it is, Cesium's globe is hidden behind Google's element. The search box and
every Jump to preset move the Cesium camera, and with the globe hidden that is a
camera nobody can see: the app flies somewhere, says so in the feed, and the
screen sits still. Which reads exactly as "the buttons stopped working".

Anything that moves the camera now hands the new position over to the 3D view
when it finishes. Verified with photoreal on: search 67.8548, 20.5236 and the
Google view lands on Kiruna at 67.886, 20.524, tilt 30 degrees — ninety minus the
sixty of pitch the search flies with.

Then the same question asked of everything else, because one call site being
wrong is rarely one call site being wrong. A first sweep found twelve places that
move the camera. The pattern used to find them had a fault - it looked for
`lookAt(` followed by another bracket, which matches nothing - and a second sweep
with that corrected found eighteen. The six it had been hiding included following
a contact, which is the one that moves the camera most.

Fifteen of the eighteen hand the position over. Three deliberately do not:

- Turning photoreal on and off is the mechanism itself.
- The moon is not somewhere Google's 3D view can go. It is a view of the Earth.
- Following a contact moves the camera every frame, and the 3D element has no
  smooth way to be told that often. It would judder rather than track.

The last two switch photoreal off and say so in the feed, rather than leave a
button that appears to do nothing. A view that changes under you is bad; a view
that changes under you without saying why is worse.

Also: airport codes are now indexed properly. `_load_airports` built the code
index but did not declare it global, so it was filled in and thrown away, and
every code fell through to the geocoder. ESSA came back as somewhere in France.
The index now covers all 81,184 codes, and ESGV is Varberg Getteron Airfield at
57.1251, 12.2292 rather than whatever Nominatim made of four letters.

Worth naming the shape of it. The bug was not in the search or in the presets. It
was in an assumption both of them inherited from before there were two renderers:
that moving the camera is the same as changing the view. It has not been true
since photoreal went in, and everything written since has quietly assumed it.

## 0.90.0 — a box that takes you anywhere

Asked for: type a coordinate the way a flight simulator writes it, or a town, or
an airport code, and go there. All three now work from one box under Jump to.

**Coordinates are read here, not looked up.** A kneeboard gives degrees and
decimal minutes, a chart gives degrees, minutes and seconds, a map application
gives decimal degrees — and all three turn up in either order, with the
hemisphere letter before or after, and with any combination of the degree and
minute marks or none. Rather than a pattern per format, the parser reads the
hemisphere letters and then the runs of digits, and lets the count decide: one
number is degrees, two is degrees and minutes, three is degrees, minutes and
seconds. Eleven cases tested, including the ones that must *not* parse —
"Varberg" has no digits, but "Hangar 3 West" would otherwise read as a longitude.

**Codes are instant and local.** ESSA, LAX, ESGG resolve from the airport list
already in memory without a network call.

**Names go to the geocoder before the airport list, and that ordering was
earned.** Matching airport names first sent "Stockholm" to Skavsta — a minor
field a hundred kilometres from the city, because its name happens to contain the
word. Somebody typing a town wants the town. The airport list is still tried
afterwards, because it carries names no gazetteer has.

The box prints what it decided your query was. A coordinate read here and a name
looked up in somebody else's gazetteer are different kinds of answer, and this is
not an app that hides which one you got.

## 0.89.2 — the oldest layers said the least

Went through the help tabs and the layer notes against what the app actually does
now, rather than against what it did when they were written.

The tabs held up: five of them, each rendering, ten key fields in SETUP with
nothing missing, and every layer carrying a note. But six layers had notes that
were only a source name — `OpenSky`, `Digitraffic`, `USGS`. They are the six
oldest and, awkwardly, the six most used: aircraft, police air, ships, cameras,
satellites, earthquakes. They predate the convention the rest of the app follows,
which is source *and* what the thing is *and* where its limit lies.

They say something now. Aircraft note that a transponder that is not broadcasting
is not on the map. Cameras note that a frame is a still and not a stream.
Satellites note that most of sixteen thousand objects are debris.

**And the radio layer explains its own geography.** Asked why there was radio in
Florida and nowhere else: because the layer fetches around wherever the camera is,
which the log did not say. The count now reads *"95 stations within 300 km of this
view · move the camera to load elsewhere"*. It is the first question anybody has
about that layer and it should not have needed asking.

## 0.89.1 — the radar was smearing the map

Sent a screenshot of the radar layer switched on over Europe: long diagonal
grey and magenta bands across everything from Scotland to Kazakhstan. That is
real data — each band is one Sentinel-1 pass — but at eighteen hundred kilometres
up you are reading *where the satellite flew*, not what it measured, and it looks
like damage to the map rather than information on it.

These are thirty-metre products. They hold their fire now until the camera is
inside about a country, and say so when switched on from further out, because a
layer that draws nothing and says nothing reads as broken in the other direction.

**Jump to gained Stockholm and Gothenburg.** Both were being flown to by hand
every time anything needed checking, which is a good sign a preset is missing,
and both sit at a height where the ground-change layers actually draw.

## 0.89.0 — the old name is out of the code

Spotted in the README on GitHub: `window.godsEye`. Not just a line of prose —
that is the actual global the app exposes, and it carried a name this project
dropped long ago. Six places in the code, and thirteen stored settings whose keys
all began `gev`, from the same name.

The global is `window.gcv` now. The settings were the careful half: renaming a
storage key is two characters and would have **silently thrown away whatever
anybody had set** — safe mode, their marks, a calibrated camera, which sections
they keep folded. The old names are carried across once at startup and then
removed, so nobody notices anything happened.

Testing that found the bug in it. The migration sat next to the layer groups, and
`safeMode` reads its key a hundred lines earlier — so commercial-safe mode, and
only that, came back off for anybody who had it on. It runs before the first read
now. Verified by planting `gev-safe=1` and reloading: the setting survives and
the switch comes up ticked.

## 0.88.2 — for somebody who has never installed Python

Asked whether a stranger downloading the ZIP gets a decent explanation, given
some of them will never have had Python on the machine. They did not.

Double-clicking the start script without Python did one of two unhelpful things:
printed `'python' is not recognized`, or opened the Microsoft Store, and then
closed itself after three seconds. Either way the reader learns nothing and has
no time to read it.

Both scripts now look for Python before doing anything, trying the `py` launcher
first — plain `python` on a machine without Python is a Windows App Execution
Alias that opens the Store, which looks like the script did something bewildering
rather than nothing. If nothing suitable is found they print where to get it, and
**pause**, so the window stays until it is read.

The message spends most of its words on one checkbox: *Add python.exe to PATH*,
at the bottom of the first installer screen, off by default, and the single
reason a correctly installed Python is invisible to Windows. It also answers the
follow-up — "I already installed it" — with the same cause.

The README leads with the double-click path for somebody who has never done this,
and says plainly that no Python needs to be known: nothing here is edited or
compiled, the file is run the way an application is.

## 0.88.1 — where LiveATC actually works

Reported from use: the tower link plays in the United States and finds nothing in
Europe. That is true, and it is not a fault in the link. Most of Europe restricts
rebroadcasting air traffic control, so European airports usually have no feed
however large they are, while American ones have several.

The layer note said "click through to LiveATC for the tower" and left you to
discover the rest by clicking. It now says the coverage is mostly North America,
and the card says why: it is the law where the airport is.

This is the same qualification the weather layer has carried since it was built.
An unqualified link that quietly works in one hemisphere is the kind of thing this
app is supposed to catch.

## 0.88.0 — the going-live check

A full pass over everything, because the next step is a live stream and a fault
found on air is a fault found by the audience. Four things came out of it.

**GDELT was being hammered while refusing.** News attention returns 429 at the
moment, which is fair — but the failure was not cached, so every call asked
again, which is the one behaviour guaranteed to keep the door shut. A refusal is
now believed for ten minutes, the last good answer is kept on disk for six hours
and served in its place with its age attached, and the layer says it is stale
rather than saying nothing.

**Thirty seconds to say nothing.** `head_of_state` with no country still ran the
Wikidata query and waited out its full timeout. It returns immediately now. The
smoke test was calling it that way, which is how this surfaced.

**Two ships were not being drawn** — CVN-70 and LHD-8, both "In the California
Operating Area", a name the gazetteer did not have. The app said so in the feed
rather than dropping them silently, which is the design working; twenty more area
names are in, and `unplaced` is empty again.

**Everything else measured, with all 34 layers lit at once.** Twenty-four
returned data, four are imagery overlays that print a dot rather than a count,
and the six empty ones were each checked rather than assumed: no thermal
detections over Sweden in August (384 over California, so the layer is fine),
APRS connected with nothing in view, Overpass timing out and saying it will
retry, and three waiting on keys nobody has fetched yet.

Frame time in steady state: **1.8 ms median for a realistic streaming set of six
layers, 5.5 ms with all thirty-four**, worst frame 22 ms and 148 ms respectively.
The satellites are the cost, as they should be at 16 057 objects. No console
errors. Photoreal 3D hands the camera out and back to the metre; Street View
opens with walkable arrows. Cache at 87 MB in 5 255 files against ceilings of
524 MB and 40 000.

## 0.87.1 — a fifth help tab: what this is

Asked whether the promotional page was embedded in help. It was not, and copying
it in would have been a mistake: three separate bugs this week came from a second
copy of something drifting from the first — the key list, the layer groups, the
"deliberately not here" section. A full second copy of the prose would have been
the fourth.

But something *was* missing. The app uses four words to describe its own data —
measured, inferred, an area rather than a point, hand-entered — and defined none
of them anywhere. The argument behind all of it was implied in every layer note
and stated in none.

So: a **WHAT THIS IS** tab. The four kinds of thing on the globe, what each one
means and how it can be wrong; what the app deliberately will not do and why;
what a count of zero means, which is that the feed answered and had nothing
rather than that the app gave up. It ends by pointing at the fuller page beside
the app folder rather than repeating it.

Roughly a screen of text, and none of it duplicated from the other four tabs.

## 0.87.0 — the live traffic was not live

Asked a simple question about the traffic layer: how does the time work? Measuring
it produced an answer I did not like.

TomTom send `cache-control: private, no-cache, no-store, must-revalidate` on the
flow tiles, so nothing between here and them holds an old answer. But **the app
never asked again.** Cesium keeps a tile it has already drawn and will not
re-request it, however short-lived the server says it is, because as far as
Cesium is concerned the URL has not changed. And the incidents only refetched
when the view rectangle moved. Sit still — which is the normal way to watch
traffic, unlike every other layer here, which you fly around — and the picture
quietly froze while still looking live.

Both now come back on their own every two minutes, and only while lit.

The flow tiles carry a stamp that changes with the refresh window, which is the
only honest way to make Cesium fetch a new picture. And the swap is a lay-over,
not a replace: the new layer goes on top, the old comes off four seconds later
once there is something to see. Removing first blanks every road on screen for as
long as the tiles take, which during a recording is worse than a slightly stale
picture. Measured through a forced refresh: stamp `…908` to `…909`, layer count
3 → 4 → 3, no gap.

The server cache came down from three minutes to ninety seconds, because a
two-minute client against a three-minute cache means every other refresh is a
no-op that costs a request and returns yesterday.

**And the count stopped lying at altitude.** Zoomed out past three degrees the
incidents layer refuses the query — it is a street-level answer — but the panel
printed `0`, which reads as "no jams in Sweden". It shows a dot now, the same as
the imagery overlays, and the feed says to zoom in.

## 0.86.1 — a rocket pad shining through the planet

Reported as "the grey dot moves when I move — it is with me the whole time",
which is a better description of the bug than anything I would have written.

Eleven marker types carried `disableDepthTestDistance: Number.POSITIVE_INFINITY`.
I had reached for it so a mark in a valley would not be swallowed by the hill in
front of it, and infinity was the obvious value. It is also the wrong one: it
means *never let anything hide this*, and the earth is a thing. A Rocket Lab pad
on the Mahia Peninsula drew straight through the globe while the camera sat over
Europe, so it hung near the middle of the screen and slid around with the view —
exactly what an antipodal marker looks like.

Fifty kilometres keeps the intent and lets the planet occlude its own far side.

**And a missing-comma check**, because the version before this one did not boot.
A patch script spliced `noCount: true` into four layer definitions without the
comma, and `note: 'x' noCount: true` is a syntax error that brace counting cannot
see and a diff reads as ordinary code. The test now flags a closing quote, digit
or boolean followed by an identifier and a colon. Verified by planting the fault
and watching it name the line.

That is the second boot failure this project has had from a spliced string, after
the unescaped apostrophe. Both classes are now caught before the browser sees
them.

## 0.86.0 — the disk cache has a ceiling

It had none, and had reached **92 MB in 33 966 files**. Measuring it before
choosing a number changed the design, because it turned out to hold two
populations that want opposite treatment:

- **eight files** — mesh nodes, airports, power plants, two fire snapshots,
  satellites — **82 MB between them**, and expensive to fetch again
- **~34 000 files** — per-query answers, median **143 bytes**, about 10 MB in
  total

Plain least-recently-used over all of that would be actively wrong. Left to
itself it would drop `meshnodes.json`, untouched for three days, to reclaim
30 MB — and the next request downloads the same 30 MB straight back. So small
files go first, and anything over 1 MB is only touched if dropping every small
file was not enough.

**Two ceilings, because bytes and file count are different problems.** Half a
gigabyte is nothing on disk, but at a 143-byte median it would hold over a
million files, and a directory that size is slow to list, slow to back up and
unpleasant to open. 500 MB and 40 000 files.

The sweep runs every 400 writes rather than on every one: stat-ing 34 000 files
each time a 143-byte answer is cached would cost more than the cache saves.

Tested against the real directory rather than a fixture. Under both ceilings it
touched nothing — 33 966 files before and after. With the file ceiling tightened
to 5 000 it dropped 28 966 small files and **kept all seven large ones**, which
is the whole point of the split.

The smoke test now reads the actual cache directory and compares it against the
constants the server enforces, because a budget nothing verifies is a comment.

## 0.85.0 — why the road is stopped, and three lists that had drifted

Asked for small cars and visible congestion. Half of that is buildable and half
is not, so: **no cars**. There is no feed of individual vehicles, so they would
have to be invented, and an animated dot that is not a car is exactly what came
out of this app once already for being information-shaped and not information.

The congestion is real, though, and the TomTom key already covered it. The flow
tiles colour a road by how fast it is moving; the incidents feed says *why*.
Queuing traffic, stationary traffic, closures, roadworks — each on its own
stretch, with the seconds it is costing and the road number. Sweden is covered
properly: 225 incidents over Stockholm with 16 graded delays, 112 over Göteborg,
41 over Malmö, and even 24 over Umeå.

Most incidents come back graded 0, and that needed handling rather than hiding.
It is not missing data — roadworks block a road without there being a measured
delay to quote. Graded ones get a colour and a width that say how bad; ungraded
ones are drawn thin and grey, and the card says so instead of letting every line
read as a jam.

**Three lists had quietly drifted from the thing they described**, all found in
one sitting and all the same shape.

`/api/keys` carried its own copy of the seven key names that existed when it was
written, so `tomtom`, `openaq` and `gfw` read as "not set" in SETUP however
correctly they were saved. The field was telling the truth about a list, not
about the key. It is built from `ALLOWED_KEYS` now.

`Traffic flow` and `Data centres & dams` belonged to no layer group, because the
edit meant to add them matched nothing and said nothing. They had been sitting in
the "Other" bucket at the bottom of the panel, which is why they could not be
found. The smoke test now fails on any layer that belongs to no group.

And the layer list printed `0` beside the imagery overlays — traffic, radar,
disturbance, surface water — which reads as "found nothing" rather than "this is
a picture, not a tally". They print a middle dot.

## 0.84.3 — a key pasted into a running app went nowhere

Reported: traffic switched on, nothing drawn. Two faults, both mine.

**The empty answer was cached.** The key is fetched once and kept. If the app was
already open when the key was pasted into SETUP — which is exactly how anybody
would do it — the first fetch had returned an empty string, and `if (!tomtomKey)
return` then made the switch inert for the life of the tab. Nothing in the feed
said so either, because the warning had already been printed once and suppressed
after. An empty answer is no longer remembered: it asks again next time.

**And it did not survive an imagery rebuild.** `rebuildImagery()` calls
`removeAll()` and puts back the basemap, the OPERA overlays and the labels. The
traffic tiles went with everything else, and `trafficLayer` stayed pointing at a
layer no longer in the scene, so `show = true` set a flag on a corpse. Changing
optic or moving the day slider silently killed it. It is rebuilt with the rest
now — the same fix the labels needed in 0.77.0 and OPERA needed in 0.83.0, which
is three times one pattern and worth remembering.

Also: `/api/tomtom` was being requested on every redraw because `applyVisibility`
re-enters this on any layer change. Guarded.

Verified along the way, since none of it was obvious: the whitelist now enforces
properly — 403 with no referrer, 403 from a wrong one, 200 from both
`127.0.0.1:8820` and `localhost:8820`. It took a few minutes to propagate, and
the first round of tests said "not enforced" when the truth was "not yet". And
the tiles do carry data: decoded and counted, 5.7% of pixels painted over central
Stockholm, 11.9% over London. An earlier count of 0% was me sampling tile
coordinates 400 km off the city I meant.

What is still unverified is whether it *paints*, which this machine cannot show:
the browser pane does not composite frames, so Cesium never requests imagery here
at all. The layer is correct, shown, and carries the key in its URL. The rest
needs eyes on a real browser.

## 0.84.2 — the ships were listening to the wrong switch

Asked whether the app is any use to somebody who adds no keys at all. Tested it
properly rather than reasoning about it: keys file parked, server restarted with
nothing, every feed called.

It holds up. Air traffic, ships, 1 591 of the 4 102 cameras, rocket launches,
the radar and ground-change layers, borders and names, earthquakes, volcanoes,
outbreaks, data centres and dams — all of it works with no account anywhere. The
switches for terrain, buildings, photoreal and Street View hide themselves rather
than sitting there dead, and the three key-gated layers say which key they want
and where to get it. Nothing fails silently and nothing looks broken.

The test found a real bug, and not a keyless one. `pollVessels` was gated on
`LAYERS[1].on` — a hardcoded index that has pointed at *Police & state air*, not
*Vessels*, for as long as it has existed. It never showed because that layer used
to default on, so the check passed by accident. Making every layer start off in
0.80.0 removed the accident, and ships stopped drawing for everybody, keys or no
keys. `pollFlights` next to it used `LAYERS[0]` and was right only by luck.

Both now ask by id through one small helper, so adding a layer cannot quietly
re-point them. Verified with the vessel layer on and the aircraft layer off:
3 387 ships.

Worth naming the shape of this one. It shipped in a version whose smoke test was
green, and it stayed invisible for months behind a default. A test that asks
"does the feed answer" cannot see a layer wired to the wrong switch, and neither
can reading the line — `LAYERS[1]` looks deliberate. It took running the app in a
configuration nobody had run it in before.

## 0.84.1 — the help tab was telling people the opposite

Asked whether the new work was in setup and in help. Setup was fine: every key
name the server accepts has a field. Help was not, and not merely incomplete —
it was actively wrong.

Four of the six entries under **What is deliberately not here** described
features that are now built. It said NASA OPERA "wants a (free) account", which
it does not — it needs none at all, and was the cheapest of the six things added
this week. It said OpenAQ had "moved to keys", as though that ended it. It listed
fishing activity and amateur radio positions as absent when both are layers. And
it said OpenMHZ answers 403 to anything that is not a browser, which was checked
from the page: 200, and 454 systems. Only the scanner *audio* is genuinely
missing, which is a much smaller claim.

A stale help tab is worse than a thin one, because the confident tone is the same
either way. What is left in that list is what is really absent: Telegram, which
is a decision; Shodan as a located map, which is also a decision and now says why;
Copernicus EGMS, which is a real gap; Finnish trains, which is broken at their
end.

Added everywhere else it belonged: the ground-change group and why radar is worth
having, data centres and dams needing a zoomed-in view, launches being a schedule
rather than a fact, ISS passes and the ten-degree floor, viewsheds only for
calibrated cameras, and the three new keys with what each costs and which need no
account at all.

## 0.84.0 — six more sources

A survey of what comparable open projects read openly, and what of it this app
was missing. What was worth taking was never code — architectures do not
transplant, and this one is Python with plain JavaScript — but *which feeds
exist and how they are addressed*, which is a fact about the world rather than
anybody's work. Six things came out of it.

**The most useful finding was about this app.** A secondary source claimed
TeleGeography's submarine cables are CC BY-NC-SA 3.0, NonCommercial. Going to the
source instead of trusting that, TeleGeography say something different today: the
*map* is CC BY-SA 4.0 with no NonCommercial clause, and anyone wanting the *data*
commercially is pointed at a form. This app reads the data feed. Two things were
wrong here: the licence table said "attribution, free", and commercial-safe mode
did not withdraw the layer. Both fixed — the switch now takes the cables off with
everything else, and the table says what TeleGeography actually says.

**1. A second community ADS-B network.** This already fell back from OpenSky to
adsb.fi; adsb.lol now sits behind that. In that order and not the other way round:
adsb.lol's feeders are almost all in Europe and North America, so it is the better
second opinion over Sweden and no help at all over the Gulf. Two community
networks having a bad afternoon at once is rarer than one.

**2. Rocket launches.** The satellite layer shows what is already up there; this
is what is on its way, which is the more watchable half — a launch has a place and
a time, so it is the one thing here you can plan to be looking at. Forty
scheduled, one inside 24 hours. The status comes through untranslated — Go, TBD,
Hold — and anything not Go is drawn dim, because half of spaceflight is slipping
to the right and the map should say so.

**3. Measured traffic.** The simulated traffic was removed months ago for a good
reason: a moving dot that is not a car is worse than no dot, because it looks like
information. TomTom's flow is measured. Needs a free key, and says so with the
address when it is missing.

**4. Camera viewsheds.** A camera marker says where a camera is, not what it can
see, which is the question you actually have. Only *calibrated* cameras get a
cone: the feeds carry a position and nothing else — no bearing, no field of view —
so for an uncalibrated camera any cone would be a direction I invented and pointed
at somebody's house. Calibrate one from its card and it gets a real wedge from the
numbers you set.

**5. Data centres and dams.** Two kinds of thing that are enormous, quietly
critical and on no other layer here. Queried live from OpenStreetMap for the view
rather than bundled — a bundled extract is a copy of somebody's database under
ODbL with share-alike attached, and asking for what is on screen avoids both that
and a file that goes stale. Most dams in OSM have no name; the card says "unnamed
dam" rather than reaching for the nearest label.

**6. ISS passes.** When the station goes over, worked out from the orbit this app
already propagates rather than from a pass API — so it needs no new source and
agrees with the dot on screen by construction. Four passes over Stockholm in 171
ms, spaced about 94 minutes apart, which is the station's orbital period and the
cheapest sanity check there is. Ten degrees is the floor: below that it is behind
whatever is on your horizon, and printing it would be a promise the sky does not
keep.

Two bugs found by running it rather than reading it. Overpass answered 504 on the
first call and the layer then sat empty forever, because the "where did I last
ask" marker had already been set — it is cleared on failure now, so the next
camera move retries. And the missing-TomTom-key warning printed three times in one
second, once per redraw; it says it once.

## 0.83.0 — radar, air, and what vessels are doing

Three from the list, and checking them first changed the order entirely.

**Ground change, and it needed no account at all.** I had this filed as the
biggest job. It is the smallest: NASA already serve the OPERA products through
GIBS, which this app has been talking to since the day slider was built. Three
overlays, `GoogleMapsCompatible_Level12`, about 30 m a pixel, no key:

- **Radar backscatter** (Sentinel-1). The only layer here that does not care about
  cloud or darkness. Water goes black, cities go bright, and a ship on open sea is
  a dot where no dot should be.
- **Ground disturbance** (DIST-ALERT). Where vegetation cover has dropped against
  a baseline — burn scars, clear-cuts, ground churned up by something heavy.
- **Surface water** (DSWx, radar). Where there is water today that is not normally
  water. It can see a flood while the storm is still overhead, which is exactly
  when the optical layers see cloud.

They lag, because a swath has to be flown, downlinked and processed. Each carries
its own delay on top of the day slider and prints its own date in the feed, so
nobody mistakes this for a live view. Verified before writing the client: six
tiles fetched over Sweden and California, all 200, the Swedish radar tile 77 kB of
real imagery.

**Air quality** and **fishing behaviour** are built and both need a free key,
which I cannot create. Without one they say so in the feed with the address to get
it, rather than drawing nothing and looking broken.

Air quality is one request per view rather than one per station: asking OpenAQ for
locations gives names but no readings, then a hundred more requests to get them.
The parameter endpoint gives every recent PM2.5 reading in the circle at once. The
cost is that a reading carries a station id and not a name, which the card says.
Colour is the WHO 24-hour guideline and the steps above it, so green means under
the number the guideline names rather than "good" in some vague sense.

Global Fishing Watch is behaviour, not position — the vessel layer already has
position. Fishing, encounters, and transponder gaps. The gaps get a sentence on
the card and it is the whole reason that layer needs one: a transponder stops for
a great many innocent reasons, so a gap is a question about a vessel and not a
finding against it. A map that quietly implies smuggling is worse than no map.

Left alone as agreed: Shodan, except as country-level aggregate if it is ever
wanted — a map of individually located exposed devices on a public stream is a
targeting aid — and Telegram, whose unverified claims fit badly with a globe where
every layer is marked real, estimated or hand-entered. Own entries already covers
anything read and stood behind.

**The template check earned itself.** It caught four `${DOT}` and `${DASH}` leaks
in this change before they ever ran, which is precisely the class of bug it was
added for one version ago.

## 0.82.0 — the layers follow into 3D

Google's 3D view is a separate renderer, so nothing drawn in Cesium appeared in
it. Porting each layer by hand would have been twenty-odd small jobs that drift
apart the first time one of them changes, so instead the layers are read back out
of the Cesium collections they already live in and mirrored as Google markers. One
mechanism; a new layer joins by adding a line to a table.

That needed one refactor first. The description of a picked thing — three hundred
lines of "a vessel is this, an aircraft is that" — lived inside the globe's click
handler, which was right while the globe was the only clickable surface. It is now
`describePicked(type, ref)`, and both surfaces call it with the same pair they
already carried. One description of a vessel, not two that drift.

**Two limits, both said out loud in the feed.**

Markers here are DOM elements, not points in a vertex buffer. Twelve thousand
aircraft would be twelve thousand custom elements and an unresponsive tab, so only
the nearest three hundred to the middle of the view are drawn. Measured on
Stockholm with air traffic, vessels and cameras on: 4 238 known, 300 drawn,
furthest drawn 23.85 km out, nearest omitted 23.86 km — the cut lands exactly on
the boundary, with no gap and nothing near the middle skipped.

Borders and place names are not mirrored at all. Google draw their own in hybrid
mode, better than a copy would, and drawing both would put two slightly different
sets of lines along the same coastline.

**Height is kept where height is the point.** Anything above 150 m keeps its real
altitude and gets a line down to the ground; everything else is clamped, because
its height came from a globe with different terrain under it. Five of the three
hundred were aircraft, and they hang in the air where they belong.

Satellites are deliberately absent. In a view of a few city blocks a thing 500 km
up is not on screen, and clamping a marker for it to the ground would be a lie
about where it is.

## 0.81.0 — photorealistic 3D, through the other door

I was wrong, and the user was right to push.

Google refuse this account the Photorealistic 3D Tiles from the **Map Tiles API** —
"satellite tiles and 3D tiles are not available for your account and region", the
EEA withdrawal of 8 July 2025 — and that part is real and was verified twice, both
the 3D root and a 2D satellite session. From that I concluded photorealistic 3D
was gone, and offered to delete the switch.

It is not gone. **Photorealistic 3D Maps in the Maps JavaScript API is a different
service**, and it serves this account. The clue was there in Google's own material
and I walked past it: their list of EEA-adjusted services names Map Tiles, Maps
Static, Street View Static, Places, Routes and seven more — and no entry for Maps
JavaScript API. The user read that correctly. A probe page settled it in thirty
seconds, on screen, over Stockholm.

Two things worth keeping from how that went. The probe reported no auth failure,
no error, and *zero* network calls — which I could not read as success or failure,
because this machine's browser pane does not composite frames and a WebGL element
that never gets one never starts. That is the same trap that made Cesium look
broken earlier in this project. The honest move was to hand the probe to somebody
with a real browser rather than guess, and it was the right one.

And `maps3d` is on the **stable weekly channel**, not only alpha. Alpha works but
paints "for development purposes only" across the view, which is no use to
something that might be monetised.

**How it fits.** Google bring their own renderer, so the two cannot share a canvas.
Their element sits over Cesium's and the camera is handed between them: switching
on does not lose your place, and switching off does not either. Cesium measures
pitch up from the horizon and Google measures tilt down from the nadir, so the two
are ninety degrees apart. Round trip measured: out at 1 400 m, pitch −32°, heading
35° → look-at 2 643 m away, tilt 58°, heading 35° → back at the same spot, 1 401 m,
pitch −32°, heading 35°. A metre over the whole journey.

The first version of the handover was sixty kilometres out. It used `surfacePoint`,
which asks the depth buffer first — right for the ruler, which measures what is
drawn, and wrong here, because this runs the instant the switch is flipped and an
unrendered depth buffer reads back as nonsense. It is a ray against the ellipsoid
now: pure geometry, no frame needed. Sea level rather than terrain, which costs
nothing when Google bring their own ground.

**The meter no longer claims a number I have not checked.** It counts each time the
3D view is opened and says plainly that the free allowance for this SKU is
unverified, and that the console is the authority.

**And the smoke test learned a new trick.** Three times now a patch script has left
one of its own variables inside a template string — `${DOT}` where a middle dot
was meant. Each is a ReferenceError the moment that line runs, possibly days later
down a branch nobody took, and it reads as ordinary prose in a diff. It is trivial
to catch mechanically: a template hole naming a single SHOUTING_NAME declared
nowhere in the file. Verified by planting one and watching the test fail.

## 0.80.0 — the panorama, a quiet start, and marks you can see

**Street View is the real thing now.** It was built on the Street View Static API,
which under the EEA terms *"may not be used With any Map"* — defined as on, next
to, or visually associated with one, which is exactly a photograph in a panel
beside a globe. Google name the alternative themselves, so it now uses the Street
View Service in the Maps JavaScript API.

That is also just better. Walking used to be a guess: ask for a point twenty
metres up the street and let radius=60 snap to whatever was nearest. The panorama
knows its actual neighbours, so the arrows follow the road, and moving in it drags
the standing camera with it. Turning costs nothing now either — only arriving at
a new panorama is billed, so the heading no longer has to be rounded to eight
steps to keep the bill down.

Two things found by running it rather than reading it. The source was
`OUTDOOR`, which only rules out interiors: at Times Square the copyright line read
a private person's name, because it had returned somebody's photosphere. It asks
for `GOOGLE` now — the camera car and nothing else. And **the panorama does not
render yet**: Google answer `ApiNotActivatedMapError`, because Maps JavaScript API
is not enabled on the project. The lookup works, the picture needs that switch.

**The app starts quiet.** It used to fetch every layer at launch and then hide most
of them, which is the worst of both — a slow, loud start and a globe nobody asked
for. Twelve thousand aircraft, twenty-four thousand AIS contacts and two hundred
and sixty thousand thermal points, all so they could be switched off. Layers now
start off and are not fetched until switched on, through the same map the layer
list already used and which had sat empty since it was written. Boot went from
sixty feed lines to six. Two stay on: names and borders, because a map you cannot
read is not a map, and public cameras, because they are the reason to look
anywhere.

The repeating polls are gated the same way, so a layer left off stays off rather
than quietly refetching every fifteen seconds.

**Radio marks over satellite.** Reported: impossible to find. They were a 7 px dot
at 65% opacity — which reads on the ops basemap and vanishes over imagery,
because a soft green dot on green farmland is the one thing the eye cannot pick
out. Now 13 px, opaque, ringed in near-black, and no longer depth-tested against
the terrain. The dark ring is what does the work: it separates the mark from
whatever is behind it rather than hoping the fill happens to contrast. Same
treatment for the shortwave receivers.

Not verified visually — the browser pane would not composite frames for a
screenshot. The properties are confirmed applied; whether it *reads* is yours to
say.

## 0.79.0 — the fleet reads itself, and a switch that was never going to work

**Photoreal 3D.** Reported as unclickable, twice. It was two faults stacked, and
only the second one matters. It sits in Descent, which is folded on arrival, so
the switch was `display:none` and 0×0 pixels — the section index reaches it, but
you have to know to look there. Underneath that was the real answer. Google
replies:

> satellite tiles and 3D tiles are not available for your account and region

On 8 July 2025 Google withdrew satellite tiles and Photorealistic 3D Tiles from
projects billed to an address in the European Economic Area. A Swedish billing
account gets a 403 and there is no key, card or quota that changes it. Everything
I had said about enabling the Map Tiles API and restricting the key was beside
the point: the feature was never available here.

The app already asked Google what was wrong and printed the answer, which is how
this was found — but it printed it into a feed that carries the aircraft count
every few seconds and is capped at sixty lines, so the one message worth reading
was gone in about two minutes. A refusal that cannot be fixed by trying again now
disables the switch, writes the reason beside it, and remembers it, so the second
launch does not offer it again. It is not probed at startup: a root request that
*succeeds* is the one thing Google bills for, so only refusals are cached.
The help tab said it needs a key. It now says which accounts it will not serve.

**The fleet updates itself.** Fair objection: a hand-typed file that goes quietly
stale is worse than no file. It now reads the newest Fleet and Marine Tracker at
launch, and eight of the nine ships come from it.

The site refuses a plain Python client outright — 403 to anything whose TLS
handshake does not look like a browser, however polite the User-Agent, which cost
an hour of blaming rate limits. Dressing up as a browser would have worked and is
the wrong instinct: USNI publish an RSS feed, which is the channel that exists for
programs, and it carries whole articles. One request gets the tracker and every
day of reporting since. The obvious category feed was served from a cache three
weeks behind; the main feed is current, so it reads that.

What it will not do is invent a position. The tracker is organised prose — an
`<h2>` per area, ships underneath — so which named area a ship is in reads
reliably, and that is all USNI ever give. There is no latitude anywhere in the
document. So a ship is placed at the centre of her named area with a ring covering
the whole of it, from a gazetteer of plain geography harvested from thirty
trackers. It does not mine the prose and turn "transiting westbound" into a
course. An area is not a position, and the card now says which one you are looking
at. An area not in the gazetteer is not guessed at: the ship is named in the feed
as not drawn, because a missing pin is recoverable and a confident wrong one is
not.

Three ships listed "In San Diego" landed on one point and two became impossible
to click, the way outbreak markers used to hide under each other at a shared
centroid. They are fanned around the area centre, well inside a ring that was
already drawn, so nothing is claimed that stacking them did not claim.

Typing still beats fetching in exactly one case: where somebody has read something
newer than the tracker. George Washington stays where Thursday's reporting put
her rather than where Monday's tracker did. That guard compares against the file's
tracker date and not its newest hand correction — one ship read on Thursday must
not freeze the other eight.

And because a tracker is a week old the day after it goes out, anything published
since whose *headline* names a ship is attached to her: date, headline, link. The
first version matched article bodies and flagged the Bush and the George
Washington with a piece about the Lincoln, which is worse than no flag, so it
matches headlines only. It is not called stale, either — one of the three hits is
a court case, not a movement. It says USNI wrote about her after this tracker,
and leaves the reading to a person.

## 0.78.1 — a carrier had sailed

Asked whether the Bush was really still in the Arabian Sea. She is: the 17 August
Fleet Tracker is still the newest one published, it puts CVN-77 there, and a USNI
piece from the 20th names her again in the same waters. That pin was right.

Checking it turned up one that was not. USS George Washington was drawn in the
Singapore Strait, which is where the tracker last saw her — westbound, on the
13th. She kept going. CENTCOM said she entered their area on the 19th, and she is
now in the Arabian Sea, expected to relieve the Abraham Lincoln group after 272
days deployed. The marker has moved, with a 650 km ring, because USNI say plainly
that it is not clear how close she is to Lincoln and a tighter ring would be a
guess dressed as a fix.

The interesting part is why the app could not have caught this. Carriers do not
broadcast AIS; this file is read and typed in by hand, so its dates are the dates
somebody last read the source. Until now every ship inherited one date from the
top of the file, which is fine while they all come from one tracker and wrong the
moment one of them moves in between. A ship can now carry its own date, source
and link, and those beat the file's. The card gained a Read row, so the claim on
screen is one click from the sentence it came from.

## 0.58.0 — the ruler read long

Reported and confirmed: distances came out too big. Same cause as the descent
buttons had. `pickEllipsoid` sends the ray *through* whatever is being aimed at
and on down to sea level, so each point lands beyond its target — both ends
pushed outward, the far one more on an oblique view, and the tape stretches. It
now picks what is actually drawn.

And it measures the right thing. `surfaceDistance` is an arc at sea level, which
is what you want for travel and not for an object. A leg is now the straight line
through space between the two points — the tape measure answer — with the ground
distance and the height between them added to the readout when the climb is
enough to explain the difference. Checked against known values: a 142 m hull
reads 142.0 m, and 500 m of ground with 400 m of climb reads 640.7 m against a
true 640.3.

## 0.66.0 — mesh radio, news attention, trains

**Meshtastic.** Where the shortwave layer is receivers you can listen through,
this is a network that exists without anybody's permission: LoRa mesh on hardware
costing less than a meal, relaying text with no infrastructure. 1 467 positioned
nodes around the Nordics alone, including SA0CVK, Huvudsta and Telefonplan.

Off by default and loaded by view — thirty-one thousand nodes is a green fog at
global zoom. The whole file is 30 MB and Liam Cottle asks for daily polling, so it
is fetched once a day and kept on disk; fetching it per request would be an abuse
of a volunteer's bandwidth. Coordinates arrive as integers scaled by ten million,
which is the Meshtastic wire format and not a bug.

**Only nodes on the public MQTT bridge appear**, and the card says so. Most mesh
traffic stays local, which is rather the point of a mesh.

**News attention, from GDELT.** It reads the world's news and tags each article
with where it came from; aggregated, that answers what no sensor can — where
attention is right now. China 39 articles, the United States 29, India 18.

**It counts coverage, not events**, and that is on the card because the difference
is the whole caveat: a free press and a censored one produce very different
numbers for the same trouble. A bright dot is a reason to look, never a finding.
They ask for one request every five seconds; a fifteen-minute cache is far inside
that, and every failure during development was my own testing in bursts.

**Trains** — the one form of transport this globe had nothing of. 194 Amtrak
services running, with origin, destination and speed. Finland's open feed is
absent and not for want of trying: `train-locations` answers 406 to every Accept
header I could construct, while the same host's AIS and camera feeds work fine.
The layer note says so rather than leaving a Finn to wonder.

Twenty-one layers now, no warnings in the log, 99 MB of heap. OpenSky's daily
quota reset during the work, so global air traffic is back to 13 733.

## 0.64.0 — outages, the frontline, and a recon panel

**Internet outages, from IODA.** Georgia Tech's Internet Intelligence Lab watches
the internet three ways at once — BGP withdrawals, active probing, darknet
background noise — and raises an alert when a place goes quiet. Agreement between
the methods is the entire signal: one source alone is a measurement artefact as
often as an outage, so the dot grows with how many agree and the card names them
and says which case this is. A national outage is usually a cable or a
government.

Their API refuses relative time offsets with a terse *'from' timestamp must be
set*, which the documentation implies otherwise; absolute unix seconds work.
Autonomous systems are dropped, including the ones IODA slices by geography —
*AS270 -- California* is still a network and not a place. 21 regions remained.

**The Ukrainian frontline, from DeepStateMap**, as outlines rather than filled
areas. A filled polygon on a globe reads as a claim about ground truth; this is
one editorial group's reading of open reporting, and an outline says *roughly
here*, which is what the source can support. 120 areas.

**A Recon panel**: DNS to A record, IP to location, IP to open ports, IP to RDAP
owner, IP to network and ASN. Everything published by the registries about
themselves — nothing touches the target. Proxied through our own server so the
browser never talks to a third party directly, **and so private addresses can be
refused before any request is made**: 10.0.0.1 and 192.168.1.1 come back
*that is not a public IP address*. A lookup tool that will query anything is a
way to make somebody else's server probe a private network.

Verified: `svt.se → 3.33.226.205`, `8.8.8.8 → Ashburn, Virginia, Google LLC`,
ports 53 and 443 from Shodan's keyless InternetDB, RDAP owner for a Swedish
prefix, and both guards refusing.

Two of mine, caught by testing: the network lookup takes a *prefix* and the guard
demanded four bare octets, so `8.8.8.0/24` was refused as private. And our own
validation was answering 502, which blames a provider that was never asked — a
refused request is a 400.

## 0.63.0 — space weather, severe weather, power, and who runs the place

Four at once, all keyless, all with their own client written from the fact that
the source exists rather than from anybody's code.

**Kp in the readout.** NOAA's Space Weather Prediction Center publishes the
planetary K index minute by minute, public domain. It is the one number that says
whether tonight is worth pointing a camera at the sky: 4 unsettled, 5 a storm, 7
aurora over mid-latitudes. The 24-hour peak shows beside it when it is higher,
because a quiet minute inside a stormy day is not the story. Amber at 5, red at 7.

**Severe weather, United States only** — and the layer says so. The NWS publishes
every active alert as GeoJSON; 30 are severe or extreme right now. No open feed
covers the rest of the world, and a European looking at an empty map deserves to
know it is the feed and not the weather. Alerts referencing a zone rather than a
shape carry no geometry and are dropped rather than guessed at: a warning drawn
over the wrong county is worse than a missing one. Their API refuses a `limit`
parameter with a 400, which took a few minutes to work out.

**35 000 power stations** from WRI, CC BY 4.0. Off by default — it is a reference
layer, not news, and thirty-five thousand dots is a rash that hides everything
else. Loaded by view like the fires, sized by the root of capacity because it
spans four orders of magnitude, coloured by fuel. Verified: Ringhals at 3 932 MW,
correctly nuclear.

**Who runs the place.** Wikidata under CC0, on the place readout: hover the region
name and it says the country's head of state and head of government, kept apart —
which matters in a monarchy, where Sweden is Carl XVI Gustaf *and* Ulf
Kristersson.

The smoke test caught the two new endpoints needing arguments before I did, which
is the first time it has found something rather than confirmed something.

## 0.62.0 — Sentinel-2 at 10 m, and safe mode can finally descend

Commercial-safe mode had a real cost: NASA's imagery stops at 300 m, so choosing
licence-clarity meant giving up detail. It refused to descend at all, and that was
right only while there was nothing clear to descend to.

**EOX build an annual cloudless mosaic out of Copernicus Sentinel-2 and serve it
openly under CC BY 4.0.** That combination is rare — NASA is free but coarse,
Esri is sharp but carries terms nobody can be sure of. This is sharp *and* clear
to use, which makes it the one basemap safe mode can dive with. Verified to zoom
16, keyless.

So the handover now has two destinations, and picks by mode: below 140 km it goes
to Esri normally, and to **Sentinel-2 at 10 m** in safe mode. Measured round trip:
FIRE IR at altitude, `tiles.maps.eox.at` at 90 km with safe mode on,
`server.arcgisonline.com` at 90 km with it off, and FIRE IR back at 400 km either
way.

**The catch is in the name**, and the legend says it: *cloudless* means composited
over a year. It is a basemap, not a snapshot — no clouds, no smoke, no ships,
nothing that happened on a particular day. For today, SMOKE or FIRE IR.

### One of mine

The handover reset was keyed on a list of style names — anything that was not
`satellite` or `burn` cancelled it. Adding a third destination silently broke the
return trip: handing over to `s2` cleared the handover's own memory of itself, so
climbing back out did nothing. It is keyed on which caller asked now, which cannot
rot the same way.

## 0.61.0 — radio

Some 900 people have put a shortwave receiver on the public internet and left it
open. **866 are online, 800 with a free slot**, including SK2HG at Siknäs and
SK5SM in Sweden. Click one and LISTEN opens that receiver's own interface, tuned
by you, live off that antenna.

The list comes from Pierre Ynard's mirror rather than kiwisdr.com, because that is
what the mirror is for — keeping a megabyte off one volunteer's bandwidth. It
regenerates about every half hour, so that is the cache TTL, on disk as well as in
memory. The card says the rest: *somebody else's receiver and somebody else's
bandwidth. Slots are shared — take one, listen, and leave.* Colour shows at a
glance whether there is room, because finding out by clicking wastes a click.

The receiver's own web interface does the tuning and the audio, so LISTEN opens it
rather than this app reimplementing a waterfall. Most are plain http on home
connections, which an https page cannot embed anyway.

**Every URL in every detail card is now a link.** They had been printing as plain
text, which for a WHO report or a receiver you want to listen through means
selecting and copying. One helper, and it fixed every card at once.

## 0.60.0 — erupting volcanoes

The briefing has had a `volcano` slot since GDACS's other alert types were wired
in, and it stayed empty because GDACS rarely raises one — while two dozen
volcanoes were erupting the whole time.

The Smithsonian's Global Volcanism Program keeps the catalogue and serves it as
WFS with no key. Its useful question is not *what erupted today* — it is curated,
so that lags by months — but *what is still going*, which it flags. Twenty-four
are, right now: Semeru and Manam at VEI 4, Kanlaon, Sabancaya, Krasheninnikov at
3, and Kilauea, Merapi and Taal further down.

Dots scale by the Volcanic Explosivity Index, but by the index and not by its
value: the scale is logarithmic, each step ten times the ejecta, so drawing it
literally would leave Merapi at VEI 1 invisible next to a 5. The briefing ranks
by index and then by how recently the eruption began, since an old VEI 2 is less
of a story than one that started last month.

**Said plainly on the card:** a curated catalogue is not a sensor. An eruption
appears once somebody confirmed it, and one that has quietly stopped can linger
in the list.

Found by reading the data-attribution file of another project rather than its
code — which sources exist is a fact, and our own client is our own.

## 0.59.0 — Own entries

The feeds cover what the feeds cover, and that is less than what happens. WHO
publishes an outbreak once it crosses an international threshold; a national one
of 27 cases goes to the national agency and stops there. Neither WHO nor GDACS has
an opinion about a strike, a border closure or a factory fire that made the local
paper. A globe that can only show what has an API misses most of the world.

So there is a file for things read about, following the pattern `carriers.json`
already set: hand-kept, dated, and labelled loudly. **Own entries** in the panel
takes a title, a place in words, a source link and optional detail, and puts the
marker wherever the camera is looking — flying somewhere and pressing a button
beats typing coordinates, and it is the same gesture as leaving a mark.

Drawn in amber, and the card leads with **HAND-ENTERED · not from any feed**,
closing with *no satellite or feed saw this — it is here because somebody read
about it.* That labelling is the whole point. The one thing that must never happen
is a viewer taking one of these for something a satellite saw.

**A source link is required**, and must start with http. An entry without one is
worth less than no entry, and a `javascript:` URL in a field that becomes a link
is a hole. Verified: four bad shapes refused by name — no link, no title,
`javascript:`, no position — and the file left untouched.

Seeded with the measles outbreak that started this: 27 cases across nine Swedish
regions, traced to the Urkult festival at Näsåker, with the
Folkhälsomyndigheten page as its source. Add and remove both tested through the
panel.

## 0.58.1 — what the disease layer cannot see

WHO publishes Disease Outbreak News when something crosses a threshold of
international concern. An outbreak a national agency is handling never reaches
it, and the layer said nothing about that gap.

In August 2026 there were 27 measles cases across nine Swedish regions, traced to
one festival, and nothing about it appears on this globe. The layer is now named
*WHO international alerts only — national outbreaks are missing*, the card says
where to look instead, and LIMITS carries the sentence that matters: **an empty
map of Europe is not an empty Europe.**

No feed was added because there is not a good one: ECDC's weekly report is a PDF,
Sweden's agency publishes no feed, and an HTML scraper does not belong in
something handed to friends. Saying what is missing is the honest alternative to
pretending it is not.

## 0.57.1 — measles was underneath the Nipah virus

WHO reports at country level, so two outbreaks in one country share a centroid
and the second dot lands exactly on the first. Measles in Bangladesh was drawn,
counted and completely invisible beneath Nipah virus infection at the same
coordinate. Three of ten markers were stacked that way: two in the Congo, two in
India, two in Bangladesh — ten dots at seven positions.

Grouping is the honest fix rather than nudging them apart. The position genuinely
is one point for a whole country, so one point is what it gets, sized by how much
is reported there, and the card lists everything: *2 outbreaks — Measles
2026-04-23, Nipah virus infection 2026-02-06.*

The count now says places rather than reports, and the log says both: *10 reports
at 7 places, 15 naming no single location*.

## 0.57.0 — LIMITS & FALLBACKS

A fourth guide tab, for the question the other three never answered: *why does it
look like this?* Every feed here is free, and free comes with edges — this is what
the edges look like from the inside, so a layer reading zero can be told apart
from a layer that is broken.

Five sections, twenty-four points:

- **When a count says zero.** Air traffic at global zoom is the common one:
  OpenSky is the only source that answers for the whole planet, and its free tier
  is a daily credit. Spent, the app falls back to a feed that can only be asked
  in circles around the view — which from 24 000 km covers almost nothing.
  Measured and written down: the same moment a global view showed 0, Europe
  showed 1 468.
- **What each key costs and what runs out**, with the asymmetry spelled out —
  a photoreal *session* is one request however far you fly, a Street View *view*
  is one each.
- **Ceilings you will notice**: NASA's 300 m pixel and where the handover
  happens, Esri's level 19, Street View's 640 px, Overpass's five-minute
  stand-down, Nominatim's one request a second.
- **What a number means before you say it aloud.** Thermal detections are not
  wildfires. "No international alert" is not "nobody knows". An outbreak marker
  is a country centroid. A nearby alert may be a different event. This is the
  section that keeps a video honest.
- **If something looks wrong**: read the feed log, check the version chip for
  `v—`, run the check, and never minimise the window while recording.

## 0.56.2 — a shortcut for the check

`Check Global Command View.lnk` sits in the project folder with its own icon,
pointing at a `.cmd` beside the start and stop scripts. It prefers the server
already listening on 8820 — testing the one actually in use beats testing a fresh
copy of it — and starts its own only if nothing answers. Verified both ways.

It also says what a green result does *not* mean: that the app boots and every
feed answers, not that the picture looks right.

## 0.56.1 — the WHO links went nowhere

Clicking an outbreak opened `who.int/2026-DON613`, which is a 404. The API's
`ItemDefaultUrl` is a slug and not a path — `/2026-DON613` — and pasting it onto
the domain produced a plausible-looking address that had never existed. The
reports live under `/emergencies/disease-outbreak-news/item/`.

Checked properly this time rather than by eye: every link in the feed was fetched
and every one answers 200.

## 0.56.0 — smoke, and a test that would have caught five bugs

### smoke.py

Five times in one day a change stopped the app booting, and every one was found
by noticing a version chip reading `v—`. They were the same shape each time: a
name referenced before it existed, after it stopped existing, or spelled
differently in two files.

`python smoke.py` now checks exactly that, and then some:

- every `$('#id')` in the script has an element in the page
- every bare callback handed to `addEventListener` is a name that exists
- every layer id asked of `applyVisibility` is in `LAYERS`
- braces, parens and brackets balance; `server.py` parses
- a server starts on its own port and **every endpoint found in server.py** is
  called, checked for a 200 and for JSON, and timed

`--quick` skips the paced and heavy feeds. Exits non-zero, so it can gate
anything.

**Proved rather than assumed.** All three bug shapes were introduced on purpose
and the test caught all three by name, then the file was restored and it went
back to clean. A full run is 24 endpoints, all green, the slowest being street
imagery at 8 s and the camera list at 4.5 s over 1.2 MB.

### SMOKE

FIRE IR sees *through* smoke — that is what short-wave infrared is for, and why
it can show a scar under a plume. Which makes it the wrong lens for looking at the
plume. **SMOKE** is the same satellite on the same day in the colours an eye would
see, so the haze is opaque and can be followed downwind.

Use them as a pair: the infrared answers how much has burned, true colour answers
where it is going and who is downwind. The legend says which is which rather than
leaving another all-green puzzle.

The handover now applies to any NASA-backed optic instead of only the infrared
one, and remembers which it took over from, so climbing back out returns the one
that was actually in use.

## 0.55.0 — epidemics, cyclones, floods

Two additions, one of which was already being downloaded and thrown away.

**Disease outbreaks, from the WHO.** Their Disease Outbreak News is served as
OData with no key and no registration — ReliefWeb covers the same ground and more
but wants an approved application name, and a thing handed to friends should not
need one each. The API returns an arbitrary page full of 2001 unless told to sort;
ordering by date is the whole trick.

There is an active Ebola outbreak in the Democratic Republic of the Congo as this
was written, WHO's third report on it, published a week ago. Also Nipah virus in
India and yellow fever globally.

**Two honesty problems come with country-level reporting, and both are stated
rather than hidden.** A marker sits on a country centroid because that is the
resolution WHO publishes at; the card says so, since a dot in the middle of the
Congo is not a claim about a village. And an outbreak WHO reported in April may be
over — the date is when WHO published, never when the situation ended.

Reverse geocoding those centroids briefly printed *Sankuru* for the Congo
outbreak, a province name WHO never reported. Outbreaks now keep WHO's own place
string. A precise-sounding wrong answer is worse than a vague right one.

Places that name no single location — *Global*, *Multi-country* — get no dot at
all. An exact-match list let "Multi-country" through and Nominatim placed it in
British Columbia.

**And GDACS's other event types.** The whole alert list was already being fetched
every fifteen minutes and mined for wildfires and earthquakes; cyclones, floods,
volcanoes and droughts were discarded. They are alerts somebody has already
judged worth issuing, which is a stronger signal than anything computed here.
Four tropical cyclones and a flood in Thailand appeared on the first run, at no
new cost.

### Two of mine, again

The layer entry for outbreaks never landed — a patch matched a `—` escape
against the character it stands for — so `applyVisibility` asked for a layer that
did not exist and the app stopped booting at `v—`. Fifth of this shape today. The
smoke test is overdue.

## 0.54.0 — walking, and a window worth looking through

**Arrows walk.** The static API has no notion of adjacent panoramas — that is the
interactive JavaScript product, billed separately — but it does not need one.
Asking for a point twenty metres up the street with `radius=60` snaps to whatever
panorama is nearest, which is the next one along the road. Up and down step,
left and right turn 45 degrees, and the standing camera goes with them so the
globe and the photograph keep looking at the same thing.

Every step is a billed image, so a held key must not become a spending spree:
key repeats are ignored and a step cannot fire more often than every 350 ms.

**The window was too small, and now expands** to 860 px on a button. The image
itself went from 640×400 to 640×640 with a 100 degree field, which is more street
for the same request — and 640 is the ceiling: asking for 2048 returns 640
without saying so, measured.

**A return visit is free.** Leaving a viewpoint and coming back bought the same
photograph again. Resolved URLs are remembered per spot and direction, so the
second visit reuses one and the browser serves the image from its own cache.
Verified: 62 requests before the round trip and 62 after.

Two things the throttled test pane taught, both fixed rather than worked around:
a `width` transition towards a `min()` value never interpolates in Chrome, so the
panel sat at its start size; and any size transition needs frames, which a window
sitting behind OBS may not be given. The panel snaps instead of animating —
robust for exactly the person who needs it.

## 0.53.1 — Esc left the panorama behind

Leaving the standing view put the camera back in the air and hid the standing
readout, but the Street View panel stayed on screen showing a photograph of
somewhere you were no longer standing. The panel was wired into arriving and
never into leaving.

`leaveViewpoint` now asks `showStreetView` rather than hiding the element itself,
so one function decides whether the panel is up and there is no second answer to
the same question.

## 0.53.0 — the moon, which was always there

Cesium has been drawing the moon in the right place from the start, out of Simon
1994's ephemeris. It is simply 400 000 km away, so at any zoom that shows a
country it sits far outside the frame — present and unseeable, which amounts to
absent.

A **MOON** chip in Jump to frames both bodies: a bounding sphere around the
midpoint, and Cesium works out how far back that has to be. Measured: the camera
settles at 919 000 km with earth and moon each fully inside the frustum. It is
not a Jump-to entry because it is not a place at a height.

And two numbers that make it worth flying to, in the readout: distance and phase.
Elongation gives the lit fraction, and asking the ephemeris again an hour later
gives waxing or waning — a single instant cannot tell you which. Perigee and
apogee are called out, since 363 000 and 405 000 km are the same moon looking
noticeably different.

Checked against an independent source rather than trusted: this computes *waxing
gibbous, 63 per cent* for today, and Moongiant says 62. One point apart, which is
the time of day.

## 0.52.0 — the day slider was rebuilding itself to death

Dragging it appeared to do nothing. `oninput` fires for every pixel of travel and
each one tore the imagery layer down and built it again, so crossing a week meant
thirty rebuilds and no single date ever had long enough to load.

The label follows the drag now; the imagery waits for release. And while it
catches up the label says *loading*, so a slow day reads as waiting rather than
as a control that does nothing.

The range went from 10 days to 21. The GIBS archive costs nothing and three weeks
is enough to watch a scar appear out of unburnt forest — verified by pulling the
same tile for several dates: on the 20th there is a rust-coloured front with a
smoke plume, on the 8th there is green forest and popcorn cloud.

## 0.51.0 — how far from paying

"How far am I from the threshold" deserved a straighter answer than a line of
small text under a switch. A **Google spend** section, two meters, showing what
*remains* rather than what is spent, amber at 80 per cent and red at the cap.

The surprising part is not the numbers, it is the asymmetry, so it is written
under each meter: a photoreal **session** is one request however far you fly,
while a Street View **view** is one request each. Verified: turning the standing
view from 90 to 95 degrees costs nothing, because the panorama steps in 45s.

Underneath, a link to Google's own figure — the meters count what this app asked
for since counting began, and anything else using the same key is invisible to
them.

### Street View working, after two restrictions of my own making

`REQUEST_DENIED`, twice, both self-inflicted. The API was not enabled on the
project, and then the key was restricted to a list Street View was not on —
because 0.32.2 told the operator to restrict it to Map Tiles alone. Both are
worth having; they just needed the second entry. The app now reads Google's
`error_message` and prints the four clicks that fix it instead of the status code.

And `source=outdoor` was on the image request but not the metadata check, so the
check could pass on somebody's holiday photosphere and the fetch then return
something else. Both carry it now. Measured at Sergels torg: 640×400, *captured
2026-04*, copyright Google rather than a contributor — which is what that flag
was for.

## 0.50.0 — Street View, and the simulation is gone

**The simulated traffic is removed.** It was honest about itself — the layer said
*(sim)*, the card said *modelled, not observed* — but a moving dot that is not a
car is decoration, and this app is worth more when everything on it is something.
258 lines gone, client and server: the agents, the junction following, the road
network endpoint that existed only to feed them. Nothing replaces it, because
there is no feed of where cars are. The HELP page's honesty list now reads
**Modelled: nothing.**

**Google Street View instead**, on the key already in the app. An actual
photograph from the spot you are standing on, on most roads on earth, where
KartaView reaches wherever a volunteer has driven — a lot of Europe and not much
else. It follows the standing view's heading in 45 degree steps, and reports the
capture month Google gives rather than dressing it up as a date.

Two deliberate choices about cost, since this one is billed per image:

**The free metadata endpoint is always asked first.** It answers whether a
panorama exists at all, where it actually stands, and when it was taken, for
nothing — so a spot with no coverage costs none of the 10 000 free images a
month. And the panorama steps in 45s rather than following the mouse, because a
smooth pan would spend the month in an afternoon.

**Both requests are made from the page, not the server.** The key is restricted by
HTTP referrer and a server has none; that trap already cost an evening on the Map
Tiles API and is written down in the code this time.

The usage counter now tracks both SKUs with their different allowances, and the
old single-count usage file is still read, so nothing is lost.

Requires **Street View Static API** enabled on the Google project — a second
switch, next to Map Tiles. Without it the metadata returns `REQUEST_DENIED`,
which is what it does right now.

### One I caused

Removing the simulation left `moveEnd.addEventListener(updateTraffic)` pointing at
a function that no longer existed. It threw during module evaluation, so the app
never finished booting and the version chip sat at `v—`. Third bug of this exact
shape today: something referenced before or after it exists, found by looking
rather than by any check. Every `moveEnd` listener is now audited to resolve.

## 0.48.0 — where, and where to read about it

A coordinate is not an answer to "where am I". Standing over 63.5, -118.8 and not
knowing whether that is Canada is a fair complaint about a globe.

**Place names, from Nominatim.** Briefing rows carry the region and country;
quakes already had theirs from the USGS. The readout in the HUD now names the
region under the camera, and says *open water* rather than inventing a name where
there is none.

**A news link on every event.** A search, not a feed — fetching articles needs an
API that rate-limits or charges, and a stale headline is worse than none. The
link is honest about being somewhere to go and look, and it is built from what we
actually know: *wildfire Northwest Territories, Canada*. Clicking it does not fly
the camera; the row still does that.

Nominatim is a donated service paced at one request a second, so two defences
against a briefing that sits there for half a minute. Aircraft are rounded to a
whole degree — they move, and a tenth of a degree would miss the cache on every
rebuild while "over Norway" needs no such precision. And the pass runs to a six
second deadline, past which events go out unlabelled: a missing place is a
smaller failure than a briefing that never arrives. Measured: 20 s cold with the
feeds, 89 ms cached.

Quakes were skipped by the lookup, having their place in the headline already —
which left their news query as the bare word *earthquake*. The USGS place string
was right there and is now passed along without being drawn twice.

## 0.47.0 — the ceiling was in the wrong place

Clicking a fire flew to 120 km, and the handover fired below 700 km, so the
infrared went on and was handed straight back off. The false colour could never
be seen on the one subject it exists for.

The thresholds were guessed. Measured on a 1280-wide canvas: NASA's 300 m pixel
displays one-for-one at about **340 km**, and at 700 km it is *downsampled* to
0.5x — the old threshold was throwing away detail that was still there. Handover
is now 140 km down and 280 km up, and a fire is flown to 250 km, which is 1.3x
enlargement with the cell about 250 px across.

## 0.46.0 — the key explains its own absence

Two ways the legend appeared to break on its own, both really the same fault: it
vanished for a reason the screen never gave.

**Handing over below the NASA ceiling took the key away with it.** The box stays
now and says where the false colour went: *handed over to sharper imagery, so no
false colour here. Climb above 950 km for the scar.* An explanation in the place
the explanation used to be.

**The optic is remembered**, like the view angle and the safe-mode switch.
Reloading dropped it back to OPS, so the infrared layer and its key looked as
though they had disappeared by themselves. The viewer is still constructed with
the default before the stored choice is known, so the imagery is rebuilt once at
boot when they differ. Verified across a reload: FIRE IR still selected, source
still GIBS, six rows of key on screen.

The legend remains `pointer-events: none` and deliberately inert. A colour key
has nothing to do when clicked, and that setting is what stops it stealing
clicks — the same setting that, when it sat in the wrong place, let them through
to DROP TO GROUND.

## 0.45.1 — the overlays were inside the panel

Clicking *live vegetation* in the legend pressed DROP TO GROUND. Both overlays had
been inserted inside `<aside id="panel">`, which is itself positioned, so
`right: 20px` resolved against the panel instead of the window and put the legend
on the **left**, on top of the Descent buttons. Being `pointer-events: none`, the
clicks went straight through to whatever was underneath.

The same mistake had a worse consequence nobody had noticed: `#stage` — the whole
presentation overlay, title and lower third — was in there too, and
`body.presenting #panel { display: none }` hid it along with the panel. **The
broadcast overlay has never once been visible.** I checked it earlier by reading
its text content and its `hidden` attribute, neither of which says whether a
thing is on screen. That was the hole in the test, not in the guess.

Both are now siblings of the panel rather than children, and `position: fixed` so
no ancestor can capture them again. Verified by geometry and computed style: the
legend sits at x=1048 with the canvas beneath it, DROP TO GROUND at x=25, no
overlap; and in presentation mode the stage measures 1280×720 with the title and
lower third both drawn.

## 0.45.0 — an angle to look from

Everything arrived looking straight down. Not because tilt was disabled — Cesium
binds it to middle-drag and to ctrl with left-drag, and it worked all along — but
because a `flyTo` given only a destination defaults to nadir. Every briefing
click, every tour step and every jump quietly flattened whatever angle had been
set by hand.

A **View angle** slider now runs from 12 degrees off the horizon to straight down,
defaulting to 40, and it is remembered. Every flight arrives at it. The tilt
pivots around the point in the middle of the screen rather than around the
camera, so the subject stays centred instead of swinging out of frame — which is
what a tilt control is expected to do, and needs `lookAtTransform` released
afterwards or every later camera move would be relative to that one spot.

The GLOBE jump is exempt and stays overhead. A whole hemisphere wants to be a
map; a place wants an angle, because that is where terrain and buildings have
shape.

Measured: slider to 40 then a briefing click arrives at 40 rather than 90, and
sweeping 20 / 65 / 90 holds the longitude of the target throughout.

## 0.44.0 — handing over at the ceiling

NASA's false colour stops at zoom 9, and below that the pixels only get bigger,
which is no use if the reason for descending was to look at buildings. Crossing
the ceiling now hands the globe to the sharper mosaic, and climbing back out
returns the false colour.

Two heights rather than one — down at 700 km, back at 950 — or the camera would
flip across a single threshold for as long as it hovered there. Measured: 800 km
stays infrared, 400 km hands over, 600 km stays handed over, 1200 km returns.

This is the same automatic optic-switching removed one release ago for being
disorienting, and it is defensible here for one reason: the operator caused it by
zooming, and the log names the ceiling that was crossed. An optic that changed
because a *list item* was clicked had no such excuse.

**In commercial-safe mode it refuses, and says why.** Nothing sharper here sits
on an unambiguous licence, so the globe stays enlarged rather than quietly
handing a monetised recording to Esri. Verified: the style stays on FIRE IR and
the log reads *commercial-safe mode has nothing sharper on an unambiguous
licence, so this stays enlarged*.

Choosing any other optic by hand cancels the handover's claim, so climbing back
out will not overwrite a deliberate choice.

## 0.43.0 — when, and an optic that stays put

**Every briefing row now says when.** Elapsed time, which is what a viewer feels,
and the UTC stamp, which can be checked. Fires report their *newest* detection
rather than their oldest, since the question is whether it is still burning.

This immediately exposed something the list had been hiding: the headline M 7.7
is **six days old**. Quakes are ranked by magnitude across the USGS seven-day
window, so a large old event outranks a fresh smaller one — defensible for
"biggest", wrong for "right now". The ranking is unchanged pending a decision on
which the briefing is for; the dates at least make it visible.

**The infrared optic stopped being yanked away.** `opticsForEvent` switched to
FIRE IR for a fire and back to plain satellite for everything else, so the
colours vanished the moment you clicked a quake or the tour moved on — which
reads, correctly, as the layer breaking. It only ever switches *to* the infrared
now. Choosing an optic is the operator's business; suggesting one for a fire is
ours.

**And the legend says where the detail stops.** NASA publishes this band
combination to zoom level 9 and no further, so below roughly 700 km eye height it
is the same pixels enlarged. That looks like a fault unless it says so, and it is
the price of imagery nobody has to license: *NASA caps this at ~300 m/pixel*.

## 0.42.1 — the layer works, the name lied

Confirmed rendering, and confirmed confusing. Three faults, all mine:

**BURN SCAR promised a scar.** What false colour mostly shows on any given day is
a continent of healthy vegetation, in green. Named for the hoped-for finding
rather than the measurement, it reads as a broken layer to anyone who was told
otherwise. It is **FIRE IR** now — a band combination, which is what it is.

**No key.** Green meaning vegetation and rust meaning burnt ground is not
guessable, and the honest first reaction to the layer without a legend was "it is
all green". A five-row key now appears with the optic and only with it: live
vegetation, burnt ground, active fire, water, cloud and snow.

**The detections were hiding the ground they exist to point at.** The entire
reason to look at this layer is the scar underneath, and a filled disc a dozen
pixels across covers it. Over FIRE IR they are rings now — still marking the
spot, no longer standing on it.

## 0.42.0 — something to actually look at

Fair objection: flying to a yellow dot is not a story. The briefing got the
camera to the right coordinates and left nothing on screen worth narrating.

**BURN SCAR**, a new optic: VIIRS short-wave infrared false colour from NASA.
Burnt ground reads dark rust, healthy vegetation bright green, an active front
glows orange — and crucially, SWIR passes through smoke. Verified by pulling both
tiles over the Northwest Territories front and looking at them: in true colour
the fire is *completely invisible* under cloud and its own smoke; in false colour
the scar cuts straight through. That comparison is the whole argument for the
layer.

**An imagery-day slider**, 0 to 10 days back. GIBS is date-addressed, so stepping
the day costs nothing but a different morning's tiles — which turns a brown patch
into a sequence: here is the scar now, here it is five days ago, here is the day
it started. That is the difference between a coordinate and something to talk
over. Only the NASA-backed optics move in time; over Esri's undated mosaic the
slider disables itself and says *not dated* rather than silently doing nothing.

**Optics follow the subject.** Clicking or touring onto a fire switches to BURN
SCAR; quakes and aircraft get the plain satellite view back, having nothing
infrared to show. A checkbox turns the behaviour off.

Also fixed: `loadFires()` and the briefing's first load ran during module
evaluation, a thousand lines above declarations they reach through
`applyVisibility()`. They worked only because the first `await` let the rest of
the module finish first — luck, not design, and the sort of thing that breaks the
moment anything is inserted above it. Both now run inside `start()`.

Not yet seen rendering. The tiles are proven — fetched, viewed, 200 with the
scar plainly visible — and the day arithmetic is proven, but the browser pane
used for checking is throttled while hidden and its globe would not stream tiles
from any source, NASA or Esri. Wants confirming in a real window.

## 0.41.0 — is anybody reporting this?

FIRMS says a place is hot. It never says whether anybody has noticed. Every
briefing event is now cross-referenced against **GDACS**, the EU Joint Research
Centre's alert system, which pools the official reporting — burnt area from GWIS,
impact from the seismic networks — for whatever has crossed an international
threshold.

Clicking an event, or touring onto it, now shows what the record holds: the alert
name, its level, and the reported severity in real units — *Green impact for
forestfire in 6637 ha*.

**Three states, worded to stay apart.** A match is reporting. A *nearby* entry
may be the same fire complex seen from its centroid or a different fire
altogether, so the distance is always shown and the judgement is left to whoever
is talking: the Canadian front matched an alert 149 km away, and that is stated
rather than smoothed over. A miss says **no international alert** — and that
phrase is doing real work. GDACS alerts above a threshold in hectares, so a local
fire service almost certainly knows about a fire GDACS has never heard of.
Saying "nobody knows about this" on air would be a lie, and an easy one to tell
by accident, so the caveat travels with the miss into the feed log.

The unlisted ones are drawn amber rather than red: an unreported fire is the
story, not an error. First run found three, including a 14 101 MW front of 607
detections on the Serbian border with nothing on record against it.

## 0.40.0 — Global Command View, and a mode for broadcasting it

Renamed throughout — window title, HUD, server banner, the two desktop shortcuts
and the scripts behind them. The folder was left alone at the time: renaming it
would have broken the shortcuts, the stop script's command-line fallback and
every cached path, for nothing a viewer could see. It moved later, when the
project got a repository of its own.

**PRESENT** hides the operator's half of the screen — panel, detail card, footer —
and leaves a title, a lower third naming what is on screen, and the source with
coordinates in the corner so the footage carries its own attribution. `P`
toggles, `Esc` leaves.

**TOUR** flies the briefing on a timer: six seconds of flight, twenty-two seconds
to talk over each shot, and the layer that shows the event switched on as the
camera arrives. Slow on purpose; fast camera moves look like a video game. It
reloads the briefing every eight minutes, so a stream left running overnight is
showing tonight's fires rather than the ones it started on.

The two are deliberately separate. Run the tour with the panel up while lining up
a shot; run PRESENT alone and fly by hand while narrating.

## 0.39.0 — a switch for commercial use

A monetised video is commercial use, and several sources here do not permit it.
**Broadcast > Commercial-safe sources** narrows the app to sources whose licence
is unambiguous, and remembers the setting across a reload so a recording never
resumes on the wrong ones.

What it withdraws, and why each:

| | |
|---|---|
| basemap, for NASA GIBS | Esri's imagery service and CARTO's tiles carry terms that plausibly restrict this |
| world terrain | ion Community tier is licensed for personal use |
| Cesium 3D buildings | same tier, same licence |
| photoreal 3D | Google Maps Platform has its own terms to read |
| Windy webcams | the free tier is link-and-embed only |
| planespotters hull photos | they ask for non-commercial use |

What stays, and why: our own Overpass building boxes, because OSM is ODbL, which
permits commercial use with the attribution already in the footer. Wikipedia type
photos, mostly CC BY-SA and credited on the card. FIRMS, USGS, CelesTrak,
TeleGeography, ADS-B, Digitraffic under CC BY.

**Nothing is withdrawn quietly** — each item is named in the feed log as it goes,
and a green SAFE badge sits beside the version so it is visible in the recording
itself rather than only in a menu.

The cost is resolution: GIBS stops at level 9, about 300 m a pixel, so this is a
mode for continental shots and not for streets. The optics survive it. They are
shaders over whatever imagery lies beneath, so THERMAL and FLIR still look like
themselves over daily VIIRS true colour — which for a live channel is arguably
better material anyway, since it carries today's cloud and today's smoke.

This is a switch that narrows the app to what a licence can be pointed at. It is
not legal advice, and the terms remain the operator's to read.

## 0.38.0 — a briefing, because finding the story is the hard part

Flying somewhere was never the problem. Knowing where to fly was. A new
**Briefing** section asks what is happening on earth right now and lists it;
clicking a line flies there and switches on the layer that shows it.

**Fires are clustered, and that is the whole point.** A single 200 MW detection
is as likely to be a gas flare as a forest. Four hundred detections sharing half
a degree is a fire front. So detections are binned into 0.5 degree cells, the
cells are ranked by *total* radiative power, and a cell holding fewer than eight
detections is dropped as a furnace rather than news. The first run found a
20 372 MW front of 2447 detections in the Northwest Territories.

Earthquakes come from the USGS week, ranked by magnitude — logarithmically, so
one M7 outranks a pile of M4s rather than losing to them on sheer count.
Military contacts come from the flight cache the app has already filled, so the
briefing costs no extra requests to build.

**The list interleaves the kinds instead of merging them.** Megawatts, magnitudes
and feet do not compare, and a single ordering would be a comparison nobody
made. Each kind is ranked internally and the list alternates between them; the
response says so in a `note` field.

## 0.37.0 — what the satellite is, and a picture of it

Clicking an object gave its orbit and nothing else: the elements say where a
thing is and never what it is for. Two open sources fill that in, looked up only
on selection, so browsing 16 000 objects still costs nothing.

**CelesTrak's catalogue** for identity: payload or spent stage, whose, launched
when and from where, still operational or not, international designator, and the
radar cross-section — labelled as an echo, because that is what it is rather than
a measurement of the spacecraft.

**Wikipedia** for a photograph and a paragraph on the mission.

The hard part was names. The catalogue shouts — `ISS (ZARYA)`, `SENTINEL-2A`,
`SL-16 R/B` — and Wikipedia's endpoint is case sensitive past the first letter,
so `SENTINEL-2` is a dead end where `Sentinel-2` is an article. One guess got it
wrong often, so several spellings are tried in order: hyphenated, as given,
sentence case, and with a trailing letter dropped to reach the family article.

**Three ways of being honest about what came back**, because the alternative is a
card that quietly implies the wrong thing:

- A constellation has one article between thousands of spacecraft, so a Starlink
  says *about the Starlink fleet, not this spacecraft*.
- A redirect to a broader page is marked *nearest article, not about this
  object* — `COSMOS 2221` lands on a list of Kosmos satellites, which is related
  and not a description.
- Debris and spent stages are never looked up at all. Searching for one returns
  something misleading rather than nothing, so the card says *a spent stage or
  fragment, so no mission*. The name decides this, not the catalogue: a record
  can be missing or stale, but `SL-16 R/B` is an upper stage regardless.

A disambiguation page counts as no answer — `TERRA` finds one and is rejected.

Also: `addField` no longer draws a row for a value that came back empty. A blank
field reads as a fact that failed rather than one that was never offered.

## 0.36.0 — wildfires

NASA FIRMS, the feed Worldview draws from: open CSV, no key, no registration.
Both VIIRS platforms — NOAA-20 and Suomi-NPP — at 375 m. MODIS is left out; at
1 km it would only add coarser duplicates of what those two already saw.

**They are thermal anomalies, and the layer says so.** A pixel much hotter than
its surroundings is usually a wildfire. It is also how a gas flare, a volcano, a
steel works and a farmer burning stubble look from orbit, and the bulk feed
carries no field that separates them — so the layer is *Thermal / fires (24 h)*
and the detail panel repeats it. Radiative power is the number that matters: a
few megawatts is a field, hundreds is a forest, and colour and size follow it.

Some 213 000 detections arrive worldwide. Kept as parallel typed arrays rather
than 213 000 tuples — about 4 MB instead of 45 — because the previous release was
spent teaching this server not to hoard. Measured: 0.2 s to parse both feeds,
66 ms to answer a viewport, and the global request is capped at the 4000 hottest.
**The cap is stated in the feed log**, since a screen showing 4000 of 212 962
must not read as a screen showing everything.

FIRMS is one of the few sources here with no restriction on use at all — open
data, attribution requested. It is in the licence table as such.

## 0.35.0 — the frame had no budget

The app hung. Measuring rather than guessing found the cost in three places, none
of them where it looked.

**Satellite propagation was over half the frame.** The code advanced a fixed
slice of 2000 objects per frame, with a comment estimating 2 ms. Measured on a
loaded machine: **9.39 ms** of a 16.7 ms frame, before Cesium drew a pixel. A
count cannot know how fast the machine is, so the sweep now runs to a deadline
and stops wherever it reached: **2.00 ms median, 2.20 ms worst**, about 1660
objects a frame, the whole catalogue every 13 frames. Staleness is 0.22 s, some
1.6 km at orbital speed — under a pixel from any altitude that shows an orbit.

**Nothing was ever hidden for being off screen.** A city view still carried every
contact on earth: 6760 aircraft, 4111 cameras, 1922 cable landings, 1087
vessels — **29 981 primitives**, all drawn, exactly when terrain and
photogrammetry want the machine. Contacts are now tested against the view
rectangle: over Stockholm at 3 km that is 20 aircraft and 358 cameras instead of
all of them. Zoomed out to the globe nothing is culled, which is the point of
being zoomed out. Cameras and landings never move, so they are culled when the
camera settles rather than every frame.

**Dead reckoning allocated a vector per contact per frame** — eight thousand
short-lived objects a frame, which is a collector pause every few seconds rather
than a frame rate. The result vector is reused now.

Also: the photorealistic tile cache went back from 1.5 GB to 512 MB. It was
greedy on a machine that also runs games, and it buys fewer refetches at the cost
of memory pressure — which shows up as stalls, not as a smaller number anywhere.
Detail is untouched; the cache decides what is kept, not what is fetched.

### The memory cache had no bound either

`_mem` is keyed by aircraft hull, by 100 m square, by road tile — all of which
grow with wherever you have been, and none of which were ever evicted. One day of
use had left **19 771 aircraft entries**, with a lock object each, held for as
long as the server ran. Both are now bounded and least-recently-used: read an
entry and it survives, ignore it and it goes. A lock that is currently held is
never dropped, or two threads would each get a fresh one and both fetch the same
URL. Tested: 40 written into a 10-entry budget keeps exactly 10, the newest
survive, a re-read entry survives later writes, and a held lock stays.

## 0.34.1 — the month is Google's month, not UTC's

The counter rolled over at midnight UTC. Google's free allowance resets at
midnight **Pacific**, seven or eight hours later, so for those hours the tally
would have read zero while Google was still charging against the old month —
exactly the window in which a counter meant to warn you would instead have
reassured you.

Months are now taken in US Pacific time, via `zoneinfo` where the machine has a
tz database and a written-out US DST rule where it does not, since Windows ships
none and the alternative was a dependency. Both paths were checked against each
other across the September and January boundaries and both DST switches.

## 0.34.0 — a counter for the Google bill

Under the **Photoreal 3D** switch: `n / 1000 free sessions used in 2026-08`,
amber from 800, red past 1000. It links to the Google console.

The billed request goes from the page straight to Google, so the server never
sees it and cannot count it. The page reports each one instead, and only after
the tileset actually arrives — a refused request is not billed and must not be
counted. Turning the switch off and on again does not count either, because the
tileset is reused; verified, the tally stays put.

Two honest limits, both in the tooltip. It counts what **this app** asked for,
since counting began: a session opened by anything else on the same key is
invisible to it. And it is not the bill — the console is, which is why the number
is a link.

## 0.33.1 — ask Google for the detail it already has

The photorealistic mesh ran at Cesium's default screen-space error of 16, which
stops a level or two short of what Google holds. It is now 8, with the tile cache
raised to 1.5 GB so the extra tiles stay put instead of being fetched twice.

This costs nothing. Billing counts root-tile requests — one per session — and
never the tiles streamed afterwards, so finer detail is bandwidth and memory
only.

It does not unmelt the cars. Photogrammetry is built by matching one aerial photo
against another, and anything that moved between the passes cannot be matched:
lorries come out smeared into the tarmac, and thin or shiny things — masts,
railings, glass — come out as lumps. That is in Google's data, at every level of
detail, and no setting reaches it.

## 0.33.0 — the descent knew nothing about terrain

Both Descent buttons were written when the world was a smooth ball at sea level,
and were never revisited once terrain and photogrammetry arrived.

- **DROP TO GROUND dropped to 320 m above the sea**, wherever the ground actually
  was. It asked `globe.getHeight()` for the elevation, which answers `undefined`
  until the tile under the camera has loaded — which, right after flying
  somewhere, is nearly always. `undefined || 0` then read as sea level. Over the
  Lysefjord plateau at 600 m that put the camera 280 m inside the rock.
- **STAND HERE stood in the wrong place.** `pickEllipsoid` follows the ray until
  it meets sea level, so on a slope the spot is not the one under the cursor —
  on a fjord wall it lands a few hundred metres past it, at height 0.

Both now go through `surfacePoint()`, which reads the depth buffer and so lands
on whatever is actually drawn: terrain, a rooftop, Google's mesh. Terrain
sampling and the ellipsoid remain as fallbacks, in that order, for the frame
where nothing has been rendered yet. The descent also logs the ground elevation
it found, so a wrong answer is visible rather than merely disorienting.

The standing eye takes whichever is higher, the picked surface or the finest
terrain sample. The depth buffer only knows the detail level currently drawn, so
picking a hillside came out about 2 m low — the eye began half a metre
underground and sank further as the tile refined. On a rooftop the picked
surface is still the higher of the two, so that case is unaffected. Measured
afterwards on the Lysefjord plateau: 1.70 m above ground.

## 0.32.2 — 127.0.0.1 and localhost are not the same site

The switch would tick and untick itself with nothing to show for it. The server
opens the app on `http://127.0.0.1:8820`, the SETUP steps said to allow
`http://localhost:8820/*`, and Google treats those as two different sites: the
tileset came back 403, the failure path unchecked the box, and the only visible
symptom was a switch that refused to stay on.

- The failure message now recognises a blocked referrer and prints the address
  the app is actually open at, so the fix is the sentence you are reading.
- SETUP asks for **both** origins.
- `googleBusy` is cleared in a `finally`. It was cleared on both paths already,
  but a throw anywhere else would have left it standing, and every later click
  would then have done nothing and said nothing.

## 0.32.1 — say what Google actually said

A failed photorealistic tileset logged `unavailable (undefined)`, which tells
nobody anything. Cesium throws a bare error; Google, asked directly, gives the
reason. So a failure now re-asks Google for the root tile and repeats its
complaint, and the overwhelmingly common one — the Map Tiles API was never
switched on — is translated into the four clicks that fix it. The SETUP steps now
warn that the *enable all Google Maps APIs* box at signup does not cover it.

## 0.32.0 — photogrammetry, if you want it

OSM buildings are footprints pushed up to their height, so a cathedral and a
tower block are the same object at different sizes. They read as grey boxes
because that is all the data is. The mesh in the WorldView videos is Google's
photogrammetry, where the roofs, the trees and the shadows are measured.

- **Google Photorealistic 3D Tiles**, behind a key of your own in SETUP. With
  one saved, a **Photoreal 3D** switch appears under Descent.
- **The globe hides while it is on.** The mesh carries its own ground, and two
  surfaces in the same place fight for the pixels. So the imagery styles and the
  ground-clamped overlays — cables, roads, the CCTV projection — stand down until
  the switch goes back off. The feed log says so when you flip it.
- **One request per session, on purpose.** Google bills the Photorealistic 3D
  Tiles SKU per *root tile request*, not per tile, and one buys three hours of
  streaming. 1000 a month are free. The tileset is therefore built the first time
  the switch is turned on and never rebuilt: flying, reloading layers and
  toggling it off and on again all cost nothing further. Never touching the
  switch costs nothing at all.

Google requires a card on the account even for the free tier. Nothing here is
enabled without a key, and the OSM buildings remain the default.

## 0.31.0 — real ground

Two changes toward the ground detail in the WorldView videos.

- **The imagery cap was self-inflicted.** Esri was asked for level 18 at most.
  Level 19 is served almost everywhere — verified over Stockholm — so the cap is
  19 now and close-up views are twice as detailed in each direction. Level 20
  exists in places (Newport News has it) but returns a grey "no data" tile
  elsewhere, which looks worse than upsampling, so it stays out.
- **Cesium ion support.** Its Community tier is free for personal, non-commercial
  use and carries **world terrain** and **worldwide 3D buildings**. With a token
  in SETUP the earth stops being a smooth ellipsoid: hills are hills, the
  standing viewpoint puts you on the hillside rather than inside it, and the CCTV
  projection drapes over terrain and buildings instead of lying flat — which is
  what that chapter of the video is showing.

All of it is inert without a token; the flat globe is still the default and the
**World terrain** switch turns it back off.

## 0.30.1 — the tip link is fixed in the app

The link is hardcoded to the author's page and always shown. The settings field,
the config file and the endpoint behind them are gone — a copy handed on carries
the link with it, which is the point of it.

## 0.30.0 — a tip link, set from inside the app

A coffee link at the foot of the panel, reading *If you like it, buy me a
coffee* — the wording is deliberate, since a tip that is asked for rather than
offered turns the app into a sale and breaks four of the licences.

It is set in **SETUP**, not in the code, so a copy passed on can carry its new
owner's link instead of the old one — and it is **hidden entirely when unset**,
so nobody inherits a dead link or a request to pay the wrong person. Only http
and https are accepted; a `javascript:` URL in that field would be a hole in a
page that already talks to a local server.

## 0.29.0 — sources and licences, written down

A third guide tab lists all twenty feeds with what each licence allows, and marks
the four that are non-commercial only: Esri imagery, OpenSky, planespotters and
Windy's free tier. Handing the app to someone hands them these obligations too,
so they should be able to read them without asking.

The tab states the distinction that actually matters: a voluntary tip is not a
sale, but a payment somebody has to make to get the app or unlock a feature is —
whatever it is called — and that is what breaks those four terms.

`LICENSE` covers the code as MIT and says plainly that it grants nothing over the
data the app draws.

## 0.28.1 — the photo credit was incomplete

Reading the source licences turned up a term the app was not meeting:
planespotters require the thumbnail itself to link to that photo's page on their
site, not merely to name the photographer. Clicking an aircraft photo now opens
its page there; every other picture still opens the zoom viewer, since nothing
ties those to a page.

## 0.28.0 — help and setup, for handing it to someone else

Two tabs in the top bar.

- **HELP** — the whole app explained in order: moving around, layers, detection,
  optics, what clicking gives you, going down to street level, the ruler and
  marks, and how to read every field in the top bar. It closes with what is a
  real observation, what is modelled, what is estimated, and what is not tracked
  at all — because that distinction is the point of the thing.
- **SETUP** — the four services worth an account, what each one adds, numbered
  steps to get the key, and a field to paste it into. Saving writes `keys.json`
  and takes effect immediately: no restart, no text editor, no file paths.

The page is never told a key, only whether one is set — the endpoint returns
booleans, values are never logged, and the server listens on localhost only.
Empty values and unknown fields are ignored rather than written.

On a machine that has never run it, the guide opens by itself once.

## 0.27.1 — photographs of ships

Vessels get a photograph on selection, the way aircraft do — but from a different
kind of source. There is no planespotters for shipping; Wikimedia Commons has a
great many ship photographs, searchable only by name.

That looseness had to be handled rather than hidden. Searching for the cargo ship
**LUCA** returned a photograph of a lion, taken by Luca Galuzzi: the name was in
the file title, so a name check alone accepted it. A candidate is now taken only
when the file title opens with the ship's name, or reads like shipping somewhere
in it. The card carries the file title, the licence and the photographer, so the
match can be judged rather than trusted.

Verified: Frej, Oden, Viking Grace and Silja Serenade resolve to real photographs
of those ships; Luca, Trucken and Marcela Rose honestly return nothing.

## 0.26.1 — cables stop sliding, wakes stop costing

- **The cables were drawn 6 km above the seabed**, to keep them off the globe
  surface and out of z-fighting. Six kilometres of altitude is six kilometres of
  parallax: tilt or zoom and the line slid across the water, so the junctions
  appeared to move. They are `GroundPolylinePrimitive` now — genuinely clamped to
  the ground — and the landing points sit at height 0 instead of floating with
  them.
- **Wakes are capped at the 150 vessels nearest the middle of the view.** Drawn
  for all 700 they cost 30 ms a frame, which is most of a frame budget for
  something only legible near the camera.

## 0.26.0 — course vectors and wakes

Ships carry a line showing where their present course and speed put them in ten
minutes, and optionally a wake of their last eight reported fixes.

Both are rebuilt on the poll rather than on the frame — a projection from a fix
only changes when a new fix arrives, so redrawing it sixty times a second would
cost sixty times as much for the same picture. Measured: rebuilding 259 vectors
takes 2–4 ms, once every 20 seconds, and adds **1.8 ms per frame** to draw.

## 0.25.2 — the imagery date can go stale too

The acquisition date was cached for the life of the server process with no expiry.
Imagery tiles come straight from Esri and update by themselves, so a server left
running for weeks would have gone on reporting the old capture date for a picture
that had already been replaced underneath it. Seven-day expiry now.

## 0.25.1 — a picture even when nobody photographed the hull

Selecting a Swedish police helicopter gave an empty panel: planespotters simply
has no photograph of that airframe, and the card said nothing at all about why.

- **Type photo fallback.** With no photo of the hull, the card shows the model
  from Wikipedia, labelled `Type photo · Bell 429 GlobalRanger — not this
  airframe`. A picture of the model is more use than a blank panel, as long as
  nobody can mistake it for the aircraft in question.
- **Silence became an answer:** with nothing at all to show, the card now says
  *none published for this airframe*.
- The registry is thin outside the big fleets — adsbdb knew neither SE-JZF nor
  SE-JRJ — so the type code that arrived over the air is used first, and ICAO
  designators are mapped to real names because searching an encyclopaedia for
  "AS50" finds nothing.

Verified: SE-JZF (AS50) resolves to Eurocopter AS350 Écureuil, and B429 — what
the Swedish police fly — resolves to Bell 429 GlobalRanger.

## 0.24.0 — the panel folds

Ten layers and six tool blocks stopped fitting on screen. Every section now folds
from its heading, the panel scrolls as a backstop, and which sections you keep
open is remembered. Folded headings still carry a tally — `Layers 10/10`,
`Marks 2`, `Jump to 7` — so a shut section still tells you what is inside it.

With everything folded the panel measures 654 px against 654 px of room: it fits
exactly, and nothing is unreachable at any window size.

One trap worth recording: `#marks` and `#log` set `display` through id selectors,
which outrank a class-based fold rule on specificity, so those two sections kept
their contents visible while claiming to be folded.

## 0.23.0 — submarine bases, and rescue services recognised

- **Submarine bases** as their own layer: 16 bases across six navies, with the
  classes open sources report as home-ported there. Coordinates come from
  Wikipedia rather than memory, except Rybachiy where the pier area was read off
  the imagery directly. This is the honest shape of the problem — submarines do
  not broadcast and nothing tracks them, so the layer marks where they live and
  hands the work to the ruler and the imagery date: count what is alongside,
  measure it, note when the picture was taken.
- **Coastguard and rescue operators** are now recognised. `SE-JRJ` came back as
  *Swedish Maritime Administration* — a search-and-rescue AW139 — and fell
  through every pattern, so maritime administrations and rescue services were
  added to the classifier.

## 0.22.0 — state aircraft as their own layer

Police, medical, coastguard and military aircraft moved out of the air layer into
a **Police & state air** layer of their own with its own count, so turning off Air
traffic leaves exactly those on screen and nothing else — the same way Capital
ships works.

## 0.21.0 — helicopters, and who owns them

ADS-B says a hull is at a position; it never says what the hull is. adsbdb keeps
the civil registry, so slow low contacts are now resolved against it — up to 20
per sweep, cached forever, since registry entries do not change.

- **Rotorcraft** are recognised from the ICAO type designator and drawn with a
  rotor glyph instead of the aircraft chevron.
- **Operators are read, not guessed.** The registry's owner field is matched
  against police, military, coastguard and medical wordings in the languages it
  uses, and the contact is coloured and designated accordingly: `POL-BPO410`
  rather than a callsign that merely looks official. The detail card names the
  operator outright.

Verified against live traffic: Bundespolizei D-HEGF and German Police D-HNWV came
back as police, ANWB Medical Air Assistance as medical, Royal Air Force and French
Air Force as military, Garda Air Support Unit as police. A private Hughes 500 came
back as private, which matters as much.

## 0.20.1 — start and stop icons

Two desktop shortcuts, so the app no longer needs a typed command: a cyan globe
that starts the server and opens the browser, and an amber one with a stop mark
that shuts it down. Both point at `.cmd` files in the app folder, with icons
drawn from the HUD's own mark.

Two things that had to be fixed to make them reliable:

- `timeout /t` refuses to run when a script is started without a console of its
  own, so the pauses use `ping` instead.
- The stop script matched python processes by command line, and the start script
  ran `python server.py` from its own folder — with no path on the command line
  to match. Stop now asks who is listening on port 8820, which is the one
  authoritative handle, and keeps the command-line sweep as a fallback.

Also: the changelog entries had drifted out of order and are sorted by version
again.

## 0.20.0 — marks kept on disk

Marks were in localStorage, which is scoped to the exact origin: starting the
server on 8821 instead of 8820 makes a browser swear you never saved anything.
They now live in `data/marks.json` next to the carrier file, written through a
small POST endpoint — port, browser and cleared site data no longer matter.

Anything already in the browser is migrated on first run, and the browser copy is
kept as a mirror so the pins still draw if the server write fails, with a warning
in the log rather than silence.

## 0.19.0 — a ruler and saved marks

- **MEASURE DISTANCE**: click points on the globe and get the geodesic surface
  distance of each leg and the running total, drawn with labels on the map. It
  measures on the ellipsoid rather than in screen pixels, so it stays honest at
  any latitude and zoom. Checked against known values: 0.01° of latitude reads
  1.11 km, and 1° of longitude at 52.9°N reads 67.26 km.
- **Marks**: name the view you are looking at and come back to it. A mark stores
  the whole camera — position, height, heading and pitch — so returning gives you
  the view rather than a spot on a map. They persist in the browser, appear as
  cyan pins on the globe with their names, and are removed with the × in the list.

## 0.18.0 — how old is what you are looking at

The satellite basemap is a mosaic of scenes flown years apart, and nothing on
screen said so — two carriers at a pier can be two carriers that were there
eighteen months ago. Esri publishes an acquisition date per scene, so the top bar
now carries **IMG 2025-02-14 · 15 cm**, with the provider and the age in the
tooltip and the badge turning warm when the picture is over two years old.

Measured while building it: Newport News is 14 February 2025 at 15 cm (Virginia
Orthos), Stockholm 14 June 2025 at 50 cm, Dubai 23 November 2025 at 50 cm (WV02).

Esri sends the date as M/D/YYYY; parsing it and formatting through
`toISOString()` shifted it a day backwards for anyone east of Greenwich, which is
how the badge first read 2025-02-13.

## 0.17.1 — a photo of the ship

Capital ships get a photograph and a line of history the way aircraft do, from
Wikipedia — US Navy photographs are public domain, so the encyclopaedia is the
free source for what a hull actually looks like. Clicking the picture opens the
full-resolution original in the zoom viewer rather than the thumbnail.

One wrinkle worth noting: *USS Makin Island* alone resolved to a disambiguation
page with no image, because there have been two of them. The hull number in the
title fixes it — `USS_Makin_Island_(LHD-8)`.

## 0.17.0 — capital ships, honestly estimated

- **Carriers and amphibious assault ships** as a layer: 5 CVNs and 4 LHA/LHDs,
  each drawn with a **dashed ring showing how little we actually know**. Abraham
  Lincoln is somewhere in 450 km of Arabian Sea, not at a point.
- Carriers do not broadcast AIS and no feed publishes their positions. The source
  is the U.S. Naval Institute's weekly Fleet and Marine Tracker, which states
  operating areas from Navy and public reporting. It sits behind Cloudflare, so
  the server cannot scrape it: the data lives in `data/carriers.json` with its
  source URL and date, and is refreshed by reading the newest tracker and editing
  the file. The detail card carries the as-of date so an old estimate cannot pass
  for a live one.

## 0.16.1 — the detection labels stop churning the GPU

Detection mode rebuilt every reticle and label from scratch twice a second —
`removeAll()` followed by up to 120 fresh labels. That grinds Cesium's label
texture atlas continuously, which is a good way to walk GPU memory upwards until
the renderer is killed. The pool is now allocated once and reused: positions,
text and colours are overwritten in place and unused slots are hidden. Over 20
seconds of hard detection the heap fell from 106 MB to 87 MB where it used to
climb.

Also: a lost WebGL context now says so in the feed log and on the banner instead
of leaving a blank canvas with no explanation.

## 0.16.0 — CCTV projected onto the ground

- **PROJECT ONTO GROUND** on any camera: the live frame is laid on the earth as a
  textured footprint spreading from the station, with a dashed coverage cone.
  Verified on Trafikverket's Lindhov camera over the E4/E20 — real queuing traffic
  painted onto the map.
- **Calibration panel**, because the public feeds carry no orientation at all: a
  road camera publishes where it stands, never where it looks. Heading, field of
  view and range are sliders, and `SAVE CAL` remembers the setting per station in
  the browser, so a camera you have aimed once stays aimed.
- Two things learned the hard way while building it: `classificationType` needs a
  terrain provider and silently draws nothing without one, and entity geometry is
  only built by `viewer.render()`, not `scene.render()` — which had the footprint
  invisible in testing while it was fine in the app.

## 0.15.0 — street traffic

- **Simulated traffic** on the real road network: OSM centrelines become track,
  and agents drive them at each road's own speed limit, labelled `VEH-0023
  Klaratunneln` in detection mode. 729 segments in one central Stockholm tile,
  255 vehicles. The layer is named *Street traffic (sim)* and the detail card
  says "modelled, not observed", because it is a model — no public feed carries
  individual cars.
- Cars **drive through junctions** rather than teleporting. The first version
  respawned each vehicle at a random segment when it ran off the end, which read
  as blinking dots; they now pick a street that touches the corner and continue.
  Measured: 70 m travelled in 5 s at 49 km/h, against 68 m expected.
- **Overpass mirrors with a circuit breaker.** The main instance went down
  mid-build. Three fixes came out of it: mirrors are tried in turn; a mirror that
  answers *empty* is not believed (overpass.osm.ch serves only Switzerland and
  was silently poisoning the cache with blank tiles); and when every mirror is
  down the server stops trying for five minutes instead of holding its request
  slots for 100 seconds each, which had been starving even requests that only
  needed the cache.

## 0.14.0 — seismic, night vision, FLIR

Working through the feature list the WorldView author published for his own build.

- **Seismic layer** from USGS: every quake worldwide, magnitude 2.5 and up, over
  the last week — 430 of them right now. Marker size follows magnitude, colour
  follows depth (shallow quakes are the destructive ones). Clicking gives
  magnitude, depth, place, time, felt reports and any tsunami warning. Free, no
  key, refreshed every 10 minutes.
- **NIGHT VIS** and **FLIR** optics, as real post-process passes rather than
  colour grades: the scene is reduced to luminance and remapped onto the sensor's
  palette — phosphor green with halation, grain and vignette, or the black-red-
  orange-white thermal ramp.

## 0.13.3 — version beside the title

The build stamp moved from the panel footer to a chip next to the app name in
the top bar, where you actually look. Hovering it shows the build date and which
optional keys are active.

## 0.13.2 — an empty sea says why

The vessel layer follows the view now, so panning out of the Baltic drops the
count to zero — which looks like a fault and is not one. The feed log spells out
the reason instead: `sea: 0 in view · outside the Baltic — aisstream connected,
0 messages so far`.

## 0.13.1 — aisstream connected, but silent

The key is in and the subscription is accepted; no messages arrive. What the
diagnosis established, in case it is picked up later:

- The WebSocket client itself is sound — it echoes correctly against
  `wss://ws.postman-echo.com/raw`.
- aisstream closes a connection after 3.5 s if no subscription arrives, and after
  0.6 s if the API key is wrong. Ours is held open indefinitely, so the key is
  recognised and the subscription is accepted.
- No data in any variant: Gulf of Finland, Strait of Hormuz, the whole planet,
  both corner orders, with and without `FilterMessageTypes`.

That points at the account rather than the code — most likely the key needs
activating or the email confirming on aisstream.io. The stream now says so in the
feed log after a minute of silence instead of just sitting there, and moves its
subscription on the open socket rather than reconnecting.

## 0.13.0 — the sea layer, rebuilt for the world

- **Worldwide AIS support** via [aisstream.io](https://aisstream.io/), which
  publishes decoded AIS over a WebSocket rather than as a REST feed. A background
  thread holds the connection, subscribes to the box you are looking at, and keeps
  a table of what is afloat there. The WebSocket client is written against socket
  and ssl — no third-party packages. Needs a free key; **untested until one is in
  keys.json**.
- **Vessels now follow the view** like the other layers, and the server does the
  merging: Digitraffic where it reaches, aisstream everywhere else, with the
  richer record winning. The feed log names the sources that contributed.
- **Fixed:** the Baltic feed was never filtered against the view, so looking at
  the Strait of Hormuz reported 1 000 contacts — all of them in Finland.
- Ship type classification moved to the server, so both feeds are labelled the
  same way.

## 0.12.0 — the whole sky at once

- **OpenSky credentials are in and working.** One call now returns the entire
  planet: 13 078 aircraft from a full-globe view, 4 000 credits a day instead of
  400 anonymous. No more 250 nm circles, no more sampling, no more zero over the
  Atlantic.
- **Both networks when you zoom in.** OpenSky and the community feeders see
  different aircraft — over the Strait of Hormuz OpenSky had 36 and adsb.fi 68. On
  a tight view (under 8° of latitude) the server takes one adsb.fi circle on top
  of the OpenSky snapshot and merges what is new. Hormuz went to 83; the feed log
  says `opensky + adsb.fi` when both contributed.

## 0.11.0 — the air layer stops reading zero

- **Fixed: adsb.fi answered 429 Too Many Requests.** The circles covering a wide
  view were fired back to back; adsb.fi allows roughly one call per second. They
  are paced 1.2 s apart now, and a failed circle waits before the next one.
- **Fixed: the circles started in the south-west corner** of the view, so a wide
  view spent its whole call budget on empty Southern Ocean. They are now sorted by
  distance from the centre of the view — the part you are actually looking at.
- **Honest empties.** A wide view cannot be covered by 250 nm circles, so the
  response says how much was sampled and the feed log spells it out:
  `sampled 8×250 nm around centre — zoom in for the rest`. Zero over the mid
  Atlantic is the truth, not a fault.
- **OpenSky credentials** (`opensky_client_id` / `opensky_client_secret` in
  keys.json) are used when present: OpenSky answers a single call for the whole
  planet, which is the only way a global view can be complete. Untested — needs an
  account.

## 0.10.0 — street level and standing viewpoints

- **Street-level photos** from [KartaView](https://kartaview.org/), the open
  equivalent of Street View — no key, no quota. Photos load around wherever you
  descend (below 4 km) and appear as little arrows pointing the way the camera
  faced. Click one for the full frame, which opens in the zoom viewer. Verified in
  central Stockholm: 8 photos, one of them 2448×3264, shot 2016-07-21 facing 295°.
- **STAND HERE.** Arm the tool, click a spot, and the camera stands there at eye
  height — 1.70 m. Dragging turns your head instead of orbiting the globe,
  the wheel is a zoom lens (6°–90° field of view), Esc lifts you back out. The
  readout shows position, heading and FOV.
- **Fixed:** at street level the sky filled with Starlink designators. Orbital
  contacts only enter detection mode above 5 km eye height now.

## 0.9.0 — worldwide air, aircraft dossiers, cameras where you look

- **Global air traffic.** adsb.lol's feeders are almost all European and North
  American: it answered with literally nothing over the Gulf, Japan or South
  America. The fallback is now adsb.fi, which has real global coverage but serves
  at most a 250 nm circle per call, so a wide view is stitched from a grid of up
  to six of them. Hormuz went from 0 to 96 contacts.
- **Aircraft dossier** on selection: a photo of the actual airframe from
  planespotters (with photographer credit) and the scheduled route from adsbdb.
  The route is drawn on the globe — solid from origin to where the aircraft is
  now, dashed onward to destination, both airports labelled. Verified on SWR40:
  HB-JNL, B77W, ZRH Zurich → LAX Los Angeles, Swiss International Air Lines.
  Both lookups happen only when you click, so browsing thousands of aircraft
  costs nothing.
- **Cameras follow the view.** The fixed networks still load whole, but Windy's
  70 000 webcams now arrive a viewport at a time — one lookup per whole degree of
  view centre, cached for a day. Tokyo added 43 on arrival.
- **Fixed:** with detection mode on, clicking a labelled contact selected nothing.
  The reticle sits on top of the contact and was swallowing the click; it now
  carries the same identity as the target it marks.

## 0.8.0 — follow a contact, work the cameras

- **FOLLOW** on any moving contact — aircraft, vessel or satellite. The camera's
  reference frame is rebuilt from the target every frame and the camera re-seated
  at the same offset inside it, so the target stays locked at screen centre while
  the mouse can still orbit and zoom around it. Verified: aircraft ACA90 moved
  1.67 km, camera moved 1.68 km, target held at (640, 360) throughout.
  (`lookAtTransform` with no offset preserves the camera's *world* position, which
  looks exactly like following doing nothing — that was the first attempt.)
- **All camera directions.** A Finnish station is usually several cameras pointing
  different ways; every direction is now kept and cycled with ‹ › in the detail
  card. Inkoo kt51 has three.
- **Camera zoom.** Click any camera image for a full-screen viewer: scroll to zoom
  (50–1200 %), drag to pan, Esc or click to close.

## 0.7.0 — version stamp

- Version and build date in the HUD footer, the server banner and `/api/version`.
- This changelog.

## 0.6.0 — military traffic and API keys

- **Military aircraft** tagged from adsb.lol's register of airborne military hex
  codes, refreshed every 2 minutes, applied whichever air feed produced the
  picture. Drawn red, a size larger, designated `MIL-`, and always winning their
  cell in detection mode. Verified: 44 of 2 479 contacts, including GAF942 (German
  Air Force A350, reg 10+03).
- **Optional API keys** in `keys.json` (gitignored), with `keys.example.json` as a
  template.
- **Trafikverket**: 1 528 Swedish road cameras. Images use `?type=fullsize` —
  the bare URL serves a 10 kB thumbnail, fullsize is 1280×720.
- **Windy**: ~1 000 webcams. The free tier stops paging at ~1 050 and an
  unfiltered pull returns mostly Alpine webcams, so `WINDY_REGIONS` spends the
  budget on country buckets for a global spread.
- Camera layer no longer disappears above 4 000 km eye height; the networks read
  as a coverage map from orbit.

## 0.5.0 — detection mode, CRT optics, ground level

- **Detection mode** with reticles and designators, one contact per screen cell so
  labels do not pile up at the crosshair, and a density slider (8–120).
- **CRT optics** as a real post-process pass: barrel distortion, phosphor scan
  lines, chromatic separation, vignette.
- **Ground level**: camera descends to 1.5 m, `DROP TO GROUND` button, and OSM
  building footprints extruded by `building:levels`, fetched from Overpass a
  0.01° tile at a time, nearest first, three requests in flight.
- Telemetry readout (visible / candidate contacts, density, pass time) and an
  `UNCLASSIFIED // OPEN SOURCE // PUBLIC FEEDS ONLY` banner.

## 0.4.0 — satellites

- **16 076 objects** from CelesTrak orbital elements, propagated in the browser
  with SGP4 against the wall clock: 2 000 objects per frame, whole catalogue every
  ~150 ms. Verified against the ISS: 418 km, 7.66 km/s, 92.9 min.
- Full revolution drawn as a track for the selected object, which is enlarged and
  ringed.
- CelesTrak answers 403 when its data has not changed since your last download;
  that is now treated as "use the cache" rather than a failure.

## 0.3.0 — more cameras, no more stale pages

- **London**: 787 TfL JamCams merged into the camera layer, which now normalises
  every network to `{id, name, area, lat, lon, image, source}`.
- Static files served with `Cache-Control: no-cache` — a cached `index.html` had
  been silently dropping new `<script>` tags.

## 0.2.0 — the air layer stops dying

- **adsb.lol fallback** when OpenSky's anonymous quota runs out (it answers 429
  with a retry hint in hours). The HUD log names whichever feed is live.
- Registration and ICAO type carried through as extra state-vector fields.
- Server opens the browser itself, and explains a busy port instead of throwing a
  traceback.

## 0.1.0 — first working build

- Photorealistic 3D globe with live air traffic (OpenSky), Baltic AIS vessels and
  Finnish road cameras (Digitraffic), and the TeleGeography submarine cable map.
- Caching feed proxy — the upstreams send no CORS headers and are all rate
  limited.
- Cesium primitives rather than entities, so thousands of contacts stay
  interactive, with dead reckoning between polls.
- OPS / THERMAL / SATELLITE optics and clickable detail cards.
