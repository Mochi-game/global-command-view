# Global Network — architecture review

Phase 1. No code has been changed. Everything below was measured in this
repository or probed against the live services on 2 September 2026, and where a
thing could not be verified it says so.

---

## 1. The application as it actually is

| | |
|---|---|
| **Frontend** | Vanilla JavaScript. No framework, no build step, no npm. `web/app.js` 10 633 lines, `web/index.html` 1 419, `web/style.css` 1 671. |
| **Third-party JS** | CesiumJS 1.132 and satellite.js 5.0, both classic `<script>` tags from unpkg. Not ES modules — top-level `const` never reaches `window`, which is why `viewer` is unreachable from the console but `renderMarks` is. |
| **Backend** | `server.py`, 7 647 lines, `ThreadingHTTPServer` + `SimpleHTTPRequestHandler`. **Python standard library only.** No `requirements.txt`, no `package.json`, no `pyproject.toml`. |
| **Tests** | `smoke.py`, 929 lines, 19 `check_*` functions: brace balance, string balance, layer grouping, every layer in a group, cache behaviour, placeholders, trust script, certificate warm-up, CA fallback, licence text, plus a live pass over every endpoint. |
| **Helpers** | `aprs.py` (214), `aisstream.py` (239). |
| **Tracked files** | 42. |

Zero dependencies is not an accident of this project, it is its distribution
story. Days went into the install: Mark-of-the-Web unblocking, the Windows
certificate warm-up, the bundled CA fallback, the macOS Gatekeeper note, the
hidden console window. **Every one of those breaks the moment the app needs
something installed alongside it.** That constraint governs most of what
follows.

### Endpoints

61 GET endpoints under `/api/`, four writable POST endpoints
(`/api/marks`, `/api/keys`, `/api/usage`, `/api/manual`).

```
aeroway aircraft aircraft-types airfield airports airquality aprs borders
briefing broadcast buildings cameras cameras-nearby carriers copernicus entity
fires fishing flights forecast geocode headofstate imagery-date incidents
infrastructure ion-token keys kiwisdr launches manual marks mesh metar navaids
netoutages newsheat openwaters outbreaks place powerplants radar recon runways
satellite search ship smhi spaceweather stations streetview submarine-bases
sweden-rail sweden-road taf tomtom train trains usage vessel-photo vessels
volcanoes weather
```

### Layers

44 layers in ten groups: Radio, Aviation, Moving, Earth, People,
Infrastructure, Reference, Ground change, Above, Sweden.

### AI

**There is none.** Grepping the source for `openai`, `anthropic`, `claude`,
`gpt-`, `llm`, `gemini` returns two comments about *OpenAIP*, an aviation data
provider, and nothing else. Section 15 of your brief therefore has nothing to
reuse — it has to be an architecture that an assistant can be attached to later.

---

## 2. Storage, and the database question (§18)

**There is no database.** Storage is three things:

1. **`data/*.json`** — small, hand-editable, committed or gitignored:
   `marks.json` 2.8 kB, `carriers.json` 3.8 kB, `sea_areas.json` 15.5 kB,
   `submarine_bases.json` 4.4 kB, `usage.json` 258 B.
2. **`.cache/`** — flat key-named JSON files. **26 734 of them right now**,
   swept by a byte budget and a file-count ceiling, oldest-and-smallest first.
3. **An in-memory LRU** — `OrderedDict` under a byte budget, with per-key locks.

### Recommendation: SQLite, and not any of the three options you listed

You asked me not to change the database just to add graph features, and to
recommend from the real architecture. The real architecture says: **do not
introduce a database server.**

- **Neo4j** — a JVM service to install, run and keep running. It ends the
  zero-dependency install outright.
- **PostgreSQL + recursive CTE** — a server to install and a role to create.
  Same objection, one notch smaller.
- **PostgreSQL + Apache AGE** — an extension compiled against a specific
  Postgres. Worse than plain Postgres for this project.

**Python ships SQLite in the standard library.** Verified on this machine:

```
python       : 3.13.2
sqlite3      : 3.45.3   (stdlib — nothing to install)
recursive CTE: works    [(1,0), (2,1), (3,2), (4,3)]
FTS5         : available
```

A recursive CTE is exactly the traversal primitive a hop-limited graph needs,
and it has been in SQLite since 2014, so it is safe against the Python 3.9
floor the macOS note promises. One file in `data/`, no server, no port, no
install, nothing new in the ZIP.

Two cautions:

- **FTS5 is not guaranteed** on every user's Python build even though it is
  present here. Treat it as an accelerator for name search with a `LIKE`
  fallback, never as a requirement.
- **Do not depend on the JSON1 functions.** They are only reliably built in
  from SQLite 3.38 (2022), and a user on an older Python may not have them.
  Store JSON as text and parse it in Python.

Move to a graph database only if a measurement says so — and at the sizes in
§7 of your brief (50, 150, a few hundred nodes) nothing will.

---

## 3. What already exists that this feature needs

This is the most important finding of the review, and it changes the size of
the job.

### `entity_graph()` — `server.py:2987`

A one-hop entity lookup against Wikidata already exists and is already wired
to `/api/entity`, already cached for seven days in both memory and on disk,
and already reachable from the UI as a **LOOK UP** chip inside the detail card
(`web/app.js:2986`).

It searches `wbsearchentities`, fetches the item, walks twelve properties, and
resolves every referenced Q-number in one further call rather than one each:

| Property | Meaning |
|---|---|
| P31 | is a |
| P17 | country |
| **P749** | **parent** |
| **P127** | **owned by** |
| **P169** | **chief executive** |
| P159 | headquarters |
| P452 | industry |
| **P137** | **operator** |
| P1128 | employees |
| P571 | founded |
| P856 | website |
| P414 | listed on |

Five of those twelve are already ownership and control relations. **This is a
graph query with the graph thrown away** — the result is flattened into a list
of label/text pairs for a `<dl>`, and nothing is stored.

### `WIKIDATA_SPARQL` — `server.py:2452`

Full SPARQL access is already wired and already used, by `head_of_state()`.
SPARQL is what makes multi-hop and qualified ownership possible — the
percentage on an edge in your §9 lives in a `P1107` qualifier, which the
current property walk cannot see but a SPARQL query can.

### Identifiers already flowing through the app (§19)

**MMSI** and **IMO** (vessels), **ICAO hex**, **registration** and
**callsign** (aircraft), **NORAD** (satellites), **ICAO/IATA** (airports),
**Wikidata QID** (`entity_graph`). Five of the identifier families in your §19
are already in the data path. Missing: LEI, CIK, ISIN, ticker, national
company registration numbers.

### Dossier functions that already resolve an object to a description

`satellite_dossier()`, `aircraft_dossier()`, `ship_summary()`,
`vessel_photo()`, `head_of_state()`. These are entity resolvers by another
name.

---

## 4. What can be reused as-is

| Component | Where | Use in Global Network |
|---|---|---|
| `cached(key, url, mem_ttl, disk_ttl)` | `server.py:528` | Every registry fetch. Memory → disk → network, already tuned. |
| `fetch()` + `USER_AGENT` + cert fallback | `server.py` | One HTTP path that already survives the Windows certificate problem. |
| Nominatim politeness pattern | `server.py:1619` | `NOMINATIM_GAP` + a lock. Copy it per rate-limited registry. |
| `showDetail(title, kind, fields, image, follow, views)` | `app.js:4132` | The investigation panel in §27 is this function with a different field list. |
| `LAYERS` registry, `applyVisibility()`, `setCount()`, `whileOn()` | `app.js:483` | Filters in §26 are the same mechanism. |
| Marks: `write_marks()`, `/api/marks`, `renderMarks()` | `server.py`, `app.js:4694` | Saved Investigations (§24) is marks with a bigger payload. Same lock, same file discipline, same mirror-to-localStorage trick. |
| `usage.json` + `bump_usage()` | `server.py:947` | Per-source request budgets, and the "Google spend" meter is the model for showing them. |
| `log(message, level)` | `app.js:16` | Every count, every empty answer, every refusal. |
| `smoke.py` | — | New code must pass it, and it should grow checks for the new subsystem. |
| Camera flight (`viewer.camera.flyTo`), `standing`, marks | `app.js` | §12 *Locate on map* is already built; it needs a caller. |

---

## 5. Data sources — probed, not assumed

Every candidate in your §5 was called once from this machine on 2 September
2026, keyless, with the project's own User-Agent.

### Answers now, no account

| Source | Result | Licence |
|---|---|---|
| **GLEIF** (LEI records) | 200 in 0.32 s | CC0 |
| **Wikidata SPARQL** | 200 in 0.26 s | CC0 — already wired |
| **OFAC SDN** (Treasury CSV) | 200 in 1.51 s, real rows | US public domain |
| **USASpending** | 200 in 0.83 s | US public domain |
| **World Bank** | 200 in 0.37 s | CC BY 4.0 |

These five are the realistic MVP. GLEIF plus Wikidata alone covers
*company → legal entity → parent → country*, with a stable identifier on
every node.

### Needs an account

| Source | Result | Note |
|---|---|---|
| **OpenCorporates** | 401 — invalid API token | Their terms are the restrictive ones in this list. Do not design around it. |
| **OpenSanctions** | 401 — no API key | Free tier exists for non-commercial use; needs checking against your intent to accept donations. |
| **UK Companies House** | 401 — empty Authorization | Key is free. Straightforward. |

### Reachable but not yet working

| Source | Result | What it means |
|---|---|---|
| **EU TED** | 400 *Validation error: field `fields` must not be empty* | It is a POST API and my request body was wrong. Reachable; needs the correct request shape. |
| **EU sanctions (FSF)** | 200 but **zero bytes** | The token URL answers and returns nothing. Wrong endpoint. Needs work before it can be claimed. |

### SEC EDGAR — a decision for you, not for me

EDGAR is the single most valuable corporate source for US entities, and the
probe produced an awkward result:

```
User-Agent: "Global Command View <contact address>"   → HTTP 403
User-Agent: "Mozilla/5.0 (compatible; GlobalCommandView/1.7.3)" → HTTP 200
```

The first is the format **SEC's own documentation asks for**. Their edge
refuses it and accepts a Mozilla-prefixed one.

This project has been here before and went the other way. The comment above
the airports code says LiveATC "sits behind a Cloudflare challenge that gates
even robots.txt, which is a clear enough statement about automated access. So
this does not fetch from them."

EDGAR is not that. The SEC publishes a rate limit, documents the API and
invites programmatic use; a 403 on their own documented header shape reads as
a misconfigured edge rather than a refusal. And
`Mozilla/5.0 (compatible; GlobalCommandView/1.7.3)` still names us — it is not
a disguise, it is the conventional compatible-token form.

**My recommendation is to use it, named, at well under their published limit.**
But it is your project and your name on it, so it is your call, and I will not
add it until you say.

### Sources deliberately not recommended yet

**SIPRI** — the arms transfers database is published for research use with
terms that need reading before any automated fetch. **Court records** — vary
by jurisdiction and are the highest-risk category in the whole brief.
**FEC** — usable but narrowly American and politically charged; low value per
unit of risk. **Patents** — EPO OPS needs a key, USPTO is open; worth a look
later, not in the MVP.

---

## 6. Recommended data model

The one design decision that matters: **separate the relation from the claim
that asserts it.**

```
entity            id, kind, primary_name, country, created_at
entity_name       entity_id, name, lang, kind          -- aliases, IBM / I.B.M.
entity_identifier entity_id, scheme, value             -- UNIQUE(scheme, value)
relation          id, subject_id, predicate, object_id,
                  valid_from, valid_to, amount, unit, share_pct
source            id, name, url, source_kind, licence,
                  published_at, retrieved_at
claim             relation_id, source_id, evidence_level, confidence,
                  raw_value, normalized_value, parser_version, verified
merge_log         kept_id, merged_id, reason, at, undone_at
investigation     id, name, payload_json, updated_at
```

Why this shape:

- **`claim` is many-to-one on `relation`.** A relation asserted by three
  independent sources is one edge with three claims. That is what makes
  "multiple independent sources" in your §11 a *count* rather than a feeling,
  and it is what §21 lineage and §29 data quality both read from.
- **`entity_identifier` with `UNIQUE(scheme, value)` is the resolution key.**
  Two records carrying the same LEI are the same company, decided by the
  database rather than by a string comparison. This is the answer to §19 and
  most of §20.
- **`valid_from` / `valid_to` on `relation` from day one**, as you asked in
  §10, even though most sources will leave them null. Retrofitting time onto
  an edge table later means rewriting every query.
- **`amount` / `share_pct` on the relation, nullable.** §9 says never invent a
  figure; a null column enforces that better than a formatted string.

### Evidence levels

Your five (`CONFIRMED`, `HIGH CONFIDENCE`, `REPORTED`, `ALLEGED`,
`UNVERIFIED`) map onto `source_kind`, which is where the honesty lives:

| `source_kind` | Default evidence level |
|---|---|
| `official_registry` (GLEIF, Companies House) | CONFIRMED |
| `government_record` (USASpending, OFAC) | CONFIRMED |
| `court_record` | CONFIRMED |
| `regulatory_filing` (EDGAR) | CONFIRMED |
| `reference` (Wikidata) | HIGH CONFIDENCE |
| `journalism` | REPORTED |
| `secondary` (Wikipedia) | REPORTED |
| `uncorroborated` | UNVERIFIED |

`ALLEGED` is not a source kind — it is a property of what the source says, and
it must be set by the parser, never inferred.

### Connection score (§11)

Computed from the claim table and shown with its arithmetic, never as a
number on its own. The factors you listed are the right ones. The rule that
matters: **the score is a function of evidence, not of graph shape.** A node
with many edges is not better attested; it is just busier.

---

## 7. Graph library (§25)

The constraint decides this: no build step, no npm, classic `<script>` from a
CDN, matching how Cesium and satellite.js are already loaded.

| Candidate | Verdict |
|---|---|
| **React Flow** | Out. Needs React and a bundler. |
| **D3** | Loads fine, but you build selection, expansion and layout yourself. Weeks of work already solved elsewhere. |
| **Sigma.js v3 + graphology** | WebGL, fastest at 10 000+ nodes. Two libraries and more wiring, for a scale your own §7 caps at 150. |
| **Cytoscape.js** | **Recommended.** One UMD file, no dependencies of its own, canvas rather than DOM, and pan / zoom / drag / select / collapse / fit are in the box with a mature layout set. |

Cytoscape matches the project's own discipline — one file, no dependency tree —
and stays inside your node caps with room to spare. Load it **lazily, only when
NETWORK is first opened**, so a user who never opens the panel never pays for
it. That also keeps the globe's first paint untouched, which matters given the
performance work already in the app.

---

## 8. Risks

**1. GDPR, and this is the serious one.** Everything the app does today is
about *things* — aircraft, ships, weather, radio. A network of named living
people is personal data processing, you are in the EU, and you publish
publicly. Recommendation: **make organisations the MVP and admit persons only
where a register documents a role** (a director in Companies House, an officer
in an EDGAR filing). No private individuals, no special-category data, no
inferred edges about people, ever.

**2. "Connected to" reading as guilt.** You named this yourself. The mitigation
is structural rather than a disclaimer: an edge cannot exist without at least
one claim, and the claim's source is one click away at all times.

**3. Terms of use.** GLEIF and Wikidata are CC0 and safe. OpenCorporates is the
one to stay away from without a licence. Everything integrated must appear in
the existing **SOURCES & LICENCES** tab, as every current source does.

**4. Graph explosion.** Wikidata will exceed any node cap on a large company in
one hop. Caps have to be enforced server-side in the query, not client-side
after fetching.

**5. Entity resolution producing false merges.** A wrong merge does not look
like a bug, it looks like a finding. Hence `merge_log` with an undo, and
identifiers over names always.

**6. Weight.** The app already loads Cesium. Cytoscape must be lazy, the graph
must be server-side queried, and node caps must be real.

**7. Cache pressure.** 26 734 files already. The new subsystem should write to
SQLite, not to `.cache/`, so the sweep is not fighting it.

---

## 9. What has to be built

Nothing in the existing app needs rewriting. New surface:

**Backend** — a `graph.py`-shaped section of `server.py` (or its first
justified second module): schema creation, `upsert_entity`,
`upsert_relation`, `add_claim`, `resolve_identifier`, `neighbours(id, hops,
caps)`, `path(a, b, strategy)`, plus one adapter per source behind a common
interface so sources can be swapped, as you asked.

**Endpoints** — `/api/graph/search`, `/api/graph/node`, `/api/graph/expand`,
`/api/graph/path`, `/api/graph/investigation` (GET + POST, mirroring marks).

**Frontend** — a `NETWORK` tab beside WELCOME / HELP / SETUP, a Cytoscape
canvas, the node panel built on `showDetail`, an edge panel that is the source
list, and the `Locate on map` bridge that calls the existing camera flight.

---

## 10. Phase plan

| Phase | Content |
|---|---|
| **1** | *This document.* |
| **2** | Schema + `graph.py` + GLEIF and Wikidata adapters. No UI. Verified with `smoke.py` checks and a real query for Saab AB. |
| **3** | MVP UI: NETWORK tab, search, node panel, one-hop expand, edge → source panel, Locate on map. |
| **4** | Test: `smoke.py` green, no console errors, every existing layer still working, install still clean. |
| **5** | Path finder, timeline, compare, money flow, Lombardi mode, saved investigations. |

---

## 11. What I need from you before Phase 2

1. **SEC EDGAR** — use it with a compatible-token User-Agent, or leave it out?
2. **People** — organisations only for the MVP, as recommended, or people from
   the start?
3. **Name** — `GLOBAL NETWORK` or `LOMBARDI VIEW`? It will be one constant and
   one CSS prefix either way.

Nothing else blocks. Phase 2 touches no existing code path: a new table file
in `data/`, a new section in the server, and no change to any current
endpoint or layer.
