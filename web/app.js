/*
 * Global Command View — live public feeds on a 3D globe.
 *
 * Everything is drawn with Cesium primitives (not entities) so a few thousand
 * moving contacts stay cheap. Positions are dead-reckoned between polls so the
 * picture keeps moving even though the feeds only update every 10-20 seconds.
 */

/* ------------------------------------------------------------------ utils */

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const KNOT = 0.514444; // m/s
const FT = 3.28084;

function log(message, level) {
  const list = $('#log');
  const li = document.createElement('li');
  if (level) li.className = level;
  // The Z matters. Without it a reader on CEST sees 15:26 against a wall clock
  // reading 17:26 and concludes the app has been frozen for two hours - which
  // is exactly what happened. The HUD clock has always said Z; this did not.
  const t = new Date().toISOString().slice(11, 19);
  li.innerHTML = `<span class="t">${t}Z</span>${message}`;
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch (_) { /* keep status */ }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

/** Small canvas glyphs — cheaper and sharper than shipping image files. */
function glyph(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  if (kind === 'plane') {
    g.beginPath();
    g.moveTo(16, 2); g.lineTo(27, 28); g.lineTo(16, 21); g.lineTo(5, 28);
    g.closePath();
    g.fill();
  } else if (kind === 'ship') {
    g.beginPath();
    g.moveTo(16, 3); g.lineTo(23, 14); g.lineTo(23, 28); g.lineTo(9, 28); g.lineTo(9, 14);
    g.closePath();
    g.fill();
  } else if (kind === 'camera') {
    g.beginPath(); g.arc(16, 16, 9, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(16, 16, 3.5, 0, Math.PI * 2); g.fill();
  } else if (kind === 'rotor') {
    // two crossed blades and a hub — reads as a helicopter at any size
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(4, 6); g.lineTo(28, 26); g.stroke();
    g.beginPath(); g.moveTo(28, 6); g.lineTo(4, 26); g.stroke();
    g.beginPath(); g.arc(16, 16, 5, 0, Math.PI * 2); g.fill();
  } else if (kind === 'bracket') {
    // Four corner ticks — the target reticle drawn around a detected contact.
    g.lineWidth = 2.5;
    const a = 3, b = 29, len = 9;
    for (const [x, y, dx, dy] of [[a, a, 1, 1], [b, a, -1, 1], [a, b, 1, -1], [b, b, -1, -1]]) {
      g.beginPath();
      g.moveTo(x + dx * len, y);
      g.lineTo(x, y);
      g.lineTo(x, y + dy * len);
      g.stroke();
    }
  }
  return c;
}

const GLYPHS = {
  plane: glyph('plane'),
  ship: glyph('ship'),
  camera: glyph('camera'),
  bracket: glyph('bracket'),
  rotor: glyph('rotor'),
};

/* ------------------------------------------------------------------ globe */

// Nothing in this app touches Cesium ion: imagery, terrain and assets are all public.

const IMAGERY = {
  /*
   * Short-wave infrared false colour, and the reason the briefing is worth
   * flying to. Named for what it is rather than what one hopes to find in it:
   * calling it BURN SCAR promised a scar, and what it mostly shows is a
   * continent of healthy vegetation in green, which reads as a broken layer to
   * anyone who was promised otherwise. In true colour a boreal fire is invisible: cloud and its own
   * smoke cover it completely - verified over the Northwest Territories, where
   * true colour showed white and this showed the scar. SWIR passes through
   * smoke, so burnt ground reads dark rust, healthy vegetation bright green,
   * and an active front glows orange.
   *
   * Always NASA, never Esri, so it works in commercial-safe mode unchanged and
   * follows the imagery-day slider.
   */
  burn: {
    label: 'FIRE IR',
    what: 'Short-wave infrared. Burnt ground reads dark rust, healthy vegetation bright green, an active fire front glows orange. It sees through smoke, which true colour cannot, so use it to ask how much has burned.',
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/'
       + 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1/default/{gibsDay}/'
       + 'GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
    credit: 'NASA GIBS / EOSDIS \u2014 VIIRS M11-I2-I1 false colour',
    max: 9,
    gibs: true,
    tune: { brightness: 1.05, contrast: 1.2, saturation: 1.15, hue: 0.0, gamma: 1.0 },
  },
  /*
   * The other half of the pair.
   *
   * FIRE IR sees *through* smoke - that is what short-wave infrared is for, and
   * why it can show a scar under a plume. Which means it is the wrong lens for
   * looking at the plume itself. This is the same satellite, same day, in the
   * colours an eye would see: smoke grey-brown and opaque, drifting downwind for
   * hundreds of kilometres.
   *
   * Use them together. FIRE IR answers how much has burned; SMOKE answers where
   * it is going and who is downwind of it.
   */
  smoke: {
    label: 'SMOKE',
    what: 'The same satellite and the same day in the colours an eye would see. Smoke is grey-brown and opaque and drifts for hundreds of kilometres. Use it to ask where the smoke is going and who is downwind, which FIRE IR deliberately looks straight through.',
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{gibsDay}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
    credit: 'NASA GIBS / EOSDIS \u2014 VIIRS true colour, daily',
    max: 9,
    gibs: true,
    tune: { brightness: 1.06, contrast: 1.12, saturation: 1.0, hue: 0.0, gamma: 1.0 },
  },
  /*
   * Sentinel-2 at 10 m, cloud-free, worldwide, and licence-clear.
   *
   * EOX build an annual cloudless mosaic out of Copernicus Sentinel-2 and serve
   * it openly under CC BY 4.0 with attribution. That combination is rare: NASA's
   * imagery is free but stops at 300 m, and Esri's is sharp but comes with terms
   * that plausibly forbid a monetised video. This is both sharp and clear to use,
   * which makes it the one basemap commercial-safe mode can descend with.
   *
   * The catch is in the name. Cloudless means composited from many passes over a
   * year, so it is a *basemap* and not a snapshot: no clouds, no smoke, no ships,
   * nothing that happened on a particular day. For today, use SMOKE or FIRE IR.
   */
  s2: {
    label: 'SENTINEL 10M',
    what: 'Sentinel-2 at 10 m, sharp enough to see individual buildings. It is a mosaic composited from a year of passes, so there are no clouds, no smoke, no ships and no flood in it. A basemap, not a look at a day.',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
    credit: 'Sentinel-2 cloudless 2024 by EOX \\u2014 contains modified '
          + 'Copernicus Sentinel data, CC BY 4.0',
    max: 16,
    openLicence: true,
    tune: { brightness: 1.04, contrast: 1.08, saturation: 1.05, hue: 0.0, gamma: 1.0 },
  },
  ops: {
    label: 'OPS',
    what: 'A dark cartographic chart rather than imagery. Roads, coastlines and place names with nothing else competing for attention. The easiest optic for reading positions off.',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri and its licensors — dark canvas',
    max: 19,
    tune: { brightness: 1.1, contrast: 1.15, saturation: 0.9, hue: 0.0, gamma: 1.0 },
  },
  thermal: {
    label: 'THERMAL',
    what: 'A false-colour treatment of the same imagery, not a heat camera. It exaggerates contrast the way a thermal sight would and is for the look of the footage, not for measuring temperature.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri and its licensors',
    max: 19,
    // Desaturated imagery plus a luminance-to-heat CSS ramp on the canvas: the
    // whole scene then reads like one sensor rather than a tinted map.
    tune: { brightness: 1.1, contrast: 1.3, saturation: 0.0, hue: 0.0, gamma: 1.5 },
    heat: true,
  },
  satellite: {
    label: 'SATELLITE',
    what: 'Aerial and satellite imagery at high resolution, the ordinary picture of the ground. Undated: it is whatever Esri last flew, which can be years old in some places and months in others.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri and its licensors',
    max: 19,
    tune: { brightness: 1.0, contrast: 1.05, saturation: 1.05, hue: 0.0, gamma: 1.0 },
  },
  nightvision: {
    label: 'NIGHT VIS',
    what: 'Image-intensifier green applied to daylight imagery. Presentation, not a sensor: nothing here is darker or brighter than it was, only greener.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri and its licensors',
    max: 19,
    // Image-intensifier look: throw away colour, lift the shadows hard, and let
    // the green phosphor come from the post-process pass.
    tune: { brightness: 1.5, contrast: 1.1, saturation: 0.0, hue: 0.0, gamma: 0.65 },
    scope: 'night',
  },
  flir: {
    label: 'FLIR',
    what: 'The white-hot look of an infrared sight, applied to ordinary imagery. Like THERMAL, it is a treatment rather than a measurement, and nothing in it is warm.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri and its licensors',
    max: 19,
    tune: { brightness: 1.0, contrast: 1.5, saturation: 0.0, hue: 0.0, gamma: 1.2 },
    scope: 'flir',
  },
  crt: {
    label: 'CRT',
    what: 'A real post-process pass over the picture: barrel distortion, scan lines and chromatic separation. For when the footage should look like it came off a screen rather than out of a satellite.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri and its licensors',
    max: 19,
    tune: { brightness: 0.92, contrast: 1.45, saturation: 0.7, hue: 0.0, gamma: 1.25 },
    crt: true,
  },
};

/*
 * Commercial-safe mode.
 *
 * A monetised channel is commercial use, and several sources here do not permit
 * it: the ion Community tier is licensed for personal use, Windy's free webcam
 * tier is link-and-embed only, planespotters asks for non-commercial use. The
 * basemaps are the murkier case - Esri's imagery and canvas services both
 * carry terms that plausibly restrict this - so rather than reason about them,
 * this mode narrows the app to sources whose licence is unambiguous.
 *
 * Which means NASA. GIBS serves daily VIIRS true colour and the Blue Marble
 * relief with no key and no copyright, US federal work carrying none.
 *
 * The cost is resolution: GIBS stops at level 9, about 300 m a pixel, so this is
 * a mode for continental shots and not for streets. The optics survive it, being
 * shaders over whatever lies beneath, so THERMAL and FLIR still look themselves.
 *
 * This is a switch that narrows the app to what a licence can be pointed at. It
 * is not legal advice, and the terms are the operator's to read.
 */

const SAFE_IMAGERY = {
  trueColour: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{gibsDay}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
  blueMarble: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
};

/*
 * Settings written before the app was renamed.
 *
 * Every stored key used to start `gev`, from a name this project no longer
 * carries. Renaming them is a two-line change and would have silently thrown
 * away whatever anybody had set - safe mode, their marks, a calibrated camera,
 * which sections they keep folded. So the old names are copied across once and
 * then removed, and nobody notices anything happened.
 *
 * This can go once no browser anywhere still holds a `gev` key, which is a date
 * nobody can know, so it stays. It costs one pass over localStorage at boot.
 */
(function carryOldSettingsOver() {
  try {
    const moved = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const old = localStorage.key(i);
      if (!old || !old.startsWith('gev')) continue;
      const now = 'gcv' + old.slice(3);
      // An existing new-style value wins: it is the one being used.
      if (localStorage.getItem(now) === null) {
        localStorage.setItem(now, localStorage.getItem(old));
        moved.push(now);
      }
      localStorage.removeItem(old);
    }
    if (moved.length) console.info('carried %d setting(s) over from the old name', moved.length);
  } catch (_) {
    // A browser with storage blocked has nothing to carry over either.
  }
})();

let safeMode = localStorage.getItem('gcv-safe') === '1';

// How many days back the GIBS-backed imagery is asked for. This is the whole
// argument for the layer below: a burn scar seen today is a brown patch, and a
// burn scar stepped back five days is a story about how it got there.
let dayOffset = 0;

/** Yesterday-ish, minus the operator's offset: today's swath may not be
 *  processed yet, so the zero point is already a day and a half back. */
function gibsDay() {
  const ms = Date.now() - (36 + dayOffset * 24) * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/*
 * Sentinel-2 revisits the same ground every five days or so, which means asking
 * for one date gives you a few diagonal strips of imagery and nothing else -
 * a layer that looks broken rather than one that is empty. So the slider's day
 * is the *end* of a window reaching back far enough to have caught a pass.
 *
 * The cost of that is honest and worth stating: what comes back may be stitched
 * from up to two overflights a few days apart, so it is very nearly a snapshot
 * rather than exactly one. Still the opposite of the cloudless mosaic, which
 * averages a year and keeps nothing that happened.
 */
const SENTINEL_WINDOW_DAYS = 10;

function sentinelWindow() {
  const end = gibsDay();
  const start = new Date(Date.parse(end) - SENTINEL_WINDOW_DAYS * 86400_000)
    .toISOString().slice(0, 10);
  return start + '/' + end;
}

function makeImageryLayer(key) {
  const spec = IMAGERY[key];
  // Already NASA, or already openly licensed: nothing to substitute in either
  // mode. Only the styles whose terms are the problem get swapped.
  const url = spec.cdse ? spec.url.replace('{window}', sentinelWindow())
    : spec.gibs ? spec.url.replace('{gibsDay}', gibsDay())
    : spec.openLicence ? spec.url
    : !safeMode ? spec.url
    : key === 'ops' ? SAFE_IMAGERY.blueMarble
    : SAFE_IMAGERY.trueColour.replace('{gibsDay}', gibsDay());
  const layer = new Cesium.ImageryLayer(
    new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: (spec.gibs || spec.openLicence) ? spec.max
        : safeMode ? (key === 'ops' ? 8 : 9) : spec.max,
      credit: new Cesium.Credit(
        (spec.gibs || spec.openLicence || !safeMode) ? spec.credit
          : 'NASA GIBS / EOSDIS - public domain'
      ),
    })
  );
  Object.assign(layer, spec.tune);
  // A Copernicus tile carries the Copernicus logo. One of those is attribution;
  // thirty of them across a screen is a wall, and at that distance a 10 m
  // product was showing nothing 10 m wide anyway.
  if (spec.cdse) layer.minimumTerrainLevel = CDSE_MIN_LEVEL;
  return layer;
}

const viewer = new Cesium.Viewer('globe', {
  baseLayer: makeImageryLayer('ops'),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  shouldAnimate: true,
  contextOptions: { webgl: { powerPreference: 'high-performance' } },
});

const scene = viewer.scene;
scene.globe.enableLighting = true;
scene.globe.showGroundAtmosphere = true;
scene.skyAtmosphere.show = true;
scene.fog.enabled = true;
scene.highDynamicRange = false;
scene.globe.baseColor = Cesium.Color.fromCssColorString('#02040a');
scene.screenSpaceCameraController.minimumZoomDistance = 300;
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(12, 40, 24_000_000),
});

/* ---------------------------------------------------------------- layers */

const collections = {
  flights: scene.primitives.add(new Cesium.BillboardCollection({ scene })),
  services: scene.primitives.add(new Cesium.BillboardCollection({ scene })),
  vessels: scene.primitives.add(new Cesium.BillboardCollection({ scene })),
  cameras: scene.primitives.add(new Cesium.BillboardCollection({ scene })),
  landings: scene.primitives.add(new Cesium.PointPrimitiveCollection()),
  satellites: scene.primitives.add(new Cesium.PointPrimitiveCollection()),
};
const orbitTrack = scene.primitives.add(new Cesium.PolylineCollection());
const quakes = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const fires = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const outbreaks = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const ownEntries = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const volcanoes = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const radios = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const scanners = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const aprs = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const airports = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const broadcast = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const alerts = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const plants = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const netOut = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const meshNodes = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const newsHeat = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const trains = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
const metarPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const navaidPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const swRoad = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const swRail = scene.primitives.add(new Cesium.PointPrimitiveCollection());
let smhiPrimitive = null;
let cablePrimitive = null;

// Contacts are drawn small from orbit and grow as you dive in, so a global view
// stays readable instead of turning into a wall of icons.
const SCALE = {
  flight: new Cesium.NearFarScalar(30_000, 1.0, 12_000_000, 0.22),
  vessel: new Cesium.NearFarScalar(10_000, 1.0, 4_000_000, 0.2),
  camera: new Cesium.NearFarScalar(10_000, 1.0, 6_000_000, 0.34),
};

/*
 * Twenty-four layers in one flat list is a list nobody reads. Worse, several of
 * them are off by default - dense ones, and ones covering a single country - so
 * somebody looking for police radio finds neither a dot on the globe nor an
 * obvious row to switch on.
 *
 * Grouping by what a thing *is* rather than where it came from: somebody hunting
 * for aviation radio is thinking "radio", not "OurAirports".
 */

const LAYER_GROUPS = [
  { name: 'Radio', ids: ['broadcast', 'radio', 'scanners', 'airports', 'aprs'] },
  { name: 'Aviation', ids: ['runways', 'metar', 'navaids'] },
  { name: 'Moving', ids: ['flights', 'services', 'vessels', 'trains', 'capital', 'fishing'] },
  { name: 'Earth', ids: ['fires', 'quakes', 'volcanoes', 'weather'] },
  { name: 'People', ids: ['outbreaks', 'news', 'air', 'own'] },
  { name: 'Infrastructure',
    ids: ['cameras', 'cables', 'plants', 'netout', 'mesh', 'bases', 'infra', 'traffic', 'jams'] },
  { name: 'Reference', ids: ['names'] },
  { name: 'Ground change', ids: ['sar', 'disturb', 'water'] },
  { name: 'Above', ids: ['satellites', 'launches'] },
  { name: 'Sweden', ids: ['swroad', 'swrail', 'smhi'] },
];

const LAYERS = [
  { id: 'flights', name: 'Air traffic', color: '#ffb347', on: false, count: 0, note: 'OpenSky worldwide, topped up by community feeders — transponders, so an aircraft that is not broadcasting is not here' },
  { id: 'services', name: 'Police & state air', color: '#4fa3ff', on: false, count: 0, note: 'picked out of the same ADS-B feed by registry — police, medical, coastguard and military airframes' },
  { id: 'vessels', name: 'Vessels (AIS)', color: '#4fd6ff', on: false, count: 0, note: 'Digitraffic covers the Baltic; an aisstream key opens the rest — ships report their own position' },
  { id: 'cables', name: 'Submarine cables', color: '#b58cff', on: false, count: 0, note: 'TeleGeography — fine to watch; ask them before monetising' },
  { id: 'cameras', name: 'Public cameras', color: '#7dffab', on: false, count: 0, note: 'Digitraffic, TfL, Trafikverket and Windy merged — a still from the camera, not a live stream' },
  { id: 'names', name: 'Names & borders', color: '#cbd5e1', on: false, count: 0, note: 'Natural Earth lines, Esri dark-canvas labels \u2014 works over satellite too' },
  { id: 'sar', name: 'Radar backscatter', color: '#8fbcd4', on: false, count: 0, note: 'NASA OPERA Sentinel-1 \u2014 sees through cloud and darkness', noCount: true },
  { id: 'disturb', name: 'Ground disturbance', color: '#e879a0', on: false, count: 0, note: 'NASA OPERA DIST-ALERT \u2014 vegetation lost since a baseline', noCount: true },
  { id: 'water', name: 'Surface water / flood', color: '#38bdf8', on: false, count: 0, note: 'NASA OPERA DSWx \u2014 radar, so cloud does not hide the flood', noCount: true },
  { id: 'satellites', name: 'Satellites', color: '#ffffff', on: false, count: 0, note: 'CelesTrak orbital elements, propagated here — 16 000 objects, and most of them are debris' },
  { id: 'quakes', name: 'Seismic (7 days)', color: '#ff5a5a', on: false, count: 0, note: 'USGS, M2.5+ over the last week — sized by energy, coloured by depth, because shallow ones do the damage' },
  { id: 'fires', name: 'Thermal / fires (24 h)', color: '#ff7a1a', on: false, count: 0, note: 'NASA FIRMS VIIRS — heat, not only wildfire' },
  { id: 'outbreaks', name: 'Disease outbreaks', color: '#c77dff', on: false, count: 0, note: 'WHO international alerts only — national outbreaks are missing' },
  { id: 'volcanoes', name: 'Erupting volcanoes', color: '#ff8c42', on: false, count: 0, note: 'Smithsonian GVP — continuing eruptions, a catalogue not a sensor' },
  { id: 'broadcast', name: 'Radio stations (FM etc.)', color: '#34d399', on: false, count: 0, note: 'Radio Browser — the station people actually listen to, played here' },
  { id: 'radio', name: 'Shortwave receivers', color: '#7dd3fc', on: false, count: 0, note: 'KiwiSDR — open receivers you can listen through' },
  { id: 'scanners', name: 'Police & fire radio', color: '#60a5fa', on: false, count: 0, note: 'OpenMHZ — United States only, recorded by volunteers' },
  { id: 'aprs', name: 'Amateur radio (APRS)', color: '#a78bfa', on: false, count: 0, note: 'APRS-IS — operators broadcasting their own positions' },
  { id: 'airports', name: 'Airports & ATC', color: '#fcd34d', on: false, count: 0, note: 'OurAirports — LiveATC for the tower, and that is mostly North America' },
  { id: 'weather', name: 'Severe weather (US)', color: '#f472b6', on: false, count: 0, note: 'NWS — United States only, no open feed covers the rest' },
  { id: 'plants', name: 'Power stations', color: '#a3e635', on: false, count: 0, note: 'WRI — 35 000 stations, sized by capacity' },
  { id: 'launches', name: 'Rocket launches', color: '#fb923c', on: false, count: 0, note: 'Launch Library — scheduled, and a schedule slips' },
  { id: 'infra', name: 'Data centres & dams', color: '#c084fc', on: false, count: 0, note: 'OpenStreetMap — queried live for the view, ODbL' },
  { id: 'traffic', name: 'Traffic flow', color: '#f87171', on: false, count: 0, note: 'TomTom — needs a free key; measured, not simulated', noCount: true },
  { id: 'jams', name: 'Jams & roadworks', color: '#ef4444', on: false, count: 0, note: 'TomTom incidents — why a road is stopped, with the delay in seconds' },
  { id: 'air', name: 'Air quality (PM2.5)', color: '#4ade80', on: false, count: 0, note: 'OpenAQ — needs a free key; what people are actually breathing' },
  { id: 'fishing', name: 'Fishing & AIS gaps', color: '#34d399', on: false, count: 0, note: 'Global Fishing Watch — needs a free token; behaviour, not position' },
  { id: 'netout', name: 'Internet outages', color: '#fb7185', on: false, count: 0, note: 'IODA — three methods; agreement is the signal' },
  { id: 'mesh', name: 'Mesh radio nodes', color: '#34d399', on: false, count: 0, note: 'Meshtastic — only those on the public bridge' },
  { id: 'news', name: 'News attention', color: '#fcd34d', on: false, count: 0, note: 'GDELT — counts coverage, not events' },
  { id: 'trains', name: 'Trains (US)', color: '#c4b5fd', on: false, count: 0, note: 'Amtrak — US only; Finland refuses every header tried' },
  { id: 'own', name: 'Own entries', color: '#ffb347', on: false, count: 0, note: 'hand-entered from the news — no feed saw these' },
  { id: 'capital', name: 'Capital ships (est.)', color: '#ff4d4d', on: false, count: 0, note: 'USNI Fleet Tracker, read at launch · area centres, not positions' },
  { id: 'navaids', name: 'Navigation beacons', color: '#4fd6ff', on: false, count: 0, note: 'OurAirports — VOR, VOR-DME, VORTAC, TACAN, DME and NDB with their frequencies; no ILS exists in this data' },
  { id: 'metar', name: 'Airfield weather (METAR)', color: '#7dffab', on: false, count: 0, note: 'NOAA aviation weather — an observation at the field, not a forecast for the area; coloured by flight category and bigger where something is falling' },
  { id: 'runways', name: 'Runways & approaches', color: '#cbd5e1', on: false, count: 0, note: 'OurAirports — real runway geometry; the approach line is 10 NM of arithmetic from the published heading, not a procedure off a chart' },
  { id: 'swroad', name: 'Swedish road disruption', color: '#ff9f45', on: false, count: 0, note: 'Trafikverket Situation — roadworks, incidents and ferries, Sweden only; some are stretches of road with no single point' },
  { id: 'swrail', name: 'Swedish trains', color: '#5fe3c0', on: false, count: 0, note: 'Trafikverket TrainPosition — where trains report themselves, Sweden only; a stale position is dropped rather than shown standing still' },
  { id: 'smhi', name: 'SMHI warnings', color: '#ffd166', on: false, count: 0, note: 'SMHI — areas, not points: a warning covers a coastline rather than a spot on it. Sweden only, no key needed' },
  { id: 'bases', name: 'Submarine bases', color: '#b58cff', on: false, count: 0, note: 'where they are based, not where they are' },
];

/*
 * Layers heavy enough to be off at boot: switching one on is the moment to go and
 * get it. Scanners cover one country, plants and mesh are tens of thousands of
 * points - none of them should be fetched for somebody who never asks.
 */
const LAYER_ON_DEMAND = {};

/*
 * The app used to fetch every layer at launch and then hide most of them, which
 * is the worst of both: a slow, loud start and a globe nobody asked for. Layers
 * now start off, and a layer that is off is not fetched at all - switching it on
 * is what loads it, through the same map the layer list already used.
 *
 * Two survive that: names and borders, because a map you cannot read is not a
 * map, and public cameras, because they are the reason to look anywhere.
 */
/** Is a layer lit? By id, because indexes move when a layer is added. */
function layerOn(id) {
  const layer = LAYERS.find((l) => l.id === id);
  return !!layer && layer.on;
}

function bootLayer(id) {
  const layer = LAYERS.find((l) => l.id === id);
  if (layer && layer.on && LAYER_ON_DEMAND[id]) LAYER_ON_DEMAND[id]();
}

/** Wrap a repeating loader so it does nothing while its layer is off. */
function whileOn(ids, fn) {
  const wanted = Array.isArray(ids) ? ids : [ids];
  return () => {
    if (wanted.some((id) => (LAYERS.find((l) => l.id === id) || {}).on)) fn();
  };
}

function renderLayerList() {
  const ul = $('#layers');
  ul.innerHTML = '';

  // Anything a group forgot still gets drawn, at the end, rather than vanishing
  // from the panel because somebody added a layer and not a group entry.
  const grouped = new Set(LAYER_GROUPS.flatMap((g) => g.ids));
  const orphans = LAYERS.filter((l) => !grouped.has(l.id)).map((l) => l.id);
  const groups = orphans.length
    ? [...LAYER_GROUPS, { name: 'Other', ids: orphans }]
    : LAYER_GROUPS;

  for (const group of groups) {
    const members = group.ids
      .map((id) => LAYERS.find((l) => l.id === id))
      .filter(Boolean);
    if (!members.length) continue;

    const head = document.createElement('li');
    head.className = 'layer-group';
    const lit = members.filter((l) => l.on).length;
    head.innerHTML = `<span>${group.name}</span>`
      + `<span class="count">${lit}/${members.length}</span>`;
    ul.append(head);

    for (const layer of members) {
    const li = document.createElement('li');
    li.className = 'layer' + (layer.on ? '' : ' off');
    li.innerHTML =
      `<span class="dot" style="background:${layer.color};color:${layer.color}"></span>` +
      `<span class="name">${layer.name}</span>` +
      // An imagery overlay has no count, and a 0 beside one reads as "found
      // nothing" rather than "this is a picture, not a tally".
      //
      // A switched-off layer has the same problem and it is worse, because it is
      // most of the panel. Nothing has been asked of it, so its zero is not an
      // answer - but zero is exactly how this app reports "the feed replied and
      // there was nothing there". Fourteen rows reading 0 look like fourteen
      // empty feeds rather than fourteen unasked questions, which is the one
      // misreading the whole layer list exists to prevent.
      `<span class="count">${layer.noCount || !layer.on ? '·'
        : layer.count.toLocaleString('en-US')}</span>`;
    li.title = `source: ${layer.note}`;
    li.onclick = () => {
      layer.on = !layer.on;
      applyVisibility();
      renderLayerList();
      // The 3D view has its own copy of what is drawn, so it has to be told.
      if (typeof mirrorLayers === 'function') mirrorLayers();
      // Layers that start off have nothing loaded yet, so switching one on has
      // to fetch it rather than reveal an empty collection.
      if (layer.on && LAYER_ON_DEMAND[layer.id]) LAYER_ON_DEMAND[layer.id]();
    };
      ul.append(li);
    }
  }
}

function applyVisibility() {
  const on = (id) => LAYERS.find((l) => l.id === id).on;
  collections.flights.show = on('flights');
  collections.services.show = on('services');
  collections.vessels.show = on('vessels');
  courseVectors.show = on('vessels');
  wakes.show = on('vessels');
  collections.cameras.show = on('cameras');
  collections.landings.show = on('cables');
  collections.satellites.show = on('satellites');
  orbitTrack.show = on('satellites');
  quakes.show = on('quakes');
  fires.show = on('fires');
  outbreaks.show = on('outbreaks');
  ownEntries.show = on('own');
  volcanoes.show = on('volcanoes');
  launchPads.show = on('launches');
  infraMarks.show = on('infra');
  viewsheds.show = on('cameras');
  showTraffic(on('traffic'));
  if (jamPrimitive) jamPrimitive.show = on('jams');
  airMarks.show = on('air');
  fishingMarks.show = on('fishing');
  showNames(on('names'));
  for (const spec of OPERA) showOpera(spec, on(spec.id));
  if (runwayPrimitive) runwayPrimitive.show = on('runways');
  metarPoints.show = on('metar');
  navaidPoints.show = on('navaids');
  swRoad.show = on('swroad');
  swRail.show = on('swrail');
  if (smhiPrimitive) smhiPrimitive.show = on('smhi');
  radios.show = on('radio');
  broadcast.show = on('broadcast');
  scanners.show = on('scanners');
  aprs.show = on('aprs');
  airports.show = on('airports');
  alerts.show = on('weather');
  plants.show = on('plants');
  netOut.show = on('netout');
  meshNodes.show = on('mesh');
  newsHeat.show = on('news');
  trains.show = on('trains');
  subBases.show = on('bases');
  capitalShips.show = on('capital');
  capitalRings.show = on('capital');
  if (cablePrimitive) cablePrimitive.show = on('cables');
}

function setCount(id, n) {
  const layer = LAYERS.find((l) => l.id === id);
  if (layer && layer.count !== n) {
    layer.count = n;
    renderLayerList();
  }
}

/* --------------------------------------------------------------- flights */

const flights = new Map(); // icao24 -> track state
const ALT_LOW = Cesium.Color.fromCssColorString('#ff7a2f');
const ALT_HIGH = Cesium.Color.fromCssColorString('#7fe8ff');
const MIL_COLOR = Cesium.Color.fromCssColorString('#ff4d4d');
let flightBackoff = 0;

function altitudeColor(metres) {
  const t = clamp((metres || 0) / 12000, 0, 1);
  return Cesium.Color.lerp(ALT_LOW, ALT_HIGH, t, new Cesium.Color());
}

function viewportBbox() {
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return { lamin: -90, lomin: -180, lamax: 90, lomax: 180 };
  const pad = 1.5;
  return {
    lamin: clamp(Cesium.Math.toDegrees(rect.south) - pad, -90, 90),
    lamax: clamp(Cesium.Math.toDegrees(rect.north) + pad, -90, 90),
    lomin: clamp(Cesium.Math.toDegrees(rect.west) - pad, -180, 180),
    lomax: clamp(Cesium.Math.toDegrees(rect.east) + pad, -180, 180),
  };
}

LAYER_ON_DEMAND.flights = () => pollFlights();
// Police and state aircraft are picked out of the same feed, not a second one.
LAYER_ON_DEMAND.services = () => pollFlights();

async function pollFlights() {
  // By id, not by index. This was LAYERS[0] and happened to be right; the
  // vessel poller next to it was LAYERS[1] and had been asking the wrong
  // layer for months, hidden only because that layer defaulted on.
  if (!layerOn('flights') && !layerOn('services')) return;
  if (flightBackoff > Date.now()) return;
  const bbox = viewportBbox();
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(bbox).map(([k, v]) => [k, v.toFixed(2)]))
  );
  try {
    const data = await getJSON('/api/flights?' + q);
    const states = data.states || [];
    const now = performance.now();
    const seen = new Set();
    for (const s of states) {
      const [icao, callsign, country, , , lon, lat, baroAlt, onGround, vel, track, vRate] = s;
      if (lon == null || lat == null) continue;
      seen.add(icao);
      const alt = s[13] != null ? s[13] : baroAlt;
      let f = flights.get(icao);
      if (!f) {
        f = { icao, billboard: null };
        flights.set(icao, f);
      }
      Object.assign(f, {
        callsign: (callsign || '').trim() || icao.toUpperCase(),
        country,
        reg: s[17] || '',      // present when the picture comes from adsb.lol
        acType: s[18] || '',
        military: !!s[19],
        lon, lat,
        alt: alt || 0,
        onGround,
        speed: vel || 0,
        track: track || 0,
        vRate: vRate || 0,
        stamp: now,
      });
      // The reported fixes, not the dead-reckoned drift between them - the same
      // rule the ship wakes follow, and for the same reason: this is meant to be
      // where the aircraft was, not where the app guessed it would be.
      if (!f.onGround) {
        (f.trail = f.trail || []).push([f.lon, f.lat, f.alt]);
        if (f.trail.length > TRACK_POINTS) f.trail.shift();
      } else if (f.trail) {
        f.trail.length = 0;
      }
    }
    for (const [icao, f] of flights) {
      if (!seen.has(icao)) {
        if (f.billboard) (f.collection || collections.flights).remove(f.billboard);
        flights.delete(icao);
      }
    }
    for (const f of flights.values()) {
      placeContact(f);
      // Military airframes are drawn hot regardless of altitude, and a size up,
      // so a tanker orbit stands out from the airline traffic around it.
      if (f.role) {
        f.billboard.color = Cesium.Color.fromCssColorString(ROLE_COLORS[f.role] || '#ffffff');
      } else {
        f.billboard.color = f.military ? MIL_COLOR : altitudeColor(f.onGround ? 0 : f.alt);
      }
      if (f.rotorcraft) {
        f.billboard.scale = 0.6;
      } else {
        f.billboard.scale = f.military ? 0.7 : 0.5;
      }
      f.billboard.rotation = -Cesium.Math.toRadians(f.track);
    }
    setCount('flights', collections.flights.length);
    setCount('services', collections.services.length);
    // The track lines live in the same rebuild as the ship wakes, and that was
    // only ever called from the vessel poll - so with vessels off the aircraft
    // trails were collected faithfully and never drawn once.
    if (wantTracks) rebuildTracks();
    const mil = [...flights.values()].filter((f) => f.military).length;
    const sample = data.sampled && !data.sampled.covers_view
      ? ` · sampled ${data.sampled.circles}×${data.sampled.radius_nm} nm around centre — zoom in for the rest`
      : '';
    log(
      `air: ${flights.size} contacts in view · ${data.source || 'opensky'}` +
      (mil ? ` · ${mil} military` : '') + sample
    );
  } catch (err) {
    flightBackoff = Date.now() + 60_000;
    log(`air feed unavailable (${err.message}) — retrying in 60s`, 'warn');
  }
}

/*
 * State aircraft live in their own collection rather than being coloured inside
 * the air layer, so that turning off Air traffic leaves exactly the police,
 * medical, coastguard and military machines on screen and nothing else.
 */
function contactCollection(f) {
  return f.role ? collections.services : collections.flights;
}

function placeContact(f) {
  const wanted = contactCollection(f);
  if (f.billboard && f.collection === wanted) return;
  const position = f.billboard
    ? f.billboard.position
    : Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.onGround ? 0 : f.alt);
  if (f.billboard) f.collection.remove(f.billboard);
  f.collection = wanted;
  f.billboard = wanted.add({
    image: f.rotorcraft ? GLYPHS.rotor : GLYPHS.plane,
    scale: f.rotorcraft ? 0.6 : 0.5,
    alignedAxis: Cesium.Cartesian3.ZERO,
    position,
    id: { type: 'flight', ref: f },
    scaleByDistance: SCALE.flight,
  });
}

/* --------------------------------------------------------- airframe registry */

/*
 * ADS-B says a hull is at a position; it never says what the hull is. adsbdb
 * keeps the civil registry, so a slow low contact can be resolved into its type
 * and its registered owner — which is how a police helicopter identifies itself
 * honestly, rather than by guessing from a callsign.
 */

const ROLE_COLORS = {
  police: '#4fa3ff',
  medical: '#ff6bd6',
  coastguard: '#7dffab',
  military: '#ff4d4d',
};

let registryBusy = false;

async function enrichRotorcraft() {
  if (registryBusy) return;
  const candidates = [];
  for (const f of flights.values()) {
    if (f.registry !== undefined) continue;          // already looked up
    if (f.onGround) continue;
    if (f.alt > 4000) continue;                      // helicopters stay low
    if (f.speed > 75) continue;                      // ~145 kt
    candidates.push(f);
    if (candidates.length >= 20) break;
  }
  if (!candidates.length) return;

  registryBusy = true;
  try {
    const hexes = candidates.map((f) => f.icao).join(',');
    const records = await getJSON(`/api/aircraft-types?hex=${hexes}`);
    let rotors = 0;
    for (const f of candidates) {
      const record = records[f.icao] || {};
      f.registry = record;
      if (record.reg && !f.reg) f.reg = record.reg;
      if (record.icao_type && !f.acType) f.acType = record.icao_type;
      f.rotorcraft = !!record.rotorcraft;
      f.role = record.role || '';
      placeContact(f);
      if (f.rotorcraft) rotors++;
      if (f.billboard) {
        f.billboard.image = f.rotorcraft ? GLYPHS.rotor : GLYPHS.plane;
        f.billboard.scale = f.rotorcraft ? 0.6 : 0.5;
        if (f.role) {
          f.billboard.color = Cesium.Color.fromCssColorString(ROLE_COLORS[f.role] || '#ffffff');
        }
      }
    }
    setCount('services', collections.services.length);
    if (rotors) {
      const named = candidates.filter((f) => f.rotorcraft && f.role);
      log(
        `rotorcraft: ${rotors} identified` +
        (named.length ? ` \u00b7 ${named.map((f) => `${f.callsign} ${f.role}`).join(', ')}` : '')
      );
    }
  } catch (err) {
    /* the registry being unreachable is not worth a warning every poll */
  } finally {
    registryBusy = false;
  }
}

setInterval(enrichRotorcraft, 4000);

/* ---------------------------------------------------------------- tracks */

/*
 * Where a contact is going, and where it has been. Both are rebuilt on the poll
 * rather than on the frame: a course vector is a projection from a fix that only
 * changes when a new fix arrives, so redrawing it sixty times a second would be
 * sixty times the cost for none of the information.
 */

const courseVectors = scene.primitives.add(new Cesium.PolylineCollection());
const wakes = scene.primitives.add(new Cesium.PolylineCollection());
const flightTracks = scene.primitives.add(new Cesium.PolylineCollection());
const VECTOR_MINUTES = 10;
/*
 * The same idea as a ship's wake, and a better argument for it.
 *
 * A published approach plate says what should happen. ADS-B says what did. The
 * app already receives every position report; keeping the last of them and
 * drawing the line through them turns the aircraft layer into the one kind of
 * approach chart nobody can charge for - the one aircraft actually flew.
 *
 * Drawn at altitude rather than on the ground, because the descent is the part
 * worth seeing: fifteen aircraft queuing for one runway draw the real pattern,
 * step-downs and all, without a single licensed chart involved.
 */
const TRACK_POINTS = 40;   // about ten minutes at a fifteen-second poll
const TRACK_LIMIT = 200;   // lines for two thousand aircraft is a frame budget
let wantTracks = false;

const WAKE_POINTS = 8;
const WAKE_LIMIT = 150;   // full wakes for 700 ships cost 30 ms a frame
let wantVectors = true;
let wantWakes = false;

const VECTOR_MATERIAL = Cesium.Material.fromType('Color', {
  color: Cesium.Color.fromCssColorString('#4fd6ff').withAlpha(0.55),
});
const WAKE_MATERIAL = Cesium.Material.fromType('Color', {
  color: Cesium.Color.fromCssColorString('#7dffab').withAlpha(0.35),
});
const TRACK_MATERIAL = Cesium.Material.fromType('Color', {
  color: Cesium.Color.fromCssColorString('#ffb347').withAlpha(0.42),
});

function projectAhead(lat, lon, trackDegrees, speedMs, seconds) {
  const distance = speedMs * seconds;
  const bearing = Cesium.Math.toRadians(trackDegrees);
  return [
    lon + (distance * Math.sin(bearing)) / (111320 * Math.cos(Cesium.Math.toRadians(lat))),
    lat + (distance * Math.cos(bearing)) / 110540,
  ];
}

function rebuildTracks() {
  const started = performance.now();
  courseVectors.removeAll();
  wakes.removeAll();

  if (collections.vessels.show) {
    const centre = viewer.camera.positionCartographic;
    const midLat = Cesium.Math.toDegrees(centre.latitude);
    const midLon = Cesium.Math.toDegrees(centre.longitude);
    const nearest = wantWakes
      ? [...vessels.values()]
          .sort((a, b) =>
            ((a.lat - midLat) ** 2 + (a.lon - midLon) ** 2) -
            ((b.lat - midLat) ** 2 + (b.lon - midLon) ** 2))
          .slice(0, WAKE_LIMIT)
      : [];
    const wakeSet = new Set(nearest);

    for (const v of vessels.values()) {
      if (wantVectors && v.speed > 0.5) {
        const [lon, lat] = projectAhead(v.lat, v.lon, v.track, v.speed, VECTOR_MINUTES * 60);
        courseVectors.add({
          positions: Cesium.Cartesian3.fromDegreesArray([v.lon, v.lat, lon, lat]),
          width: 1.2,
          material: VECTOR_MATERIAL,
        });
      }
      if (wantWakes && wakeSet.has(v) && v.trail && v.trail.length > 1) {
        wakes.add({
          positions: Cesium.Cartesian3.fromDegreesArray(v.trail.flat()),
          width: 1.4,
          material: WAKE_MATERIAL,
        });
      }
    }
  }

  // Aircraft tracks. Drawn from the height array rather than flattened, so the
  // line falls as the aircraft does and an approach reads as a descent instead
  // of as a squiggle on the ground.
  flightTracks.removeAll();
  if (wantTracks && collections.flights.show) {
    let drawn = 0;
    for (const f of flights.values()) {
      if (drawn >= TRACK_LIMIT) break;
      if (!f.trail || f.trail.length < 2) continue;
      if (!inView(f.lon, f.lat)) continue;
      flightTracks.add({
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(f.trail.flat()),
        width: 1.5,
        material: TRACK_MATERIAL,
      });
      drawn += 1;
    }
  }

  const cost = performance.now() - started;
  $('#track-cost').textContent =
    `${courseVectors.length + wakes.length} lines · ${cost.toFixed(1)} ms per poll`;
}

$('#vectors').onchange = (e) => { wantVectors = e.target.checked; rebuildTracks(); };
$('#wakes').onchange = (e) => { wantWakes = e.target.checked; rebuildTracks(); };
$('#tracks').onchange = (e) => {
  wantTracks = e.target.checked;
  rebuildTracks();
  log(wantTracks
    ? 'flown tracks on · the last 40 reports per aircraft, at altitude'
    : 'flown tracks off');
};

/* --------------------------------------------------------------- vessels */

const vessels = new Map();
let vesselMeta = new Map();

const VESSEL_COLORS = {
  Tanker: '#ff6b6b',
  Cargo: '#4fd6ff',
  Passenger: '#7dffab',
  'Service / tug': '#ffd166',
  Military: '#ffffff',
  Fishing: '#c2a3ff',
};

LAYER_ON_DEMAND.vessels = () => pollVessels();

async function pollVessels() {
  if (!layerOn('vessels')) return;
  const bbox = viewportBbox();
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(bbox).map(([k, v]) => [k, v.toFixed(2)]))
  );
  try {
    const data = await getJSON('/api/vessels?' + q);
    const now = performance.now();
    const seen = new Set();
    for (const ship of data.vessels) {
      seen.add(ship.mmsi);
      let v = vessels.get(ship.mmsi);
      if (!v) {
        v = { mmsi: ship.mmsi, billboard: null };
        vessels.set(ship.mmsi, v);
      }
      Object.assign(v, ship, { speed: (ship.sog || 0) * KNOT, stamp: now });
      // the wake is the reported fixes, not the dead-reckoned drift between them
      (v.trail = v.trail || []).push([ship.lon, ship.lat]);
      if (v.trail.length > WAKE_POINTS) v.trail.shift();
    }
    for (const [mmsi, v] of vessels) {
      if (!seen.has(mmsi)) {
        if (v.billboard) collections.vessels.remove(v.billboard);
        vessels.delete(mmsi);
      }
    }
    for (const v of vessels.values()) {
      if (!v.billboard) {
        v.billboard = collections.vessels.add({
          image: GLYPHS.ship,
          scale: 0.45,
          alignedAxis: Cesium.Cartesian3.ZERO,
          position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, 0),
          id: { type: 'vessel', ref: v },
          scaleByDistance: SCALE.vessel,
        });
      }
      v.billboard.color = Cesium.Color.fromCssColorString(VESSEL_COLORS[v.kind] || '#9fb4c0');
      v.billboard.rotation = -Cesium.Math.toRadians(v.track);
    }
    setCount('vessels', vessels.size);
    rebuildTracks();
    if (vessels.size) {
      const nets = [...new Set(data.vessels.map((s) => s.source))].join(' + ');
      log(`sea: ${vessels.size} AIS contacts · ${nets}`);
    } else {
      // An empty sea is usually coverage, not failure — say which.
      const c = data.coverage || {};
      const why = c.aisstream === 'live'
        ? 'no ships reporting here'
        : c.aisstream === 'off'
          ? 'outside the Baltic — needs an aisstream key for worldwide AIS'
          : `outside the Baltic — aisstream ${c.aisstream}, ${c.aisstream_messages} messages so far`;
      log(`sea: 0 in view · ${why}`);
    }
  } catch (err) {
    log(`ais feed unavailable (${err.message})`, 'warn');
  }
}

/* ------------------------------------------------------- submarine cables */

LAYER_ON_DEMAND.cables = () => loadCables();

async function loadCables() {
  try {
    const geo = await getJSON('/api/cables');
    const instances = [];
    for (const feature of geo.features) {
      const color = Cesium.Color.fromCssColorString(
        feature.properties.color || '#b58cff'
      ).withAlpha(0.7);
      const parts =
        feature.geometry.type === 'MultiLineString'
          ? feature.geometry.coordinates
          : [feature.geometry.coordinates];
      for (const part of parts) {
        if (!part || part.length < 2) continue;
        const flat = [];
        for (const [lon, lat] of part) flat.push(lon, lat);
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(flat),
              width: 1.3,
              arcType: Cesium.ArcType.GEODESIC,
            }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
            id: {
              type: 'cable',
              ref: { name: feature.properties.name, id: feature.properties.id },
            },
          })
        );
      }
    }
    cablePrimitive = scene.primitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
        asynchronous: true,
      })
    );
    setCount('cables', geo.features.length);
    log(`cables: ${geo.features.length} systems, ${instances.length} segments`);
  } catch (err) {
    log(`cable map unavailable (${err.message})`, 'warn');
  }

  try {
    const geo = await getJSON('/api/landings');
    for (const feature of geo.features) {
      const [lon, lat] = feature.geometry.coordinates;
      collections.landings.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        pixelSize: 3,
        color: Cesium.Color.fromCssColorString('#e0c3ff').withAlpha(0.9),
        id: { type: 'landing', ref: feature.properties },
        scaleByDistance: new Cesium.NearFarScalar(1e5, 2.2, 2e7, 0.6),
      }).gcvAt = [lon, lat];
    }
    log(`cables: ${geo.features.length} landing points`);
  } catch (err) {
    log(`landing points unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* --------------------------------------------------------------- cameras */

LAYER_ON_DEMAND.cameras = () => loadCameras();

async function loadCameras() {
  try {
    const data = await getJSON('/api/cameras');
    for (const station of data.stations) {
      if (!cameraIds.has(station.id)) addCameraStation(station);
    }
    setCount('cameras', collections.cameras.length);
    drawViewsheds();
    const networks = [...new Set(data.stations.map((s) => s.source))].join(', ');
    log(`cameras: ${data.stations.length} public stations · ${networks}`);
  } catch (err) {
    log(`camera index unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------- submarine bases */

/*
 * Submarines are the one thing here that genuinely cannot be tracked: they do
 * not broadcast, and no feed carries them. What is public is where they live.
 * This layer marks the piers and hands the job to the ruler and the imagery
 * date — count what is alongside, measure it, note when the picture was taken.
 */

const subBases = scene.primitives.add(new Cesium.BillboardCollection({ scene }));

GLYPHS.base = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2.5;
  // a pier line with a submarine silhouette alongside
  g.beginPath(); g.moveTo(6, 8); g.lineTo(26, 8); g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.ellipse(16, 19, 11, 4.5, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(14, 12, 4, 5);
  return c;
})();

LAYER_ON_DEMAND.bases = () => loadSubmarineBases();

async function loadSubmarineBases() {
  try {
    const data = await getJSON('/api/submarine-bases');
    for (const base of data.bases) {
      subBases.add({
        image: GLYPHS.base,
        position: Cesium.Cartesian3.fromDegrees(base.lon, base.lat, 0),
        scale: 0.7,
        color: Cesium.Color.fromCssColorString('#b58cff'),
        scaleByDistance: new Cesium.NearFarScalar(50_000, 1.2, 20_000_000, 0.4),
        id: { type: 'base', ref: base },
      });
    }
    setCount('bases', data.bases.length);
    log(`bases: ${data.bases.length} submarine bases`);
  } catch (err) {
    log(`submarine bases unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------------ capital ships */

/*
 * Carriers do not broadcast AIS, and no feed publishes where they are. What does
 * exist is the U.S. Naval Institute's weekly tracker, which states operating
 * areas from Navy and public reporting — so these are last-reported areas with
 * an honest circle of uncertainty around them, not tracks. The ring is the point:
 * a carrier in the Arabian Sea is somewhere in 450 km of ocean.
 */

const capitalShips = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
const capitalRings = scene.primitives.add(new Cesium.PolylineCollection());

GLYPHS.carrier = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  // a flat-top hull: long deck with an angled bow
  g.beginPath();
  g.moveTo(16, 2); g.lineTo(23, 11); g.lineTo(23, 29); g.lineTo(9, 29); g.lineTo(9, 11);
  g.closePath(); g.fill();
  g.fillStyle = '#000000';
  g.fillRect(14, 12, 4, 14);
  return c;
})();

function ringPositions(lat, lon, radiusKm, steps = 72) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push(
      lon + (radiusKm * 1000 * Math.sin(a)) / (111320 * Math.cos(Cesium.Math.toRadians(lat))),
      lat + (radiusKm * 1000 * Math.cos(a)) / 110540
    );
  }
  return Cesium.Cartesian3.fromDegreesArray(out);
}

LAYER_ON_DEMAND.capital = () => loadCarriers();

async function loadCarriers() {
  try {
    const data = await getJSON('/api/carriers');
    for (const ship of data.ships) {
      const carrier = ship.kind === 'carrier';
      const colour = Cesium.Color.fromCssColorString(carrier ? '#ff4d4d' : '#ffb347');
      capitalShips.add({
        image: GLYPHS.carrier,
        position: Cesium.Cartesian3.fromDegrees(ship.lon, ship.lat, 0),
        scale: carrier ? 0.85 : 0.65,
        color: colour,
        scaleByDistance: new Cesium.NearFarScalar(50_000, 1.3, 20_000_000, 0.45),
        // The file's date is the default. A ship that has moved since the tracker
        // went out carries its own date and source, so it spreads last and wins.
        id: { type: 'capital', ref: { as_of: data.as_of, url: data.url, source: data.source, ...ship } },
      });
      capitalRings.add({
        positions: ringPositions(ship.lat, ship.lon, ship.uncertainty_km),
        width: 1.2,
        material: Cesium.Material.fromType('PolylineDash', {
          color: colour.withAlpha(0.55),
          dashLength: 12,
        }),
      });
    }
    setCount('capital', data.ships.length);
    if (data.degraded) {
      log(`fleet: ${data.degraded} · positions as of ${data.as_of}`, 'warn');
    } else {
      log(`fleet: ${data.ships.length} capital ships · ${data.from_tracker} read from `
        + `the ${data.as_of} tracker, ${data.ships.length - data.from_tracker} typed in`);
    }
    if (data.unplaced && data.unplaced.length) {
      // Named but not drawn, because the area is not in the gazetteer. Said out
      // loud: a ship missing from the globe with nothing said is indistinguishable
      // from a ship that is not deployed.
      log(`fleet: not drawn, area unknown — `
        + data.unplaced.map((u) => `${u.hull} (${u.area})`).join(', '), 'warn');
    }
    if (data.with_later_news) {
      log(`fleet: ${data.with_later_news} ship(s) written about since that tracker `
        + '· open the pin to read it');
    }

  } catch (err) {
    log(`fleet estimate unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ---------------------------------------------------------------- seismic */

/*
 * USGS publishes every quake worldwide as GeoJSON. Magnitude is logarithmic, so
 * the marker area follows the energy release rather than the number, and colour
 * carries depth: shallow quakes do the damage.
 */

const QUAKE_DEPTHS = [
  { max: 30, color: '#ff4d4d' },    // crustal
  { max: 100, color: '#ffb347' },
  { max: 300, color: '#ffe066' },
  { max: Infinity, color: '#7fe8ff' },
];

LAYER_ON_DEMAND.quakes = () => loadQuakes();

async function loadQuakes() {
  try {
    const geo = await getJSON('/api/quakes');
    quakes.removeAll();
    for (const feature of geo.features) {
      const [lon, lat, depth] = feature.geometry.coordinates;
      const p = feature.properties;
      const mag = p.mag || 0;
      const shade = QUAKE_DEPTHS.find((d) => (depth || 0) < d.max).color;
      quakes.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        pixelSize: 4 + mag * 2.6,
        color: Cesium.Color.fromCssColorString(shade).withAlpha(0.75),
        outlineColor: Cesium.Color.fromCssColorString(shade),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1.4, 20_000_000, 0.5),
        id: { type: 'quake', ref: { ...p, lat, lon, depth } },
      });
    }
    setCount('quakes', geo.features.length);
    log(`seismic: ${geo.features.length} quakes M2.5+ in the last week`);
  } catch (err) {
    log(`seismic feed unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------------- wildfires */

/*
 * NASA FIRMS, the feed Worldview draws from: open, no key. What arrives is a
 * *thermal anomaly* — a pixel much hotter than its surroundings. Usually that is
 * a wildfire. It is also how a gas flare, a volcano, a steel works and a farmer
 * burning stubble look from orbit, and the bulk feed carries nothing that tells
 * them apart. So the layer is named for what is measured, and the detail panel
 * says it again.
 *
 * Radiative power is the useful number: a few megawatts is a field being burnt,
 * hundreds is a forest going up. Colour and size follow it.
 */

const FIRE_HEAT = [
  { max: 5, color: '#ffd166' },      // small, likely agricultural
  { max: 25, color: '#ff9f1a' },
  { max: 100, color: '#ff6b1a' },
  { max: Infinity, color: '#ff2d2d' },  // a major fire front
];

/**
 * Over the infrared optic the detections become rings.
 *
 * Filled dots were covering the very ground they exist to point at: the whole
 * reason to look at this layer is the scar underneath, and a solid disc a dozen
 * pixels across hides it. Outlined, they still mark the spot and the ground
 * shows through.
 */
function ringFires() {
  const ring = currentStyle === 'burn';
  for (let i = 0; i < fires.length; i++) {
    const point = fires.get(i);
    const shade = point.outlineColor;
    point.color = ring ? shade.withAlpha(0.0) : shade.withAlpha(0.8);
    point.outlineWidth = ring ? 2 : 1;
  }
}

let firesAsked = '';

LAYER_ON_DEMAND.fires = () => loadFires();

async function loadFires() {
  if (!LAYERS.find((l) => l.id === 'fires').on) return;
  const rect = scene.camera.computeViewRectangle(scene.globe.ellipsoid);
  const bbox = rect
    ? [rect.west, rect.south, rect.east, rect.north].map((r) => Cesium.Math.toDegrees(r))
    : [-180, -90, 180, 90];
  // Asking again for the same box on every idle camera is pointless.
  const key = bbox.map((v) => v.toFixed(1)).join(',');
  if (key === firesAsked) return;
  firesAsked = key;

  try {
    const data = await getJSON(`/api/fires?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}`);
    fires.removeAll();
    for (const [lat, lon, frp, bright, minutes, sat, conf, dayNight] of data.fires) {
      const shade = FIRE_HEAT.find((h) => frp < h.max).color;
      fires.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        pixelSize: 4 + Math.min(Math.sqrt(frp) * 1.1, 12),
        color: Cesium.Color.fromCssColorString(shade).withAlpha(0.8),
        outlineColor: Cesium.Color.fromCssColorString(shade),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(50_000, 1.5, 15_000_000, 0.45),
        id: { type: 'fire', ref: { lat, lon, frp, bright, minutes, sat, conf, dayNight } },
      });
    }
    ringFires();
    setCount('fires', data.returned);
    // The cap is stated rather than quietly applied: a screen showing the 4000
    // hottest of 200 000 must not read as a screen showing everything.
    log(data.capped
      ? `thermal: ${data.returned} hottest of ${data.total_in_view} in view \u00b7 FIRMS VIIRS 24 h`
      : `thermal: ${data.returned} detections in view \u00b7 FIRMS VIIRS 24 h`);
  } catch (err) {
    log(`thermal feed unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(whileOn('fires', loadFires));
setInterval(whileOn('fires', () => { firesAsked = ''; loadFires(); }), 15 * 60 * 1000);

/* ----------------------------------------------------- google street view */

/*
 * KartaView covers wherever a volunteer has driven with a camera, which is a lot
 * of Europe and not much else. Google covers most roads on earth, and with a key
 * already in the app for the photorealistic tiles it costs nothing extra to ask.
 *
 * Both requests are made from the page rather than the server, and that is not
 * an accident: the key is restricted by HTTP referrer, and a server has none. The
 * same trap cost an evening on the Map Tiles API.
 *
 * The metadata endpoint is free and unlimited, and it answers three things for
 * nothing: whether a panorama exists here at all, where it actually stands, and
 * what month it was taken. So it is always asked first, and the billed image is
 * only fetched once the answer is yes. 10 000 images a month are free; this way
 * a spot with no coverage costs none of them.
 */

/*
 * The interactive panorama, from the Maps JavaScript API - not the Static API
 * this used to use.
 *
 * That was not a preference. Under the EEA terms a project billed to an address
 * in the European Economic Area "may not use any Google Maps Content from the
 * Street View Static API With any Map", and "With any Map" is defined as showing
 * it on, next to, or visually associated with one. A photograph in a panel beside
 * a globe is exactly that. Google name this product as the alternative, and it
 * carries no such restriction.
 *
 * It is also simply better at what was wanted. Walking used to be a guess: ask
 * for a point twenty metres up the street and let radius=60 snap to whatever was
 * nearest. The panorama knows its actual neighbours, so the arrows follow the
 * road, and moving in it moves the globe with it.
 */

const GSV_CONTROLS = {
  addressControl: true,      // the street name, which is half of knowing where you are
  linksControl: true,        // the arrows along the road - the point of the exercise
  panControl: true,
  zoomControl: true,
  fullscreenControl: false,  // the panel has its own EXPAND, and two is confusing
  motionTracking: false,
  enableCloseButton: false,
  showRoadLabels: true,
};

let mapsJs = null;
let pano = null;
let panoService = null;
// Both directions are wired - the globe moves the panorama, the panorama moves the
// globe - so without this the first move starts a loop that never settles.
let gsvSyncing = false;

/** Load the Maps JavaScript API once, on demand. */
function loadMapsJs() {
  if (mapsJs) return mapsJs;
  mapsJs = new Promise((resolve, reject) => {
    if (window.google && google.maps && google.maps.StreetViewPanorama) {
      resolve(google.maps);
      return;
    }
    // Google calls this by name when the key itself is refused, and it is the
    // only place the real reason appears - the script tag just loads fine.
    window.gm_authFailure = () => reject(new Error(
      'Google refused the key for the Maps JavaScript API. Enable "Maps '
      + 'JavaScript API" in the Cloud console, and allow this address on the '
      + "key's website restrictions."));
    window.__gsvReady = () => resolve(google.maps);
    const tag = document.createElement('script');
    tag.src = 'https://maps.googleapis.com/maps/api/js'
      + `?key=${encodeURIComponent(googleKey)}&v=weekly&loading=async`
      // weekly, not alpha: maps3d is on the stable channel, and alpha
      // puts a "development purposes only" banner across the view.
      + '&callback=__gsvReady';
    tag.async = true;
    tag.onerror = () => reject(new Error('the Maps JavaScript API script would not load'));
    document.head.append(tag);
  });
  return mapsJs;
}

async function countStreetView() {
  try {
    await fetch('/api/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'google_streetview' }),
    });
  } catch (_) { /* the picture matters more than the tally */ }
  showQuota();
  renderMeters();
}

/** Put the standing position and heading where the panorama now is. */
function panoMovedGlobe() {
  if (gsvSyncing || !pano || !standing.active) return;
  const here = pano.getPosition();
  if (!here) return;
  const pov = pano.getPov() || { heading: 0 };
  const c = Cesium.Cartographic.fromCartesian(standing.position);
  gsvSyncing = true;
  standing.position = Cesium.Cartesian3.fromDegrees(here.lng(), here.lat(), c.height);
  standing.heading = Cesium.Math.toRadians((pov.heading + 360) % 360);
  applyStanding();
  $('#standing-where').textContent = `${here.lat().toFixed(5)}, ${here.lng().toFixed(5)}`;
  gsvSyncing = false;
}

/**
 * Show Street View for where you are standing, looking the way you are looking.
 *
 * Unlike the still it replaces, turning costs nothing: the panorama is already
 * loaded and simply rotates. Only arriving at a *new* panorama is billed, which
 * is why the heading no longer has to be rounded to keep the bill down.
 */
let gsvLast = '';

async function showStreetView() {
  const panel = $('#gsv-panel');
  if (!standing.active || !$('#gsv').checked || !googleKey) {
    panel.hidden = true;
    return;
  }
  if (gsvSyncing) return;

  const c = Cesium.Cartographic.fromCartesian(standing.position);
  const lat = Cesium.Math.toDegrees(c.latitude);
  const lon = Cesium.Math.toDegrees(c.longitude);
  const heading = (Cesium.Math.toDegrees(standing.heading) + 360) % 360;
  const where = `${lat.toFixed(4)},${lon.toFixed(4)}`;

  let maps;
  try {
    maps = await loadMapsJs();
  } catch (err) {
    panel.hidden = false;
    $('#gsv-pano').hidden = true;
    $('#gsv-note').textContent = err.message;
    log(`street view: ${err.message}`, 'warn');
    return;
  }

  panel.hidden = false;
  if (!panoService) panoService = new maps.StreetViewService();

  // Turning in place: the panorama is already here, so just swing the view.
  if (pano && where === gsvLast) {
    gsvSyncing = true;
    pano.setPov({ heading, pitch: 0 });
    gsvSyncing = false;
    return;
  }

  let found;
  try {
    found = await panoService.getPanorama({
      location: { lat, lng: lon },
      radius: 60,
      // OUTDOOR only rules out interiors, so it still returns somebody's holiday
      // photosphere shot from the pavement - the copyright line read "Camilo
      // Ortiz H" at Times Square. GOOGLE is the camera car and nothing else,
      // which is what "Street View" is taken to mean. Older builds of the API
      // do not define it, hence the fallback.
      source: maps.StreetViewSource.GOOGLE || maps.StreetViewSource.OUTDOOR,
    });
  } catch (err) {
    // ZERO_RESULTS arrives here as a rejection, and is the honest common case.
    $('#gsv-pano').hidden = true;
    $('#gsv-note').textContent = /ZERO_RESULTS/i.test(String(err && err.message))
      ? `no Street View here — nobody has driven this with a camera`
      : `Street View: ${err && err.message ? err.message : err}`;
    return;
  }

  gsvLast = where;
  const data = found.data;
  const at = data.location.latLng;
  $('#gsv-pano').hidden = false;

  gsvSyncing = true;
  if (!pano) {
    pano = new maps.StreetViewPanorama($('#gsv-pano'), {
      ...GSV_CONTROLS,
      pano: data.location.pano,
      pov: { heading, pitch: 0 },
    });
    // Every arrival at a new panorama is the billed event, so the tally is kept
    // here rather than at the request - a turn in place must not count.
    pano.addListener('pano_changed', countStreetView);
    pano.addListener('position_changed', panoMovedGlobe);
    pano.addListener('pov_changed', panoMovedGlobe);
  } else {
    pano.setPano(data.location.pano);
    pano.setPov({ heading, pitch: 0 });
  }
  gsvSyncing = false;

  $('#gsv-note').textContent = [
    // Google give a month, not a day. Reported as given rather than dressed up.
    data.imageDate ? `captured ${data.imageDate}` : '',
    at ? `${at.lat().toFixed(5)}, ${at.lng().toFixed(5)}` : '',
    (data.copyright || '').replace(/^\u00a9\s*/, ''),
    `arrows walk — the globe follows`,
  ].filter(Boolean).join(` · `);
}

$('#gsv').onchange = () => { gsvLast = ''; showStreetView(); };

/* ------------------------------------------------------- walking the street */

/*
 * Walking without the panorama. When Street View is showing it owns the arrows -
 * it knows which panoramas actually adjoin this one, which no amount of stepping
 * twenty metres and snapping to the nearest can match - and moving in it drags
 * the standing camera along. This is what is left for when it is off, or over
 * ground no camera has driven: a plain step across the terrain.
 */

const WALK_METRES = 20;
const WALK_TURN_DEG = 45;
const WALK_COOLDOWN_MS = 350;
let lastWalk = 0;

/** Move the standing position over the ground, keeping the eye height. */
function walkBy(metres, bearingDeg) {
  const c = Cesium.Cartographic.fromCartesian(standing.position);
  const bearing = Cesium.Math.toRadians(bearingDeg);
  const dNorth = Math.cos(bearing) * metres;
  const dEast = Math.sin(bearing) * metres;
  const lat = Cesium.Math.toDegrees(c.latitude)
    + (dNorth / 6371000) * (180 / Math.PI);
  const lon = Cesium.Math.toDegrees(c.longitude)
    + ((dEast / (6371000 * Math.cos(c.latitude))) * 180) / Math.PI;
  standing.position = Cesium.Cartesian3.fromDegrees(lon, lat, c.height);
  applyStanding();
  $('#standing-where').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  gsvLast = '';
  showStreetView();
}

function walkKey(e) {
  if (!standing.active) return;
  if (!/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
  // The panorama has the keyboard when it is up; two things moving the same
  // camera from one keypress is how it ends up somewhere neither intended.
  if (pano && !$('#gsv-panel').hidden && !$('#gsv-pano').hidden) return;
  e.preventDefault();
  if (e.repeat) return;                       // held keys do not spend
  const now = performance.now();
  if (now - lastWalk < WALK_COOLDOWN_MS) return;
  lastWalk = now;

  const heading = (Cesium.Math.toDegrees(standing.heading) + 360) % 360;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const turn = e.key === 'ArrowRight' ? WALK_TURN_DEG : -WALK_TURN_DEG;
    standing.heading = Cesium.Math.toRadians((heading + turn + 360) % 360);
    applyStanding();
    gsvLast = '';
    showStreetView();
  } else {
    walkBy(e.key === 'ArrowUp' ? WALK_METRES : -WALK_METRES, heading);
  }
}

document.addEventListener('keydown', walkKey);

/** Grow the panorama to most of the window, and back. */
function toggleStreetViewSize() {
  const panel = $('#gsv-panel');
  const big = panel.classList.toggle('big');
  $('#gsv-expand').textContent = big ? 'SHRINK' : 'EXPAND';
  // The panorama measured its container when it was built and will keep drawing
  // at the old size until told. Not a new request: the same panorama, re-rendered.
  if (pano && window.google && google.maps) {
    google.maps.event.trigger(pano, 'resize');
  }
}

$('#gsv-expand').onclick = toggleStreetViewSize;

/*
 * What a picked thing is, written into the detail card.
 *
 * This used to live inside the globe's click handler, which was fine while the
 * globe was the only thing you could click. Google's 3D view has its own
 * markers and its own click events, and neither of them is a Cesium pick - so
 * the chain moved out here, and both surfaces call it with the same {type, ref}
 * they already carried. One description of a vessel, not two that drift apart.
 */
function describePicked(type, ref) {
  if (type === 'flight') {
    showDetail(ref.callsign, ref.military ? 'military aircraft · ADS-B' : 'aircraft · ADS-B', [
      ['Class', ref.role ? ref.role.toUpperCase() : ref.military ? 'MILITARY' : 'civil'],
      ['Operator', (ref.registry && ref.registry.owner) || ''],
      ['Airframe', (ref.registry && ref.registry.type) || ''],
      ['ICAO 24', ref.icao.toUpperCase()],
      ['Registration', ref.reg],
      ['Type', ref.acType],
      ['Registered', ref.country],
      ['Altitude', ref.onGround ? 'on ground' : `${Math.round(ref.alt * FT).toLocaleString('en-US')} ft`],
      ['Ground spd', `${Math.round((ref.speed / KNOT))} kt`],
      ['Track', `${Math.round(ref.track)}°`],
      ['Vert rate', `${Math.round(ref.vRate * FT * 60)} ft/min`],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
    ], null, `flight:${ref.icao}`);
    loadDossier(ref);
  } else if (type === 'vessel') {
    showDetail(ref.name, `${ref.kind} · AIS`, [
      ['MMSI', ref.mmsi],
      ['IMO', ref.imo || ''],
      ['Call sign', ref.callSign],
      ['Speed', `${(ref.sog ?? 0).toFixed(1)} kt`],
      ['Course', `${Math.round(ref.track)}°`],
      ['Draught', ref.draught ? `${ref.draught.toFixed(1)} m` : ''],
      ['Destination', ref.destination],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
    ], null, `vessel:${ref.mmsi}`);
    loadVesselPhoto(ref);
  } else if (type === 'camera') {
    showDetail(ref.name, 'public road camera', [
      ['Station', ref.id],
      ['Area', ref.area],
      ['Network', ref.source],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Views', ref.views && ref.views.length > 1 ? `${ref.views.length} directions` : ''],
    ], ref.image, null, ref.views);
    detail.dataset.camera = JSON.stringify(ref);
    $('#project').hidden = false;
  } else if (type === 'satellite') {
    selectSatellite(ref);
    loadSatelliteDossier(ref);
    showDetail(ref.name, `satellite · ${regimeOf(ref.alt).name}`, [
      ['NORAD', ref.norad],
      ['Altitude', `${Math.round(ref.alt).toLocaleString('en-US')} km`],
      ['Speed', `${ref.speed.toFixed(2)} km/s`],
      ['Period', `${ref.period.toFixed(1)} min`],
      ['Inclination', `${ref.inclination.toFixed(2)}°`],
      ['Sub-point', `${ref.lat.toFixed(2)}, ${ref.lon.toFixed(2)}`],
      // Only the station gets these. Everything else up there is either too dim
      // to look for or too numerous to be worth a timetable.
      ...(Number(ref.norad) === ISS_NORAD ? issPassRows() : []),
    ], null, `satellite:${ref.norad}`);
  } else if (type === 'street') {
    showDetail(`Street level · ${ref.date}`, 'kartaview photo', [
      ['Heading', `${Math.round(ref.heading)}°`],
      ['Taken', ref.date],
      ['Position', `${ref.lat.toFixed(5)}, ${ref.lon.toFixed(5)}`],
    ], ref.image);
  } else if (type === 'base') {
    showDetail(ref.name, `${ref.navy} \u00b7 submarine base`, [
      ['Country', ref.country],
      ['Reported home to', ref.classes],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Coordinates', ref.coord_source || 'Wikipedia'],
      ['Note', 'submarines are not tracked — measure what is at the pier'],
    ]);
    if (ref.wiki) loadShipPhoto({ name: ref.name, wiki: ref.wiki });
  } else if (type === 'capital') {
    showDetail(ref.name, `${ref.class}-class ${ref.kind} \u00b7 estimated`, [
      ['Hull', ref.hull],
      ['Area', ref.area],
      ['Reported', ref.status],
      ['Uncertainty', `${ref.uncertainty_km} km radius`],
      ['As of', ref.as_of],
      ['How placed', ref.placed || ''],
      ['Position from', ref.origin === 'usni'
        ? 'read from the tracker automatically'
        : 'typed in by hand from later reporting'],
      ['Source', ref.source],
      ['Read', ref.url],
      // Written on the ship, because that is where the claim is being made.
      ['Written about since', ref.later ? `${ref.later.date} — ${ref.later.title}` : ''],
      ['Read that', ref.later ? ref.later.url : ''],
    ]);
    loadShipPhoto(ref);
  } else if (type === 'jam') {
    const grade = JAM_GRADES[ref.magnitude] || JAM_UNGRADED;
    const mins = ref.delay_s ? Math.round(ref.delay_s / 60) : 0;
    showDetail(ref.what || 'incident', `${grade.label} \u00b7 TomTom`, [
      ['Road', ref.road],
      ['Between', ref.from && ref.to ? `${ref.from} and ${ref.to}` : (ref.from || ref.to)],
      ['Costing', ref.delay_s
        ? `${ref.delay_s} seconds${mins >= 1 ? ` (about ${mins} min)` : ''}`
        : ''],
      ['Stretch', ref.length_m ? `${Math.round(ref.length_m)} m` : ''],
      ['Since', (ref.start || '').replace('T', ' ').slice(0, 16)],
      ['Until', (ref.end || '').replace('T', ' ').slice(0, 16)],
      // The commonest case, and the one most easily misread as a jam.
      ['Note', JAM_GRADES[ref.magnitude] ? ''
        : 'TomTom graded no delay for this one. Roadworks and closures block a '
          + 'road without a measured delay to quote, so this is drawn thin and '
          + 'grey rather than as a queue.'],
    ]);
  } else if (type === 'launch') {
    const away = ref.hours;
    showDetail(ref.name, `launch \u00b7 ${ref.provider || 'unknown operator'}`, [
      ['When', (ref.when || '').replace('T', ' ').slice(0, 16) + ' UTC'],
      ['From now', Number.isFinite(away)
        ? away < 0 ? 'gone' : away < 48
          ? `${Math.round(away)} hours` : `${Math.round(away / 24)} days`
        : ''],
      // Untranslated on purpose: Go means go, TBD means nobody has committed.
      ['Status', ref.status_why ? `${ref.status} \u2014 ${ref.status_why}` : ref.status],
      ['Mission', ref.mission],
      ['Orbit', ref.orbit],
      ['Pad', ref.pad],
      ['Place', ref.place],
      ['Read', ref.url],
      ['Note', 'a schedule, not a fact. Launches slip, and most of these will '
        + 'move at least once before they fly.'],
    ]);
  } else if (type === 'infra') {
    const dam = ref.kind === 'dam';
    showDetail(ref.name || (dam ? 'unnamed dam' : 'unnamed data centre'),
      `${dam ? 'dam' : 'data centre'} \u00b7 OpenStreetMap`, [
        ['Operator', ref.operator],
        ['Height', ref.height_m ? `${ref.height_m} m` : ''],
        ['Position', `${ref.lat.toFixed(5)}, ${ref.lon.toFixed(5)}`],
        ['In OSM', `https://www.openstreetmap.org/${ref.osm}`],
        ['Note', ref.name ? '' : 'OpenStreetMap has no name for this one. Most '
          + 'dams do not have one, and an invented name would be worse.'],
      ]);
  } else if (type === 'air') {
    showDetail(`PM2.5 ${ref.pm25}`, 'micrograms per cubic metre \u00b7 OpenAQ', [
      ['Against the guideline', ref.pm25 <= 15
        ? 'at or under the WHO 24-hour guideline of 15'
        : `${(ref.pm25 / 15).toFixed(1)}x the WHO 24-hour guideline of 15`],
      ['Measured', (ref.when || '').replace('T', ' ').slice(0, 16)],
      ['Station', ref.station ? `OpenAQ location ${ref.station}` : ''],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Note', 'reference monitors and low-cost sensors are reported together '
        + 'here, and are not equally accurate'],
    ]);
  } else if (type === 'fishing') {
    const kind = FISHING_KINDS[ref.kind] || {};
    showDetail(ref.vessel || 'unnamed vessel',
      `${kind.label || ref.kind} \u00b7 Global Fishing Watch`, [
        ['Flag', ref.flag || ''],
        ['Began', (ref.start || '').replace('T', ' ').slice(0, 16)],
        ['Ended', (ref.end || '').replace('T', ' ').slice(0, 16)],
        ['Lasted', ref.hours ? `${Math.round(ref.hours)} hours` : ''],
        ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
        // The whole reason this layer needs a sentence rather than a colour.
        ['What it means', ref.kind === 'gap'
          ? 'the transponder stopped and resumed later. Equipment failure, poor '
            + 'satellite coverage and a missed pass all look like this. It is a '
            + 'question about this vessel, not a finding against it.'
          : ref.kind === 'encounter'
          ? 'two vessels close together and slow for long enough to transfer '
            + 'catch, fuel or people. Ordinary at sea, and also how catch is moved.'
          : 'the track pattern matched fishing rather than transit. Inferred from '
            + 'movement, not observed.'],
      ]);
  } else if (type === 'mark') {
    showDetail(ref.name, 'saved mark', [
      ['Position', `${ref.lat.toFixed(5)}, ${ref.lon.toFixed(5)}`],
      ['Eye height', `${Math.round(ref.height).toLocaleString('en-US')} m`],
      ['Heading', `${Math.round((Cesium.Math.toDegrees(ref.heading) + 360) % 360)}\u00b0`],
    ]);
  } else if (type === 'quake') {
    const when = new Date(ref.time);
    showDetail(`M ${ref.mag.toFixed(1)}`, 'earthquake · USGS', [
      ['Place', ref.place],
      ['Depth', `${Math.round(ref.depth)} km`],
      ['When', when.toISOString().slice(0, 16).replace('T', ' ') + 'Z'],
      ['Felt by', ref.felt ? `${ref.felt} reports` : ''],
      ['Tsunami', ref.tsunami ? 'warning issued' : ''],
      ['Position', `${ref.lat.toFixed(3)}, ${ref.lon.toFixed(3)}`],
    ]);
  } else if (type === 'train') {
    showDetail(`${ref.route || 'train'} ${ref.number}`, 'Amtrak service', [
      ['From', ref.from],
      ['To', ref.to],
      ['State', ref.state],
      ['Speed', ref.speed !== null && ref.speed !== undefined
        ? `${Math.round(ref.speed)} mph` : ''],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
    ]);
  } else if (type === 'mesh') {
    showDetail(ref.name || ref.short || 'mesh node', 'Meshtastic \u00b7 LoRa mesh', [
      ['Short name', ref.short],
      ['Hardware', ref.hardware],
      ['Region', ref.region],
      ['Battery', ref.battery !== null && ref.battery !== undefined
        ? `${ref.battery}%` : ''],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Note', 'only nodes reporting through the public MQTT bridge are visible. '
        + 'Most mesh traffic stays local, which is the point of a mesh.'],
    ]);
  } else if (type === 'news') {
    showDetail(ref.country, `news attention \u00b7 GDELT`, [
      ['Articles', `${ref.articles} in the last window`],
      ['Latest', (ref.top && ref.top.title) || ''],
      ['Read', (ref.top && ref.top.url) || ''],
      ['Note', 'this counts coverage, not events. A free press and a censored '
        + 'one report the same trouble very differently \u2014 a bright dot means '
        + 'attention, which is a reason to look and not a finding.'],
    ]);
  } else if (type === 'netout') {
    showDetail(ref.name, `internet outage \u00b7 ${ref.scope} \u00b7 IODA`, [
      ['Detected by', ref.sources.join(', ')],
      ['Agreement', ref.confidence > 1
        ? `${ref.confidence} independent methods \u2014 likely real`
        : 'one method only \u2014 could be a measurement artefact'],
      ['Level', ref.level],
      ['Note', 'IODA watches BGP withdrawals, active probing and darknet noise. '
        + 'A national outage is usually a cable or a government.'],
    ]);
  } else if (type === 'alert') {
    showDetail(ref.event, `${ref.severity.toLowerCase()} weather \u00b7 US NWS`, [
      ['Area', ref.area],
      ['Urgency', ref.urgency],
      ['Until', ref.until ? ref.until.replace('T', ' ') : ''],
      ['Headline', ref.headline],
      ['What it says', ref.description],
      ['What to do', ref.instruction],
      ['Marker', 'centre of the warned area, which can be a whole county'],
      // The link is the record as published, and that record is JSON. Saying so
      // beats letting somebody click it expecting a weather page and get a wall
      // of braces, which is what happened.
      ['Record (JSON)', ref.url],
    ]);
  } else if (type === 'plant') {
    showDetail(ref.name || 'unnamed station', `power station \u00b7 ${ref.fuel || 'unknown fuel'}`, [
      ['Capacity', `${ref.mw.toLocaleString('en-GB')} MW`],
      ['Fuel', ref.fuel],
      ['Country', ref.country],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Source', 'WRI Global Power Plant Database \u2014 a database release, not '
        + 'a live feed, so a station built last year may be missing'],
    ]);
  } else if (type === 'broadcast') {
    showDetail(ref.name, `radio station · ${[ref.state, ref.country].filter(Boolean).join(', ')}`, [
      ['Plays', ref.tags],
      ['Stream', ref.bitrate ? `${ref.codec} ${ref.bitrate} kbps` : ref.codec],
      ['How live', 'the station\'s own internet stream — what is going out '
        + 'over the air right now, a few seconds behind.'],
      ['Homepage', ref.homepage],
      ['Note', 'a community catalogue, so a stream can be stale or a station '
        + 'missing. Only stations with coordinates can be drawn at all.'],
    ]);
    addPlayer(ref);
  } else if (type === 'airport') {
    showAirport(ref);
  } else if (type === 'aprs') {
    const mins = Math.round(ref.ago_s / 60);
    showDetail(ref.call, 'amateur radio · APRS-IS', [
      ['What', ref.what || `symbol "${ref.symbol}"`],
      ['Heard', mins < 1 ? 'less than a minute ago' : `${mins} min ago`],
      ['Comment', ref.comment],
      ['Path', ref.path],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['How live', 'positions, not audio \u2014 there is nothing to listen to '
        + 'here. Packets appear as they are sent.'],
      ['Note', 'the operator broadcast this about themselves. Relayed by a '
        + 'volunteer igate, so the path shows who passed it along.'],
    ]);
  } else if (type === 'scanner') {
    showDetail(ref.name, 'public-safety radio \u00b7 OpenMHZ', [
      ['Where', ref.place],
      ['Traffic', `${ref.calls_per_min} calls a minute`],
      ['Listening now', `${ref.listeners}`],
      ['Last call', ref.last ? `${ref.last}Z` : ''],
      ['About', ref.detail],
      ['Listen', ref.url],
      ['How live', 'seconds behind, and not a continuous channel. Each '
        + 'transmission is published once the speaker lets go of the button '
        + '\u2014 measured at 5 to 20 seconds. Whole sentences, slightly late.'],
      ['Note', 'recorded by a volunteer running a receiver, not fed by the '
        + 'agency. United States only.'],
    ]);
  } else if (type === 'radio') {
    const room = ref.slots > 0 && ref.users < ref.slots;
    showDetail(ref.name, 'shortwave receiver \u00b7 KiwiSDR', [
      ['Where', ref.place || `${ref.lat.toFixed(3)}, ${ref.lon.toFixed(3)}`],
      ['Coverage', ref.band],
      ['Antenna', ref.antenna],
      ['Listeners', ref.slots
        ? `${ref.users} of ${ref.slots}${room ? '' : ' \u2014 full, try another'}`
        : `${ref.users}`],
      ['Noise', ref.snr ? `SNR ${ref.snr}` : ''],
      ['Hardware', ref.hardware],
      ['Listen', ref.url],
      ['How live', 'genuinely live \u2014 you are hearing that antenna as the '
        + 'signal arrives, about a second behind, and you choose the frequency.'],
      ['Note', 'somebody else\'s receiver and somebody else\'s bandwidth. '
        + 'Slots are shared \u2014 take one, listen, and leave.'],
      ['Who is on air', 'https://www.short-wave.info/'],
    ]);
    if (room) addTuningPresets(ref);
  } else if (type === 'volcano') {
    showDetail(ref.name, 'continuing eruption \u00b7 Smithsonian GVP', [
      ['Erupting since', ref.started || 'an unrecorded date'],
      ['Explosivity', ref.vei !== null
        ? `VEI ${ref.vei} \u2014 logarithmic, so each step is ten times the ejecta`
        : 'not indexed'],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Note', 'a curated catalogue, not a sensor. An eruption appears once '
        + 'somebody confirmed it, and one that has quietly stopped can linger '
        + 'in the list.'],
    ]);
  } else if (type === 'navaid') {
    const khz = Number(ref.khz);
    const tuned = Number.isFinite(khz)
      ? (khz >= 100000 ? `${(khz / 1000).toFixed(3)} MHz` : `${khz} kHz`)
      : ref.khz;
    showDetail(`${ref.ident} ${ref.name}`, `${ref.type} · OurAirports`, [
      ['Tune', tuned],
      ['DME channel', ref.dme_channel || 'none'],
      ['Belongs to', ref.airport || 'no airport listed'],
      ['Power', ref.power || 'not published'],
      ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Note', 'a beacon, not an approach. There is no ILS in this data at '
        + 'all — no localiser, no glideslope, no minima. Those are in the '
        + 'national AIP.'],
    ]);
  } else if (type === 'metar') {
    showMetar(ref);
  } else if (type === 'runway') {
    const r = ref;
    const landing = ref.end === 'he' ? r.he : r.le;
    const heading = ref.end === 'he' ? r.he_heading : r.le_heading;
    showDetail(`${r.airport} runway ${r.le}/${r.he}`,
      ref.end ? `approach line to ${landing} \u00b7 OurAirports`
                 : 'runway \u00b7 OurAirports', [
        ['Length', r.length_ft
          ? `${r.length_ft.toLocaleString('en-US')} ft (${Math.round(r.length_ft * 0.3048).toLocaleString('en-US')} m)`
          : 'not published'],
        ['Width', r.width_ft ? `${r.width_ft} ft` : 'not published'],
        ['Surface', r.surface || 'not published'],
        ['Lit', r.lit ? 'yes' : 'not according to the record'],
        ['Headings', `${r.le} at ${r.le_heading}\u00b0 true, `
          + `${r.he} at ${r.he_heading}\u00b0 true`],
        ref.end ? ['Landing on', `${landing}, heading ${heading}\u00b0 true`] : null,
        r.closed ? ['Closed', 'this runway is marked closed in the record'] : null,
        ['The green line', 'ten nautical miles along the runway bearing, '
          + 'computed here. It is where a straight-in approach would be, and it '
          + 'is not a procedure: real approaches have step-downs, offsets and '
          + 'turns that only a published chart carries, and those charts are '
          + 'licensed. Do not fly this.'],
        ['Note', 'geometry from OurAirports, which is community-maintained and '
          + 'public domain. It can lag a resurfacing or a renumbering.'],
      ].filter(Boolean));
  } else if (type === 'swroad') {
    const kind = ROAD_KIND_SHORT[ref.kind] || ref.kind || 'disruption';
    showDetail(ref.road || ref.where.slice(0, 40) || 'Road disruption',
      `${kind} · Trafikverket`, [
        ['Severity', ref.severity || 'not stated by the source'],
        ['Where', ref.where],
        ['What', ref.what],
        ['From', (ref.start || '').replace('T', ' ').slice(0, 16)],
        ['Until', ref.open_ended
          ? 'until further notice — no end date given'
          : (ref.end || '').replace('T', ' ').slice(0, 16) || 'not stated'],
        ['Read', ref.link],
        ['Note', 'Sweden only. Trafikverket publish this for the state road '
          + 'network, so a municipal street closure is not in here.'],
      ]);
  } else if (type === 'swrail') {
    showTrain(ref);
  } else if (type === 'smhi') {
    showDetail(ref.event || 'Weather warning',
      `${ref.level || 'warning'} · SMHI`, [
        ['Area', ref.area],
        ['Detail', ref.detail],
        ['From', (ref.start || '').replace('T', ' ').slice(0, 16)],
        ['Until', (ref.end || '').replace('T', ' ').slice(0, 16)
          || 'no end given'],
        ['Marker', 'the shaded area is the warning area, drawn as published. '
          + 'It is not a point, and the middle of it is not more warned than '
          + 'the edge.'],
        ['Note', 'Sweden only. Yellow, orange and red are SMHI’s own scale; '
          + 'Meddelande is information rather than a warning.'],
      ]);
  } else if (type === 'own') {
    showDetail(ref.title, 'HAND-ENTERED \u00b7 not from any feed', [
      ['Where', ref.place || `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
      ['Entered', ref.date],
      ['Detail', ref.detail],
      ['Source', ref.source],
      ['Read', ref.url],
      ['Note', 'typed in by hand from a published report. No satellite or feed '
        + 'saw this \u2014 it is here because somebody read about it.'],
    ]);
  } else if (type === 'outbreak') {
    const items = ref.items || [ref];
    showDetail(
      items.length > 1 ? `${items.length} outbreaks` : items[0].disease,
      'disease outbreak \u00b7 WHO',
      [
        ['Place', ref.place || items[0].place],
        ['Marker', 'country centroid \u2014 WHO reports at country level, so this '
          + 'is not where the cases are'],
        ['Status', 'each date is when WHO published, not when the outbreak ended'],
        ['Not shown here', 'WHO publishes an outbreak when it crosses an '
          + 'international threshold. A national outbreak handled by a national '
          + 'agency never appears \u2014 27 measles cases across nine Swedish '
          + 'regions in August 2026 are absent from this layer. For those, ask '
          + 'the country: Folkh\u00e4lsomyndigheten, RKI, UKHSA, CDC, or ECDC '
          + 'for Europe as a whole.'],
      ]
    );
    for (const item of items) {
      addField(item.date, item.disease
        + (item.updates > 1 ? ` \u00b7 ${item.updates} reports` : ''));
      if (item.url) addField('Read', item.url);
    }
  } else if (type === 'fire') {
    const when = new Date(ref.minutes * 60000);
    const platform = ref.sat === 'N20' ? 'VIIRS NOAA-20'
      : ref.sat === 'N' ? 'VIIRS Suomi-NPP' : `VIIRS ${ref.sat}`;
    showDetail(
      `${ref.frp.toFixed(1)} MW`,
      'thermal anomaly · NASA FIRMS',
      [
        ['Radiative power', `${ref.frp.toFixed(1)} MW`],
        ['Brightness', `${ref.bright.toFixed(0)} K`],
        ['Detected', when.toISOString().slice(0, 16).replace('T', ' ') + 'Z'],
        ['Platform', platform],
        ['Confidence', ref.conf],
        ['Pass', ref.dayNight === 'N' ? 'night' : 'day'],
        ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
        ['Note', 'heat, not necessarily wildfire — flares and volcanoes read the same'],
      ]
    );
  } else if (type === 'building') {
    showDetail(ref.name || 'Unnamed structure', `${ref.kind} · OSM footprint`, [
      ['Height', `${ref.h} m`],
      ['Levels', Math.max(1, Math.round(ref.h / 3.2))],
    ]);
  } else if (type === 'cable') {
    showDetail(ref.name, 'submarine cable system', [['System ID', ref.id]]);
  } else if (type === 'landing') {
    showDetail(ref.name || 'Landing point', 'cable landing point', [
      ['Country', ref.country],
      ['ID', ref.id],
    ]);
  }
}

/* ------------------------------------------------------ satellite dossier */

/*
 * The orbit is computed here from elements, which says where a thing is but
 * nothing about what it is for. CelesTrak's catalogue supplies the identity -
 * payload or spent stage, whose, launched when, still working or not - and
 * Wikipedia supplies a picture and a paragraph for anything notable.
 *
 * Most of the catalogue is debris and rocket bodies that no encyclopaedia has
 * ever written about. That is a real answer: the card says nothing is known
 * rather than reaching for the nearest article and implying it fits.
 */

async function loadSatelliteDossier(sat) {
  const query = new URLSearchParams({ norad: sat.norad, name: sat.name || '' });
  let dossier;
  try {
    dossier = await getJSON('/api/satellite?' + query);
  } catch (_) {
    return;
  }
  // The card may have moved on to another object while this was in flight.
  if (detail.dataset.target !== `satellite:${sat.norad}`) return;

  const cat = dossier.catalogue;
  if (cat) {
    addField('Object', [cat.kind, cat.status].filter(Boolean).join(' · '));
    addField('Operator', cat.owner);
    addEntityExpand(cat.owner, 'Who operates it');
    addField('Launched', [cat.launched, cat.site].filter(Boolean).join(' · '));
    addField('Designator', cat.designator);
    // Radar cross-section is the only size the catalogue offers, and it is a
    // radar echo rather than a measurement of the spacecraft.
    if (cat.rcs_m2) addField('Radar size', `${cat.rcs_m2.toFixed(1)} m² echo`);
    if (cat.decayed) addField('Decayed', cat.decayed);
  }

  const about = dossier.about;
  if (!about) {
    // The name is the more reliable signal here. A catalogue record can be
    // missing or stale, but "SL-16 R/B" is a spent upper stage whatever the
    // catalogue says, and calling that an unwritten-about spacecraft is wrong.
    const spent = /R\/B|\bDEB\b|DEBRIS|FRAGMENT/i.test(sat.name || '');
    addField('Mission', spent || (cat && cat.kind && cat.kind !== 'payload')
      ? 'not a spacecraft — a spent stage or fragment, so no mission'
      : 'nothing published under this name');
    return;
  }

  if (about.photo) {
    const img = $('#detail-image');
    img.src = about.photo;
    if (about.photo_full) img.dataset.full = about.photo_full;
    if (about.url) img.dataset.link = about.url;
    img.hidden = false;
  }

  // Which thing the article is actually about. A Starlink shell has one page
  // between eight thousand spacecraft, and that page is not about this one.
  const scope = {
    object: '',
    constellation: ` — about the ${about.title} fleet, not this spacecraft`,
    related: ` — nearest article, not about this object`,
  }[about.scope] || '';
  addField('Mission', trimSummary(about.summary) + scope);
  addField('Reference', about.title);
}

/** Two sentences is a caption; the whole article is not. */
function trimSummary(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 260) return clean;
  const cut = clean.slice(0, 260);
  const stop = cut.lastIndexOf('. ');
  return (stop > 120 ? cut.slice(0, stop + 1) : cut.trimEnd() + '…');
}

/* ------------------------------------------------------------------- trains */

/*
 * The one form of transport this globe had nothing of. Amtrak publish openly
 * enough to plot without a key; Finland's feed refuses every Accept header I
 * could construct, which the layer note says rather than leaving a Finn to
 * wonder.
 *
 * A small glyph rather than a dot, because a train on a map should look like a
 * train and there was already a glyph factory here for aircraft.
 */

GLYPHS.train = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(4, 2, 8, 11);       // body
  g.fillRect(3, 13, 10, 2);      // undercarriage
  g.clearRect(6, 4, 4, 3);       // window
  return c;
})();

LAYER_ON_DEMAND.trains = () => loadTrains();

async function loadTrains() {
  try {
    const data = await getJSON('/api/trains');
    trains.removeAll();
    for (const t of data.trains) {
      trains.add({
        image: GLYPHS.train,
        scale: 0.5,
        alignedAxis: Cesium.Cartesian3.ZERO,
        position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, 0),
        color: Cesium.Color.fromCssColorString('#c4b5fd'),
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.1, 5e6, 0.35),
        id: { type: 'train', ref: t },
      });
    }
    setCount('trains', data.trains.length);
    log(`trains: ${data.trains.length} Amtrak services running`);
  } catch (err) {
    log(`trains unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* --------------------------------------------------------------- mesh radio */

/*
 * Meshtastic is LoRa mesh networking on hardware that costs less than a meal: a
 * few grams that relays text between nodes with no infrastructure at all. Where
 * the shortwave layer is receivers you can listen through, this is a network
 * that exists without anybody's permission.
 *
 * Off by default and loaded by view. Thirty-one thousand nodes is a green fog at
 * global zoom, and the honest caveat is in the note: only nodes reporting through
 * the public MQTT bridge appear. Most mesh traffic is local and never leaves the
 * mesh, which is rather the point of it.
 */

let meshAsked = '';

LAYER_ON_DEMAND.mesh = () => loadMesh();

async function loadMesh() {
  if (!LAYERS.find((l) => l.id === 'mesh').on) return;
  const rect = scene.camera.computeViewRectangle(scene.globe.ellipsoid);
  const bbox = rect
    ? [rect.west, rect.south, rect.east, rect.north].map((r) => Cesium.Math.toDegrees(r))
    : [-180, -90, 180, 90];
  const key = bbox.map((v) => v.toFixed(1)).join(',');
  if (key === meshAsked) return;
  meshAsked = key;
  try {
    const data = await getJSON(`/api/mesh?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}`);
    meshNodes.removeAll();
    for (const n of data.nodes) {
      meshNodes.add({
        position: Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 0),
        pixelSize: 5,
        color: Cesium.Color.fromCssColorString('#34d399').withAlpha(0.7),
        outlineColor: Cesium.Color.fromCssColorString('#6ee7b7'),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(3e4, 1.4, 5e6, 0.4),
        id: { type: 'mesh', ref: n },
      });
    }
    setCount('mesh', data.nodes.length);
    log(data.capped
      ? `mesh: ${data.nodes.length} of ${data.total_in_view} nodes in view \u00b7 Meshtastic`
      : `mesh: ${data.nodes.length} nodes in view \u00b7 Meshtastic`);
  } catch (err) {
    log(`mesh nodes unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(loadMesh);

/* ------------------------------------------------------------ news attention */

/*
 * GDELT reads the world's news and tags each article with where it came from.
 * Aggregated, that answers something no sensor can: where attention is right
 * now.
 *
 * It counts coverage and not events, and the difference matters enough to be on
 * the card. A country with a free press and one without produce very different
 * numbers for the same trouble, so a bright dot can mean a crisis or simply a lot
 * of journalists. It is a pointer to look somewhere, never evidence of what is
 * there.
 */

LAYER_ON_DEMAND.news = () => loadNewsHeat();

async function loadNewsHeat() {
  try {
    const data = await getJSON('/api/newsheat');
    newsHeat.removeAll();
    const top = Math.max(1, ...data.places.map((p) => p.articles));
    for (const pl of data.places) {
      const share = pl.articles / top;
      newsHeat.add({
        position: Cesium.Cartesian3.fromDegrees(pl.lon, pl.lat, 0),
        pixelSize: 8 + share * 16,
        color: Cesium.Color.fromCssColorString('#fcd34d').withAlpha(0.2 + share * 0.3),
        outlineColor: Cesium.Color.fromCssColorString('#fcd34d').withAlpha(0.8),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.2, 4e7, 0.6),
        id: { type: 'news', ref: pl },
      });
    }
    setCount('news', data.places.length);
    log(`news: coverage from ${data.places.length} countries \u00b7 GDELT`);
  } catch (err) {
    log(`news attention unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* -------------------------------------------------- outages and the frontline */

/*
 * IODA watches the internet three ways at once - BGP withdrawals, active
 * probing, darknet background noise - and raises an alert when a place goes
 * quiet. Agreement between the methods is the whole signal: one source alone is
 * a measurement artefact as often as an outage, so the dot grows with how many
 * agree and the card names them.
 *
 * A national outage is usually a cable or a government. Either is a story.
 */

LAYER_ON_DEMAND.netout = () => loadNetOutages();

async function loadNetOutages() {
  try {
    const data = await getJSON('/api/netoutages');
    netOut.removeAll();
    let placed = 0;
    for (const o of data.outages) {
      if (o.lat === null) continue;
      placed += 1;
      netOut.add({
        position: Cesium.Cartesian3.fromDegrees(o.lon, o.lat, 0),
        pixelSize: 9 + o.confidence * 4,
        color: Cesium.Color.fromCssColorString('#fb7185').withAlpha(0.3),
        outlineColor: Cesium.Color.fromCssColorString('#fb7185'),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.3, 4e7, 0.6),
        id: { type: 'netout', ref: o },
      });
    }
    setCount('netout', placed);
    log(`internet: ${placed} regions with outage alerts \u00b7 IODA`);
  } catch (err) {
    log(`internet outages unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}


/* ------------------------------------------------------------------ recon */

/*
 * Registry lookups, proxied through our own server so the browser never talks
 * to a third party directly and so private addresses can be refused before any
 * request is made. Nothing here touches the target: it is all published by the
 * registries about themselves.
 */

$('#recon-go').onclick = async () => {
  const kind = $('#recon-kind').value;
  const target = $('#recon-target').value.trim();
  const out = $('#recon-out');
  if (!target) { out.textContent = 'nothing to look up'; return; }
  out.textContent = 'asking the registry\u2026';
  try {
    const data = await getJSON(
      `/api/recon?kind=${kind}&target=${encodeURIComponent(target)}`
    );
    // Which of the two DNS questions was asked, when the answer does not
    // make that obvious on its own.
    out.textContent = (data.asked ? data.asked + '\n\n' : '')
      + reconSummary(kind, data.result);
    log(`recon ${kind}: ${target}`);
  } catch (err) {
    out.textContent = err.message;
  }
};

/** The two or three lines worth reading out of each registry's answer. */
function reconSummary(kind, r) {
  if (!r) return 'no answer';
  if (kind === 'dns') {
    // Type 1 is an A record, type 12 is a PTR. Filtering on 1 alone meant a
    // reverse lookup came back as "no A record", which is technically true
    // and hides the answer that was sitting right there.
    const answers = (r.Answer || []).filter((a) => a.type === 1 || a.type === 12);
    if (!answers.length) return `no answer (status ${r.Status})`;
    return answers
      .map((a) => `${a.name} \u2192 ${a.data}  (ttl ${a.TTL}s)`)
      .join('\n');
  }
  if (kind === 'geo') {
    return [
      `${r.city || '?'}, ${r.regionName || '?'}, ${r.country || '?'}`,
      `${r.isp || ''}`,
      r.as ? `${r.as}` : '',
      (r.lat && r.lon) ? `${r.lat}, ${r.lon}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'ports') {
    return [
      `ports: ${(r.ports || []).join(', ') || 'none seen'}`,
      `hostnames: ${(r.hostnames || []).slice(0, 4).join(', ') || 'none'}`,
      `vulns: ${(r.vulns || []).join(', ') || 'none listed'}`,
      'from Shodan InternetDB \u2014 what their scanners saw, not a live probe',
    ].join('\n');
  }
  if (kind === 'whois') {
    const org = (r.entities || []).map((e) => (e.vcardArray || [])[1])
      .flat().filter((x) => Array.isArray(x) && x[0] === 'fn').map((x) => x[3]);
    return [
      `${r.handle || ''}`,
      r.name ? `name: ${r.name}` : '',
      r.country ? `country: ${r.country}` : '',
      org.length ? `org: ${org.slice(0, 3).join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'net') {
    const d = r.data || {};
    return [
      d.resource ? `prefix: ${d.resource}` : '',
      (d.asns || []).map((a) => `AS${a.asn} ${a.holder || ''}`).join('\n'),
      d.block ? `block: ${d.block.desc || d.block.resource || ''}` : '',
    ].filter(Boolean).join('\n');
  }
  return JSON.stringify(r, null, 1).slice(0, 1200);
}

/* ------------------------------------------------------- weather and power */

/*
 * Severe weather, from the US National Weather Service. United States only, and
 * the layer name says so: no open feed covers the rest of the world, and a
 * European looking at an empty map deserves to know it is the feed and not the
 * weather.
 *
 * Alerts that reference a zone rather than a shape carry no geometry, and the
 * server drops those rather than guessing. A warning drawn over the wrong county
 * is worse than one that is missing.
 */

const ALERT_COLOURS = { Extreme: '#ff4d6d', Severe: '#f472b6' };

LAYER_ON_DEMAND.weather = () => loadWeatherAlerts();

async function loadWeatherAlerts() {
  try {
    const data = await getJSON('/api/weather');
    alerts.removeAll();
    for (const a of data.alerts) {
      const shade = ALERT_COLOURS[a.severity] || '#f472b6';
      alerts.add({
        position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat, 0),
        pixelSize: a.severity === 'Extreme' ? 11 : 8,
        color: Cesium.Color.fromCssColorString(shade).withAlpha(0.45),
        outlineColor: Cesium.Color.fromCssColorString(shade),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2e5, 1.3, 2e7, 0.5),
        id: { type: 'alert', ref: a },
      });
    }
    setCount('weather', data.alerts.length);
    log(`weather: ${data.alerts.length} severe or extreme alerts \u00b7 NWS, US only`);
  } catch (err) {
    log(`weather alerts unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/*
 * Power stations from WRI. Off by default: thirty-five thousand of them is a
 * rash across the map that hides everything else, and it is a reference layer
 * rather than news. Loaded by view, like the fires, and sized by capacity so a
 * nuclear station reads differently from a village solar farm.
 */

const FUEL_COLOURS = {
  Nuclear: '#a3e635', Coal: '#78716c', Gas: '#fbbf24', Oil: '#f97316',
  Hydro: '#38bdf8', Wind: '#67e8f9', Solar: '#fde047', Biomass: '#84cc16',
  Geothermal: '#fb7185', Waste: '#a8a29e',
};

let plantsAsked = '';

LAYER_ON_DEMAND.plants = () => loadPlants();

async function loadPlants() {
  if (!LAYERS.find((l) => l.id === 'plants').on) return;
  const rect = scene.camera.computeViewRectangle(scene.globe.ellipsoid);
  const bbox = rect
    ? [rect.west, rect.south, rect.east, rect.north].map((r) => Cesium.Math.toDegrees(r))
    : [-180, -90, 180, 90];
  const key = bbox.map((v) => v.toFixed(1)).join(',');
  if (key === plantsAsked) return;
  plantsAsked = key;
  try {
    const data = await getJSON(`/api/powerplants?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}`);
    plants.removeAll();
    for (const pl of data.plants) {
      const shade = FUEL_COLOURS[pl.fuel] || '#a8a29e';
      plants.add({
        position: Cesium.Cartesian3.fromDegrees(pl.lon, pl.lat, 0),
        // Capacity spans four orders of magnitude, so the root of it, not it.
        pixelSize: 4 + Math.min(Math.sqrt(pl.mw) * 0.5, 14),
        color: Cesium.Color.fromCssColorString(shade).withAlpha(0.55),
        outlineColor: Cesium.Color.fromCssColorString(shade),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.3, 1e7, 0.45),
        id: { type: 'plant', ref: pl },
      });
    }
    setCount('plants', data.plants.length);
    log(data.capped
      ? `power: ${data.plants.length} largest of ${data.total_in_view} in view \u00b7 WRI`
      : `power: ${data.plants.length} stations in view \u00b7 WRI`);
  } catch (err) {
    log(`power stations unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(loadPlants);

/* ------------------------------------------------------------ space weather */

/*
 * Kp is the one number that says whether tonight is worth pointing a camera at
 * the sky. Quasi-logarithmic, 0 to 9: 4 unsettled, 5 a storm, 7 aurora over
 * mid-latitudes, 9 the sort of night people photograph from Rome. The peak over
 * the last day is shown too, because a quiet minute inside a stormy day is not
 * the story.
 */

async function loadSpaceWeather() {
  try {
    const kp = await getJSON('/api/spaceweather');
    const out = $('#kp-readout');
    if (kp.kp === null || kp.kp === undefined) { out.textContent = ''; return; }
    out.textContent = `KP ${kp.estimated.toFixed(1)} \u00b7 ${kp.level}`
      + (kp.peak_24h > kp.estimated + 1 ? ` \u00b7 peak ${kp.peak_24h.toFixed(1)}` : '');
    out.classList.toggle('storm', kp.estimated >= 5 && kp.estimated < 7);
    out.classList.toggle('severe', kp.estimated >= 7);
    if (kp.estimated >= 5) {
      log(`space weather: Kp ${kp.estimated.toFixed(1)}, ${kp.level} \u00b7 NOAA SWPC`);
    }
  } catch (_) { /* the sky is not the point of the app */ }
}

/* ------------------------------------------------------------- tuning presets */

/*
 * "Are there normal stations?" is a fair question with an awkward answer.
 *
 * Shortwave has no stations in the FM sense - you tune a frequency and hear
 * whoever is transmitting on it, which changes with the hour, the season and the
 * sunspot cycle. Some 220 broadcasters are still on air, but their frequencies
 * are reissued every season: the current A26 schedule runs to 25 October and then
 * every number in it changes. A hardcoded station list would be wrong by winter.
 *
 * So these presets are the things that do *not* move. Time signals have been on
 * the same frequencies for decades. Aviation and maritime allocations are treaty
 * matters. Band edges are fixed even though their occupants are not. For who is
 * broadcasting right now, the card links to a live schedule instead of pretending
 * to know.
 */

const TUNE_PRESETS = [
  {
    group: 'Time signals \u2014 always on, good for testing a receiver',
    items: [
      { f: 10000, mode: 'am', name: 'WWV Colorado', note: 'voice time, continuous' },
      { f: 5000, mode: 'am', name: 'WWV / WWVH', note: 'better at night' },
      { f: 15000, mode: 'am', name: 'WWV 15 MHz', note: 'better by day' },
      { f: 7850, mode: 'usb', name: 'CHU Canada', note: 'French and English' },
    ],
  },
  {
    group: 'Aviation \u2014 oceanic air traffic, in English',
    items: [
      { f: 8906, mode: 'usb', name: 'Shanwick / Gander', note: 'North Atlantic day' },
      { f: 5616, mode: 'usb', name: 'North Atlantic night', note: 'same traffic, lower band' },
      { f: 13270, mode: 'usb', name: 'Shannon VOLMET', note: 'continuous weather' },
      { f: 8957, mode: 'usb', name: 'Shannon VOLMET night', note: '' },
    ],
  },
  {
    group: 'Maritime and distress',
    items: [
      { f: 4125, mode: 'usb', name: 'Distress and calling', note: 'quiet is good news' },
      { f: 8764, mode: 'usb', name: 'US Coast Guard', note: 'weather and safety' },
    ],
  },
  {
    group: 'Amateur \u2014 people talking to each other',
    items: [
      { f: 7100, mode: 'lsb', name: '40 m voice', note: 'busy at night' },
      { f: 14200, mode: 'usb', name: '20 m voice', note: 'busy by day, long distance' },
      { f: 14074, mode: 'usb', name: '20 m FT8', note: 'digital warble, always busy' },
    ],
  },
  {
    group: 'Broadcast bands \u2014 tune around, someone is there',
    items: [
      { f: 6000, mode: 'am', name: '49 m band', note: 'best after dark' },
      { f: 9500, mode: 'am', name: '31 m band', note: 'the reliable one' },
      { f: 11800, mode: 'am', name: '25 m band', note: 'daytime' },
      { f: 15300, mode: 'am', name: '19 m band', note: 'daylight, long haul' },
    ],
  },
];

/** A KiwiSDR opens on a frequency if you ask it to: ?f=9500am */
function tuneUrl(receiver, preset) {
  const base = (receiver.url || '').replace(/\/+$/, '');
  return `${base}/?f=${preset.f}${preset.mode}`;
}

/**
 * The nearest receiver with a slot free, to whatever is on screen.
 *
 * Distance matters on shortwave: a receiver near the transmitter hears it, and
 * one on the far side of the planet may not. Nearest-to-view is a decent guess
 * at "somewhere this signal reaches".
 */
function nearestReceiver() {
  const c = scene.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(c.latitude);
  const lon = Cesium.Math.toDegrees(c.longitude);
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < radios.length; i++) {
    const r = radios.get(i).id.ref;
    if (!(r.slots > 0 && r.users < r.slots)) continue;
    const d = Math.abs(r.lat - lat) + Math.abs(r.lon - lon);
    if (d < bestScore) { bestScore = d; best = r; }
  }
  return best;
}

/** Preset buttons for one receiver, appended to its detail card. */
function addTuningPresets(receiver) {
  const dl = $('#detail-fields');
  for (const block of TUNE_PRESETS) {
    const dt = document.createElement('dt');
    dt.textContent = block.group;
    dt.className = 'tune-group';
    const dd = document.createElement('dd');
    for (const preset of block.items) {
      const a = document.createElement('a');
      a.className = 'tune-preset';
      a.href = tuneUrl(receiver, preset);
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = `${preset.name} \u00b7 ${preset.f / 1000} MHz`;
      a.title = [preset.note, `opens ${receiver.name} tuned to ${preset.f} kHz ${preset.mode.toUpperCase()}`]
        .filter(Boolean).join(' \u2014 ');
      dd.append(a);
    }
    dl.append(dt, dd);
  }
}

/* ------------------------------------------------------------ entity graph */

/*
 * A transponder says what an aircraft is, never who is behind it. The operator
 * has a parent, the parent has an owner and a country and a chief executive, and
 * all of that is on Wikidata under CC0 without a key.
 *
 * It is a button rather than automatic, for two reasons. Most of the time you do
 * not care who owns the airline you are watching, and three Wikidata calls for
 * every contact you happen to click would be rude to a service that asks for
 * nothing in return.
 */

function addEntityExpand(name, label) {
  if (!name || name.length < 3) return;
  const dl = $('#detail-fields');
  const dt = document.createElement('dt');
  dt.textContent = label || 'Who is behind it';
  const dd = document.createElement('dd');
  const button = document.createElement('button');
  button.className = 'chip entity-expand';
  button.textContent = `LOOK UP ${name.toUpperCase().slice(0, 28)}`;
  button.onclick = async () => {
    button.textContent = 'LOOKING\u2026';
    button.disabled = true;
    try {
      const data = await getJSON(`/api/entity?q=${encodeURIComponent(name)}`);
      dd.innerHTML = '';
      if (!data.found) {
        dd.textContent = `Wikidata has nothing under "${name}"`;
        return;
      }
      const head = document.createElement('div');
      head.className = 'entity-head';
      head.textContent = data.description
        ? `${data.label} \u2014 ${data.description}` : data.label;
      dd.append(head);

      // Several claims share a relation - three CEOs, three countries - so they
      // are grouped rather than repeated, which is how a person would say it.
      const grouped = new Map();
      for (const link of data.links || []) {
        if (!link.text) continue;
        if (!grouped.has(link.relation)) grouped.set(link.relation, []);
        grouped.get(link.relation).push(link.text);
      }
      for (const [relation, values] of grouped) {
        const row = document.createElement('div');
        row.className = 'entity-row';
        row.innerHTML = `<span class="entity-rel">${relation}</span>`;
        row.append(document.createTextNode(values.join(', ')));
        dd.append(row);
      }
      for (const [key, text] of [['wikipedia', 'Wikipedia'], ['url', 'Wikidata']]) {
        if (!data[key]) continue;
        const a = document.createElement('a');
        a.href = data[key];
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.className = 'field-link';
        a.textContent = text + ' \u2197';
        dd.append(a);
      }
    } catch (err) {
      dd.textContent = `lookup failed (${err.message})`;
    }
  };
  dd.append(button);
  dl.append(dt, dd);
}

/* ------------------------------------------------------- broadcast radio */

/*
 * Ordinary radio - the station somebody in that town has on in the car. None of
 * the other radio layers can do it: FM is 88-108 MHz and the KiwiSDR network
 * stops at 30, so a receiver in Florida physically cannot hear a Florida FM
 * station. What can is the station's own internet stream.
 *
 * And because those are ordinary MP3 and AAC streams, they play *here* rather
 * than in a tab somebody else owns. Click a dot, press play, hear the town.
 */

/*
 * Radio markers used to be a 7 px dot at 65% opacity. Over the ops basemap that
 * reads; over satellite imagery it does not, because a soft green dot on green
 * farmland is the one thing the eye cannot pick out, and a station you cannot
 * find is a station you do not have.
 *
 * So: bigger, opaque, and ringed in near-black. The dark ring is what actually
 * does the work - it separates the mark from whatever is behind it, light or
 * dark, instead of hoping the fill happens to contrast. They also stop shrinking
 * so far with distance, and ignore the depth buffer, so a station in a valley is
 * not swallowed by the hill in front of it.
 */
/*
 * How far a marker may ignore the depth buffer.
 *
 * POSITIVE_INFINITY was the obvious value and the wrong one: it means "never let
 * anything hide this", and the earth is a thing. A rocket pad in New Zealand
 * drew straight through the planet while the camera was over Europe, so a grey
 * dot sat near the middle of the screen and followed the view around - reported
 * as "it is with me the whole time", which is exactly what an antipodal marker
 * looks like.
 *
 * Fifty kilometres keeps the intent - a mark in a valley is not swallowed by the
 * hill in front of it - while letting the globe itself occlude anything on the
 * far side, which is what a globe is for.
 */
const MARK_THROUGH_M = 50000;

const MARK_HALO = Cesium.Color.fromCssColorString('#04070c');

LAYER_ON_DEMAND.broadcast = () => loadBroadcast(true);

let broadcastAt = '';

async function loadBroadcast(force) {
  if (!LAYERS.find((l) => l.id === 'broadcast').on) return;
  const c = scene.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(c.latitude);
  const lon = Cesium.Math.toDegrees(c.longitude);
  // Radius follows the view, so a country view finds a country's stations.
  const radius = Math.max(30, Math.min(c.height / 1000, 800));
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${Math.round(radius)}`;
  if (key === broadcastAt && !force) return;
  broadcastAt = key;

  try {
    const data = await getJSON(
      `/api/broadcast?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=${Math.round(radius)}`
    );
    broadcast.removeAll();
    for (const st of data.stations) {
      broadcast.add({
        position: Cesium.Cartesian3.fromDegrees(st.lon, st.lat, 0),
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString('#34d399'),
        outlineColor: MARK_HALO,
        outlineWidth: 2.5,
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.5, 5e6, 0.85),
        disableDepthTestAgainstTerrain: true,
        disableDepthTestDistance: MARK_THROUGH_M,
        id: { type: 'broadcast', ref: st },
      });
    }
    setCount('broadcast', data.stations.length);
    // The commonest first question about this layer: why is there radio in one
    // corner of the world and nowhere else. Because it asks about where you are
    // looking, and a bare count does not say so.
    log(`radio stations: ${data.stations.length} within ${Math.round(radius)} km `
      + `of this view \u00b7 move the camera to load elsewhere \u00b7 Radio Browser`);
  } catch (err) {
    log(`station list unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(() => loadBroadcast(false));

/**
 * Hand a station to the player that lives outside the detail card.
 *
 * The first version put an <audio> element inside the card, which worked until
 * you clicked anything else: showDetail empties the card, the element leaves the
 * DOM, and the music stops. Listening to Tampa Bay while looking at aircraft is
 * the whole point of having both, so the player is a fixture and the card only
 * points at it.
 */
function playStation(station) {
  const audio = $('#np-audio');
  const bar = $('#nowplaying');

  if (station.hls) {
    log(`${station.name}: HLS stream, which needs a player this app does not `
      + 'carry \u2014 the station homepage will have one', 'warn');
    return;
  }

  audio.src = station.url;
  $('#np-name').textContent = station.name;
  $('#np-name').title = station.name;
  $('#np-where').textContent = [
    [station.state, station.country].filter(Boolean).join(', '),
    station.bitrate ? `${station.codec} ${station.bitrate} kbps` : station.codec,
  ].filter(Boolean).join(' \u00b7 ');
  bar.hidden = false;
  audio.play().catch(() => {
    $('#np-where').textContent = 'the stream did not open \u2014 catalogues go '
      + 'stale, and stations move.';
  });
  log(`playing ${station.name}`);
}

function stopStation() {
  const audio = $('#np-audio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  $('#nowplaying').hidden = true;
}

$('#np-stop').onclick = stopStation;

/** A button on the card, rather than the player itself. */
function addPlayer(station) {
  const dl = $('#detail-fields');
  const dt = document.createElement('dt');
  dt.textContent = 'Listen';
  const dd = document.createElement('dd');

  if (station.hls) {
    dd.textContent = 'HLS stream \u2014 needs a player this app does not carry. '
      + 'The homepage below will have it.';
  } else {
    const button = document.createElement('button');
    button.className = 'chip';
    button.textContent = 'PLAY';
    button.onclick = () => playStation(station);
    dd.append(button);
    const note = document.createElement('span');
    note.className = 'play-note';
    note.textContent = ' keeps playing while you look at other things';
    dd.append(note);
  }
  dl.append(dt, dd);
}


/* --------------------------------------------------------------- airports */

/*
 * Aviation radio is the interesting kind, and the honest position is that most
 * of it is out of reach here. Tower and approach are VHF around 118-137 MHz; the
 * KiwiSDR network stops at 30. Those receivers do hear oceanic HF - Shanwick,
 * Gander, the VOLMET weather loops - and the tuning presets cover it, but that is
 * aircraft crossing an ocean, not a tower.
 *
 * LiveATC carries the VHF feeds behind a Cloudflare challenge that gates even
 * robots.txt, which is a clear enough statement about automated access. So this
 * layer does not fetch from them: it puts the airport on the map and offers a
 * link, which is a person clicking through to a website exactly as intended.
 */

LAYER_ON_DEMAND.airports = () => loadAirports();

let airportsAsked = '';

async function loadAirports() {
  if (!LAYERS.find((l) => l.id === 'airports').on) return;
  const rect = scene.camera.computeViewRectangle(scene.globe.ellipsoid);
  const bbox = rect
    ? [rect.west, rect.south, rect.east, rect.north].map((r) => Cesium.Math.toDegrees(r))
    : [-180, -90, 180, 90];
  const key = bbox.map((v) => v.toFixed(1)).join(',');
  if (key === airportsAsked) return;
  airportsAsked = key;

  try {
    const data = await getJSON(`/api/airports?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}`);
    airports.removeAll();
    for (const a of data.airports) {
      airports.add({
        position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat, 0),
        pixelSize: a.big ? 9 : 5,
        color: Cesium.Color.fromCssColorString('#fcd34d').withAlpha(a.big ? 0.7 : 0.4),
        outlineColor: Cesium.Color.fromCssColorString('#fde68a'),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.3, 2e7, 0.5),
        id: { type: 'airport', ref: a },
      });
    }
    setCount('airports', data.airports.length);
    const cut = data.total_in_view - data.airports.length;
    log(`airports: ${data.airports.length} in view${cut > 0 ? `, ${cut} not drawn` : ''} \u00b7 OurAirports`);
  } catch (err) {
    log(`airport list unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(loadAirports);
viewer.camera.moveEnd.addEventListener(() => loadRunways(false));
viewer.camera.moveEnd.addEventListener(() => loadMetar(false));
viewer.camera.moveEnd.addEventListener(() => loadNavaids(false));
// Observations are issued twice an hour; this asks a little more often so
// a change is never more than five minutes stale on screen.
setInterval(whileOn('metar', () => loadMetar(true)), 5 * 60_000);

/* ------------------------------------------------------------------- aprs */

/*
 * Radio amateurs broadcasting where they are, relayed onto the internet by
 * volunteers running igates. Cars, weather stations, digipeaters on hilltops,
 * balloons, the occasional boat.
 *
 * The server holds one read-only connection to APRS-IS and aims its filter at
 * whatever is on screen, so this asks for the view rather than the world. Off by
 * default: it is a dense layer and most people are not looking for it.
 *
 * Only uncompressed position packets are drawn. APRS has compressed and object
 * formats too, and a half-understood parser inventing coordinates is worse than
 * a layer that admits it skipped some.
 */

LAYER_ON_DEMAND.aprs = () => loadAprs();

let aprsAsked = '';

async function loadAprs() {
  if (!LAYERS.find((l) => l.id === 'aprs').on) return;
  const rect = scene.camera.computeViewRectangle(scene.globe.ellipsoid);
  const bbox = rect
    ? [rect.west, rect.south, rect.east, rect.north].map((r) => Cesium.Math.toDegrees(r))
    : [-180, -90, 180, 90];
  const key = bbox.map((v) => v.toFixed(1)).join(',');
  if (key === aprsAsked) return;
  aprsAsked = key;

  try {
    const data = await getJSON(`/api/aprs?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}`);
    aprs.removeAll();
    for (const st of data.stations) {
      // Fade with age: a packet from a minute ago is a station, one from fifty
      // minutes ago is a memory of one.
      const fresh = Math.max(0.25, 1 - st.ago_s / 3600);
      aprs.add({
        position: Cesium.Cartesian3.fromDegrees(st.lon, st.lat, 0),
        pixelSize: 6,
        color: Cesium.Color.fromCssColorString('#a78bfa').withAlpha(0.3 + 0.5 * fresh),
        outlineColor: Cesium.Color.fromCssColorString('#c4b5fd'),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.3, 5e6, 0.45),
        id: { type: 'aprs', ref: st },
      });
    }
    setCount('aprs', data.stations.length);
    log(`aprs: ${data.stations.length} stations in view, ${data.held} held \u00b7 `
      + `${data.connected ? 'connected' : 'reconnecting'} \u00b7 APRS-IS read-only`);
  } catch (err) {
    log(`aprs unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(loadAprs);

/* ------------------------------------------------------------- scanners */

/*
 * OpenMHZ records trunked public-safety radio - police, fire, ambulance - and
 * plays the calls back. Clicking a system is listening to a dispatcher.
 *
 * Fetched by the page rather than the server, and that is a deliberate choice
 * rather than a convenience. Their API sits behind a bot check that refuses
 * anything which does not look like a browser. The server could have dressed up
 * as one - it did, briefly - but sending a User-Agent you are not is asking
 * forgiveness rather than permission. A browser calling an API that publishes
 * CORS headers has actual permission, and if OpenMHZ would rather it did not,
 * the request simply fails and this layer stays empty. That is the correct
 * outcome, not a problem to route around.
 *
 * United States only, which the layer name says, and off by default for that
 * reason.
 */

LAYER_ON_DEMAND.scanners = () => loadScanners();

let scannersLoaded = false;

async function loadScanners() {
  if (!LAYERS.find((l) => l.id === 'scanners').on || scannersLoaded) return;

  let systems;
  try {
    const res = await fetch('https://api.openmhz.com/systems');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    systems = (await res.json()).systems || [];
  } catch (err) {
    log('scanners: OpenMHZ will not serve this page directly '
      + `(${err.message}). Nothing to draw.`, 'warn');
    scannersLoaded = true;
    return;
  }

  // Busiest first, so the geocoding budget is spent where somebody is talking.
  const live = systems.filter((x) => x.active)
    .sort((a, b) => (b.clientCount || 0) - (a.clientCount || 0));

  scanners.removeAll();
  let placed = 0;
  for (const sys of live.slice(0, 120)) {
    const where = [sys.city, sys.county && `${sys.county} County`, sys.state]
      .filter(Boolean).join(', ');
    if (!where) continue;
    let point;
    try {
      point = await getJSON(`/api/geocode?q=${encodeURIComponent(where + ', USA')}`);
    } catch (_) { continue; }
    if (point.lat === null) continue;
    placed += 1;
    scanners.add({
      position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 0),
      pixelSize: 6 + Math.min((sys.callAvg || 0) * 1.5, 8),
      color: Cesium.Color.fromCssColorString('#60a5fa').withAlpha(0.6),
      outlineColor: Cesium.Color.fromCssColorString('#bfdbfe'),
      outlineWidth: 1,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.3, 2e7, 0.5),
      id: { type: 'scanner', ref: {
        name: sys.name || sys.shortName,
        place: where,
        listeners: sys.clientCount || 0,
        calls_per_min: Math.round((sys.callAvg || 0) * 10) / 10,
        detail: sys.description || '',
        url: sys.shortName ? `https://openmhz.com/system/${sys.shortName}` : '',
        last: (sys.lastActive || '').slice(0, 16).replace('T', ' '),
      } },
    });
    setCount('scanners', placed);
  }
  scannersLoaded = true;
  log(`scanners: ${placed} live systems placed \u00b7 OpenMHZ \u00b7 US only`);
  applyVisibility();
}

/* -------------------------------------------------------------------- radio */

/*
 * Some 900 people have put a shortwave receiver on the public internet and left
 * it open. Click one and you are listening through that antenna, on whatever
 * frequency you tune: a hurricane net from the Caribbean, a numbers station,
 * aircraft over the North Atlantic.
 *
 * The receiver's own web interface does the tuning and the audio, so LISTEN
 * opens it rather than this app trying to reimplement a waterfall. Most are
 * plain http on a home connection, which a browser will not let an https page
 * embed - and a new tab is the honest way to hand somebody to somebody else's
 * machine anyway.
 *
 * Colour says whether there is room: a receiver with every slot taken is not
 * one you can use, and finding that out by clicking is a waste of a click.
 */

LAYER_ON_DEMAND.radio = () => loadRadios();

async function loadRadios() {
  try {
    const data = await getJSON('/api/kiwisdr');
    radios.removeAll();
    let free = 0;
    for (const r of data.receivers) {
      const room = r.slots > 0 && r.users < r.slots;
      if (room) free += 1;
      radios.add({
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString(room ? '#7dd3fc' : '#4a5b6b')
          .withAlpha(room ? 0.75 : 0.4),
        outlineColor: MARK_HALO,
        outlineWidth: 2.5,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 2e7, 0.85),
        disableDepthTestDistance: MARK_THROUGH_M,
        id: { type: 'radio', ref: r },
      });
    }
    setCount('radio', data.receivers.length);
    log(`radio: ${data.receivers.length} shortwave receivers, ${free} with a free slot \u00b7 KiwiSDR`);
  } catch (err) {
    log(`radio list unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ----------------------------------------------------------- volcanoes */

/*
 * The Smithsonian keeps the eruption catalogue, and the useful question it can
 * answer is not "what erupted today" - it is curated, so that lags - but "what is
 * still going". Two dozen volcanoes are, at any time, and the app had no way to
 * show them.
 *
 * Size follows the Volcanic Explosivity Index, which is logarithmic: a 3 throws
 * a hundred times the ejecta of a 1. So the dot scales by the index rather than
 * by it directly, or Merapi at VEI 1 would be invisible beside a 5.
 */

LAYER_ON_DEMAND.volcanoes = () => loadVolcanoes();
LAYER_ON_DEMAND.runways = () => loadRunways(true);
LAYER_ON_DEMAND.metar = () => loadMetar(true);
LAYER_ON_DEMAND.navaids = () => loadNavaids(true);
LAYER_ON_DEMAND.swroad = () => loadSwedenRoad();
LAYER_ON_DEMAND.swrail = () => loadSwedenRail();
LAYER_ON_DEMAND.smhi = () => loadSmhi();

async function loadVolcanoes() {
  try {
    const data = await getJSON('/api/volcanoes');
    volcanoes.removeAll();
    for (const v of data.volcanoes) {
      const vei = Number(v.vei);
      const size = 8 + (Number.isFinite(vei) ? vei * 2.4 : 0);
      volcanoes.add({
        position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, 0),
        pixelSize: size,
        color: Cesium.Color.fromCssColorString('#ff8c42').withAlpha(0.45),
        outlineColor: Cesium.Color.fromCssColorString('#ffb37a'),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(2e5, 1.4, 3e7, 0.55),
        id: { type: 'volcano', ref: v },
      });
    }
    setCount('volcanoes', data.volcanoes.length);
    log(`volcanoes: ${data.volcanoes.length} continuing eruptions \u00b7 Smithsonian GVP`);
  } catch (err) {
    log(`volcano feed unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------------ own entries */

/*
 * The feeds cover what the feeds cover, and that is less than what happens. WHO
 * publishes an outbreak once it crosses an international threshold; a national
 * one of 27 cases goes to the national agency and stops there. GDACS alerts
 * above a severity. Neither has an opinion about a strike, a border closure or a
 * factory fire that made the local paper.
 *
 * So: a file for things read about, following the pattern carriers.json set.
 * Hand-edited, dated, and drawn in amber with the words HAND-ENTERED on the card,
 * because the one thing that must never happen is a viewer taking one of these
 * for something a satellite saw.
 *
 * The camera supplies the position. Flying somewhere and pressing a button beats
 * typing coordinates, and it is the same gesture as leaving a mark.
 */

LAYER_ON_DEMAND.own = () => loadOwnEntries();

async function loadOwnEntries() {
  try {
    const data = await getJSON('/api/manual');
    ownEntries.removeAll();
    const list = $('#own-list');
    list.innerHTML = '';

    for (const e of data.events) {
      ownEntries.add({
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0),
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#ffb347').withAlpha(0.3),
        outlineColor: Cesium.Color.fromCssColorString('#ffb347'),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.4, 2e7, 0.5),
        id: { type: 'own', ref: e },
      });

      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'own-when';
      when.textContent = e.date;
      const what = document.createElement('span');
      what.textContent = e.title;
      const drop = document.createElement('button');
      drop.className = 'own-drop';
      drop.textContent = '\u00d7';
      drop.title = 'remove this entry';
      drop.onclick = (ev) => {
        ev.stopPropagation();
        removeOwnEntry(e.id, e.title);
      };
      li.append(when, what, drop);
      li.onclick = () => {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 120000),
          orientation: flightOrientation(),
          duration: 2.4,
          complete: carryCameraInto3D,
        });
      };
      list.append(li);
    }
    setCount('own', data.events.length);
  } catch (err) {
    log(`own entries unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

async function removeOwnEntry(id, title) {
  try {
    const res = await fetch('/api/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: id }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    log(`own entry removed: ${title}`);
    loadOwnEntries();
  } catch (err) {
    log(`could not remove that entry (${err.message})`, 'warn');
  }
}

$('#own-add').onclick = async () => {
  const c = scene.camera.positionCartographic;
  const body = {
    title: $('#own-title').value.trim(),
    place: $('#own-place').value.trim(),
    url: $('#own-url').value.trim(),
    detail: $('#own-detail').value.trim(),
    source: (() => {
      // The domain is a good enough default attribution to show on the card.
      try { return new URL($('#own-url').value.trim()).hostname.replace(/^www\./, ''); }
      catch (_) { return ''; }
    })(),
    lat: Cesium.Math.toDegrees(c.latitude),
    lon: Cesium.Math.toDegrees(c.longitude),
  };
  try {
    const res = await fetch('/api/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    for (const id of ['#own-title', '#own-place', '#own-url', '#own-detail']) {
      $(id).value = '';
    }
    log(`own entry added: ${body.title}`);
    loadOwnEntries();
  } catch (err) {
    log(`could not add that entry (${err.message})`, 'warn');
  }
};

/* ------------------------------------------------------- disease outbreaks */

/*
 * WHO's Disease Outbreak News, which is the authoritative record of what is
 * spreading where. Two honesty problems come with it, and both are handled by
 * saying so rather than by hiding them.
 *
 * A marker sits on a country centroid, because that is the resolution WHO
 * reports at. It is not where the cases are, and the card says so - a dot in the
 * middle of the Congo is not a claim about a village.
 *
 * And an outbreak that WHO reported once in April may be over. The date is the
 * date of the report, never of the situation, and it is always shown.
 */

LAYER_ON_DEMAND.outbreaks = () => loadOutbreaks();

async function loadOutbreaks() {
  try {
    const data = await getJSON('/api/outbreaks');
    outbreaks.removeAll();

    /*
     * One marker per place, not per report.
     *
     * WHO reports at country level, so two outbreaks in the same country get
     * the same centroid and the second dot lands exactly on the first. Measles
     * in Bangladesh was invisible under Nipah virus for that reason - drawn,
     * counted, and impossible to see or click.
     *
     * Grouping is the honest fix rather than nudging them apart: the position
     * really is one point for the whole country, so one point is what it gets,
     * and the card lists everything reported there.
     */
    const byPlace = new Map();
    let reports = 0;
    for (const o of data.outbreaks) {
      if (o.lat === null) continue;
      reports += 1;
      const key = `${o.lat.toFixed(3)},${o.lon.toFixed(3)}`;
      if (!byPlace.has(key)) {
        byPlace.set(key, { lat: o.lat, lon: o.lon, place: o.place, items: [] });
      }
      byPlace.get(key).items.push(o);
    }

    for (const group of byPlace.values()) {
      // Newest first, so the card leads with what is current.
      group.items.sort((a, b) => (a.date < b.date ? 1 : -1));
      const newest = group.items[0];
      // Age fades the dot: a report from this month is not last spring's.
      const days = (Date.now() - Date.parse(newest.date)) / 86400000;
      const fresh = Math.max(0.25, 1 - days / 240);
      outbreaks.add({
        position: Cesium.Cartesian3.fromDegrees(group.lon, group.lat, 0),
        // Size says how much is going on there, not how loud one report was.
        pixelSize: 9 + Math.min(group.items.length * 3, 9),
        color: Cesium.Color.fromCssColorString('#c77dff').withAlpha(0.35 * fresh + 0.2),
        outlineColor: Cesium.Color.fromCssColorString('#c77dff'),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.3, 4e7, 0.6),
        id: { type: 'outbreak', ref: group },
      });
    }

    setCount('outbreaks', byPlace.size);
    const unplaced = data.outbreaks.length - reports;
    log(`outbreaks: ${reports} reports at ${byPlace.size} places`
      + `${unplaced ? `, ${unplaced} naming no single location` : ''} \u00b7 WHO`);
  } catch (err) {
    log(`outbreak feed unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------- names and borders */

/*
 * Over satellite imagery and false colour there are no names at all, and that is
 * exactly when you stop knowing where you are. The HUD names the region under the
 * camera, but a readout in a corner is not the same as reading it off the map.
 *
 * Two halves, one switch. Names come from CARTO's label-only tiles, which are
 * transparent and composite over whatever imagery is beneath. Lines come from
 * Natural Earth, drawn as ground polylines so they follow terrain rather than
 * floating over it - the same fix the submarine cables needed when they shifted
 * as you zoomed.
 *
 * National borders are drawn brighter than internal ones. A country boundary is
 * a different kind of fact from a provincial one, and at a glance you want to
 * know which you are looking at.
 */

/*
 * CARTO started watermarking. Their tiles still answer 200 with a real image,
 * but the image now reads API KEY REQUIRED across it - which means nothing in
 * the app could detect the failure. The globe simply came up covered in it, on
 * the default optic, for everybody.
 *
 * Esri's dark canvas is the same job without a key. The trade is licensing
 * rather than looks: CARTO was one of the clean sources and Esri is not, so
 * commercial-safe mode swaps this out along with the rest of them - which is
 * the machinery that already existed for exactly this.
 */
const LABEL_TILES =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';

let labelLayer = null;
let borderPrimitive = null;

function showNames(on) {
  // Labels are an imagery layer, so they ride above the basemap rather than
  // replacing it. Added once and toggled, because rebuilding it re-fetches.
  if (on && !labelLayer) {
    labelLayer = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: LABEL_TILES,
        maximumLevel: 18,
        credit: new Cesium.Credit('Labels © Esri and its licensors'),
      })
    );
  }
  if (labelLayer) labelLayer.show = on;
  if (borderPrimitive) borderPrimitive.show = on;
}

LAYER_ON_DEMAND.names = () => loadBorders();

async function loadBorders() {
  try {
    const data = await getJSON('/api/borders');
    const instances = [];

    const add = (lines, colour, width) => {
      for (const flat of lines) {
        if (!flat || flat.length < 4) continue;
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(flat),
            width,
            arcType: Cesium.ArcType.GEODESIC,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(colour),
          },
        }));
      }
    };

    add(data.states, Cesium.Color.fromCssColorString('#94a3b8').withAlpha(0.35), 1.0);
    add(data.countries, Cesium.Color.fromCssColorString('#e2e8f0').withAlpha(0.65), 1.6);

    if (borderPrimitive) scene.primitives.remove(borderPrimitive);
    borderPrimitive = scene.primitives.add(new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
    }));

    setCount('names', data.countries.length + data.states.length);
    log(`names: ${data.countries.length} country borders, ${data.states.length} internal `
      + '\u00b7 Natural Earth, labels by Esri');
  } catch (err) {
    log(`borders unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------------ satellites */

/*
 * CelesTrak publishes orbital elements, not positions, so the browser does the
 * orbital mechanics itself: SGP4 via satellite.js, against the wall clock.
 * All 16 000 at once would stall the frame, so the catalogue is swept a piece at
 * a time, resuming where it left off.
 *
 * The piece used to be a fixed 2000 objects, estimated at 2 ms. Measured on a
 * loaded machine it was 9.4 ms — more than half the frame, before Cesium drew
 * anything, which is what a hang is made of. A count cannot know how fast the
 * machine is; a deadline can. So the sweep now runs for a couple of milliseconds
 * and stops wherever it got to.
 *
 * The cost of stopping early is staleness. A satellite moves some 7.5 km/s, so a
 * sweep spread over half a second leaves a position ~4 km behind — a fraction of
 * a pixel at any altitude from which the whole orbit is visible.
 */

const satellites = [];
const SAT_BUDGET_MS = 2;
let satCursor = 0;

const REGIMES = [
  { name: 'LEO', max: 2000, color: Cesium.Color.fromCssColorString('#7fe8ff') },
  { name: 'MEO', max: 30000, color: Cesium.Color.fromCssColorString('#ffb347') },
  { name: 'GEO / HEO', max: Infinity, color: Cesium.Color.fromCssColorString('#ff8ad8') },
];

const regimeOf = (km) => REGIMES.find((r) => km < r.max);

LAYER_ON_DEMAND.satellites = () => loadSatellites();

async function loadSatellites() {
  if (typeof satellite === 'undefined') {
    log('satellite.js missing — orbital layer disabled', 'warn');
    return;
  }
  try {
    const res = await fetch('/api/satellites');
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const lines = (await res.text()).split(/\r?\n/);
    for (let i = 0; i + 2 < lines.length; i += 3) {
      const name = lines[i].trim();
      const l1 = lines[i + 1];
      const l2 = lines[i + 2];
      if (!l1 || l1[0] !== '1' || !l2 || l2[0] !== '2') continue;
      let satrec;
      try {
        satrec = satellite.twoline2satrec(l1, l2);
      } catch (_) {
        continue;
      }
      if (!satrec || satrec.error) continue;
      satellites.push({
        name,
        norad: l1.slice(2, 7).trim(),
        satrec,
        // mean motion is revolutions per day in the TLE; satrec keeps rad/min
        period: (2 * Math.PI) / satrec.no,
        inclination: Cesium.Math.toDegrees(satrec.inclo),
        point: null,
        alt: 0,
        speed: 0,
        lat: 0,
        lon: 0,
      });
    }
    for (const sat of satellites) {
      sat.point = collections.satellites.add({
        position: Cesium.Cartesian3.ZERO,
        pixelSize: 2,
        color: Cesium.Color.WHITE,
        id: { type: 'satellite', ref: sat },
        show: false,
      });
    }
    setCount('satellites', satellites.length);
    log(`orbit: ${satellites.length} tracked objects`);
    // No budget for this one: the sky should be populated before the first
    // frame, and measured, the whole catalogue costs about 23 ms once. Passing
    // satellites.length here used to mean a count; under a deadline it silently
    // became "you have sixteen seconds", which on a slow machine is a hang.
    propagate(new Date(), Infinity);
  } catch (err) {
    log(`orbital elements unavailable (${err.message})`, 'warn');
  }
}

const satScratch = new Cesium.Cartesian3();

/** One object, moved to where it is now. Split out so the sweep can stop. */
function stepSatellite(sat, when, gmst) {
  let eci;
  try {
    eci = satellite.propagate(sat.satrec, when);
  } catch (_) {
    sat.point.show = false;
    return;
  }
  if (!eci || !eci.position || Number.isNaN(eci.position.x)) {
    sat.point.show = false; // decayed or numerically unstable element set
    return;
  }
  const geo = satellite.eciToGeodetic(eci.position, gmst);
  const v = eci.velocity;
  sat.lat = Cesium.Math.toDegrees(geo.latitude);
  sat.lon = Cesium.Math.toDegrees(geo.longitude);
  sat.alt = geo.height;
  sat.speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
  sat.point.position = Cesium.Cartesian3.fromRadians(
    geo.longitude, geo.latitude, geo.height * 1000, undefined, satScratch
  );
  sat.point.color = regimeOf(sat.alt).color;
  sat.point.show = true;
}

let satSweptLast = 0;

function propagate(when, budgetMs = SAT_BUDGET_MS) {
  if (!satellites.length) return;
  const gmst = satellite.gstime(when);
  const deadline = performance.now() + budgetMs;
  let swept = 0;
  while (swept < satellites.length) {
    stepSatellite(satellites[satCursor], when, gmst);
    satCursor = satCursor + 1 >= satellites.length ? 0 : satCursor + 1;
    swept += 1;
    // performance.now() is not free either, so the clock is read in batches.
    if ((swept & 127) === 0 && performance.now() >= deadline) break;
  }
  satSweptLast = swept;
}

/** One full revolution of the selected object, drawn ahead of and behind it. */
function drawOrbit(sat) {
  orbitTrack.removeAll();
  const steps = 180;
  const now = Date.now();
  const positions = [];
  for (let i = 0; i <= steps; i++) {
    const when = new Date(now + ((i / steps - 0.5) * sat.period) * 60_000);
    const eci = satellite.propagate(sat.satrec, when);
    if (!eci || !eci.position || Number.isNaN(eci.position.x)) continue;
    const geo = satellite.eciToGeodetic(eci.position, satellite.gstime(when));
    positions.push(
      Cesium.Cartesian3.fromRadians(geo.longitude, geo.latitude, geo.height * 1000)
    );
  }
  if (positions.length < 2) return;
  orbitTrack.add({
    positions,
    width: 2.2,
    material: Cesium.Material.fromType('Color', {
      color: Cesium.Color.fromCssColorString('#ffb347').withAlpha(0.9),
    }),
  });
}

/** The selected object has to stand out from 16 000 identical dots. */
let selectedSat = null;

function selectSatellite(sat) {
  if (selectedSat && selectedSat.point) {
    selectedSat.point.pixelSize = 2;
    selectedSat.point.outlineWidth = 0;
  }
  selectedSat = sat;
  if (sat.point) {
    sat.point.pixelSize = 9;
    sat.point.outlineWidth = 2;
    sat.point.outlineColor = Cesium.Color.fromCssColorString('#ffb347');
  }
  drawOrbit(sat);
}

/* ------------------------------------------------- dead reckoning + clock */

let lastFrame = performance.now();

const advanceScratch = new Cesium.Cartesian3();

function advance(entry, dt, heightMetres) {
  if (!entry.billboard || !entry.speed) return;
  const rad = Cesium.Math.toRadians(entry.track);
  const dNorth = Math.cos(rad) * entry.speed * dt;
  const dEast = Math.sin(rad) * entry.speed * dt;
  entry.lat += (dNorth / 6371000) * (180 / Math.PI);
  entry.lon += ((dEast / (6371000 * Math.cos(Cesium.Math.toRadians(entry.lat)))) * 180) / Math.PI;
  entry.lon = ((entry.lon + 540) % 360) - 180;
  // The result vector is reused. Allocating one per contact per frame meant
  // some eight thousand short-lived objects every frame, which is a garbage
  // collector pause every few seconds rather than a steady frame rate.
  entry.billboard.position = Cesium.Cartesian3.fromDegrees(
    entry.lon, entry.lat, heightMetres(entry), undefined, advanceScratch
  );
}

/*
 * Nothing was ever hidden for being off screen, so a city view still carried
 * every contact on earth: thirty thousand billboards and points, each one
 * considered every frame, at exactly the moment terrain and photogrammetry want
 * the machine for themselves.
 *
 * The view rectangle is the cheap test — a few comparisons against a lat/lon
 * that is already to hand. Zoomed out to the whole globe it excludes nothing,
 * which is correct: that is when you want to see everything at once.
 */

const viewScratch = new Cesium.Rectangle();
let viewWest = -Math.PI, viewEast = Math.PI;
let viewSouth = -Math.PI / 2, viewNorth = Math.PI / 2;
let viewWraps = false;
let viewKnown = false;

function readViewRectangle() {
  const rect = scene.camera.computeViewRectangle(scene.globe.ellipsoid, viewScratch);
  if (!rect) {
    // An oblique or horizon-filling view has no rectangle. Cull nothing rather
    // than guess, so contacts never vanish for the wrong reason.
    viewKnown = false;
    return;
  }
  // A margin keeps something about to slide into frame moving before it arrives.
  const padLat = Math.max((rect.north - rect.south) * 0.25, 0.01);
  const span = rect.east >= rect.west
    ? rect.east - rect.west
    : rect.east - rect.west + Cesium.Math.TWO_PI;
  const padLon = Math.max(span * 0.25, 0.01);

  viewSouth = rect.south - padLat;
  viewNorth = rect.north + padLat;
  viewWest = rect.west - padLon;
  viewEast = rect.east + padLon;
  viewWraps = viewEast - viewWest >= Cesium.Math.TWO_PI ? false : rect.east < rect.west;
  viewKnown = viewEast - viewWest < Cesium.Math.TWO_PI || viewWraps;
}

/** Degrees in, because that is what the feeds give us. */
function inView(lon, lat) {
  if (!viewKnown) return true;
  const latR = Cesium.Math.toRadians(lat);
  if (latR < viewSouth || latR > viewNorth) return false;
  const lonR = Cesium.Math.toRadians(lon);
  return viewWraps
    ? lonR >= viewWest || lonR <= viewEast
    : lonR >= viewWest && lonR <= viewEast;
}

const flightHeight = (e) => (e.onGround ? 0 : e.alt);
const seaLevel = () => 0;

scene.preRender.addEventListener(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 1);
  lastFrame = now;
  readViewRectangle();
  if (collections.flights.show) {
    for (const f of flights.values()) {
      const visible = inView(f.lon, f.lat);
      if (f.billboard) f.billboard.show = visible;
      if (visible) advance(f, dt, flightHeight);
    }
  }
  if (collections.vessels.show) {
    for (const v of vessels.values()) {
      const visible = inView(v.lon, v.lat);
      if (v.billboard) v.billboard.show = visible;
      if (visible) advance(v, dt, seaLevel);
    }
  }
  // Satellites are hundreds of kilometres up and visible from far outside the
  // ground rectangle, so they are not culled by it.
  if (collections.satellites.show) propagate(new Date());
});

setInterval(() => {
  $('#clock').textContent = new Date().toISOString().slice(11, 19) + 'Z';
}, 1000);


/*
 * Cameras and cable landings never move, so they have no business in the frame
 * loop — but four thousand and two thousand of them respectively still cost the
 * renderer something while sitting on the far side of the planet. They are
 * culled once the camera stops instead, which is the only time the answer can
 * have changed.
 */
function cullStatic() {
  readViewRectangle();
  for (const collection of [collections.cameras, collections.landings]) {
    for (let i = 0; i < collection.length; i++) {
      const primitive = collection.get(i);
      const at = primitive.gcvAt;
      if (at) primitive.show = inView(at[0], at[1]);
    }
  }
}

viewer.camera.moveEnd.addEventListener(cullStatic);

/* --------------------------------------------------------------- picking */

const detail = $('#detail');
let cameraRefresh = null;

let cameraViews = [];
let cameraViewIndex = 0;

function showCameraView() {
  const station = cameraViews[cameraViewIndex];
  if (!station) return;
  const img = $('#detail-image');
  const bust = () => {
    img.src = station.image + (station.image.includes('?') ? '&' : '?') + 't=' + Date.now();
  };
  clearInterval(cameraRefresh);
  bust();
  cameraRefresh = setInterval(bust, 30_000);
  $('#view-label').textContent = `${cameraViewIndex + 1} / ${cameraViews.length}`;
}

function stepCameraView(delta) {
  cameraViewIndex = (cameraViewIndex + delta + cameraViews.length) % cameraViews.length;
  showCameraView();
}

$('#view-prev').onclick = () => stepCameraView(-1);
$('#view-next').onclick = () => stepCameraView(1);

function showDetail(title, kind, fields, imageUrl, follow, views) {
  $('#detail-title').textContent = title;
  $('#detail-kind').textContent = kind;

  // A new selection releases any previous lock and route.
  if (followed) stopFollow();
  clearRoute();
  delete detail.dataset.camera;
  $('#project').hidden = true;
  if (follow) {
    detail.dataset.target = follow;
    $('#follow').hidden = false;
  } else {
    delete detail.dataset.target;
    $('#follow').hidden = true;
  }

  if (projection.station) stopProjection();
  cameraViews = views && views.length > 1 ? views : [];
  cameraViewIndex = 0;
  $('#detail-views').hidden = !cameraViews.length;
  const dl = $('#detail-fields');
  dl.innerHTML = '';
  for (const [k, v] of fields) {
    if (v == null || v === '' || v === 'undefined') continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    fieldValue(dd, v);
    dl.append(dt, dd);
  }
  const img = $('#detail-image');
  delete img.dataset.full;
  delete img.dataset.link;
  clearInterval(cameraRefresh);
  if (imageUrl) {
    img.hidden = false;
    if (cameraViews.length) {
      showCameraView();
    } else {
      const bust = () => {
        img.src = imageUrl + (imageUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
      };
      bust();
      cameraRefresh = setInterval(bust, 30_000);
    }
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }
  detail.hidden = false;
}

/* ------------------------------------------------------- aircraft dossier */

/*
 * Two free registries fill in what ADS-B cannot say: planespotters for a photo of
 * the airframe, adsbdb for the scheduled route. Both are looked up only when a
 * contact is selected, so browsing 2 000 aircraft costs nothing.
 */

const routeLine = scene.primitives.add(new Cesium.PolylineCollection());
const routeMarks = scene.primitives.add(new Cesium.LabelCollection({ scene }));

function clearRoute() {
  routeLine.removeAll();
  routeMarks.removeAll();
}

function drawRoute(route, aircraft) {
  clearRoute();
  const from = Cesium.Cartesian3.fromDegrees(route.origin.lon, route.origin.lat, 0);
  const to = Cesium.Cartesian3.fromDegrees(route.destination.lon, route.destination.lat, 0);
  const here = Cesium.Cartesian3.fromDegrees(aircraft.lon, aircraft.lat, aircraft.alt || 0);

  routeLine.add({
    positions: [from, here],
    width: 2,
    material: Cesium.Material.fromType('Color', {
      color: Cesium.Color.fromCssColorString('#ffb347').withAlpha(0.85),
    }),
  });
  routeLine.add({
    positions: [here, to],
    width: 2,
    material: Cesium.Material.fromType('PolylineDash', {
      color: Cesium.Color.fromCssColorString('#7fe8ff').withAlpha(0.8),
      dashLength: 18,
    }),
  });

  for (const [end, label] of [[route.origin, from], [route.destination, to]]) {
    routeMarks.add({
      position: label,
      text: `${end.code}\n${end.city || ''}`,
      font: '600 12px "JetBrains Mono", Consolas, monospace',
      fillColor: Cesium.Color.fromCssColorString('#ffb347'),
      showBackground: true,
      backgroundColor: new Cesium.Color(0.02, 0.05, 0.08, 0.78),
      backgroundPadding: new Cesium.Cartesian2(6, 4),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(10, 0),
      disableDepthTestDistance: MARK_THROUGH_M,
    });
  }
}

/*
 * Ships have no planespotters. Commons has photographs of a great many of them,
 * but only searchable by name, and names repeat — so the file title goes on the
 * card and the wording says it is a name match, not an identification.
 */
async function loadVesselPhoto(vessel) {
  try {
    const photo = await getJSON(`/api/vessel-photo?name=${encodeURIComponent(vessel.name)}`);
    if (!photo.url) {
      addField('Photo', 'none on Wikimedia Commons');
      return;
    }
    if ($('#detail-title').textContent !== vessel.name) return;  // moved on already
    const img = $('#detail-image');
    img.src = photo.url;
    img.dataset.full = photo.full || photo.url;
    img.hidden = false;
    addField('Photo', `${photo.title} · ${photo.license || 'Commons'}`);
    if (photo.credit) addField('Photographer', photo.credit);
  } catch (err) {
    /* a ship without a picture is the normal case */
  }
}

async function loadShipPhoto(ship) {
  if (!ship.wiki) return;
  try {
    const page = await getJSON(`/api/ship?title=${encodeURIComponent(ship.wiki)}`);
    if ($('#detail-title').textContent !== ship.name) return;  // moved on already
    if (page.thumb) {
      const img = $('#detail-image');
      img.src = page.thumb;
      img.dataset.full = page.full || page.thumb;
      img.hidden = false;
      addField('Photo', 'Wikipedia \u00b7 US Navy, public domain');
    }
    if (page.extract) addField('Ship', page.extract.split('. ')[0] + '.');
  } catch (err) {
    /* a missing photo is not worth a warning in the log */
  }
}

async function loadDossier(aircraft) {
  const query = new URLSearchParams({
    hex: aircraft.icao,
    callsign: aircraft.callsign,
    type: aircraft.acType || '',   // the registry is thin; ADS-B is not
  });
  let dossier;
  try {
    dossier = await getJSON('/api/aircraft?' + query);
  } catch (err) {
    return;
  }
  // The card may have moved on to another contact while this was in flight.
  if (detail.dataset.target !== `flight:${aircraft.icao}`) return;

  // planespotters ask for non-commercial use, so in safe mode the hull photo is
  // dropped and only a freely licensed type photo is allowed through.
  if (dossier.photo && safeMode && dossier.photo.kind === 'airframe') {
    addField('Photo', 'withheld — commercial-safe mode is on');
  } else if (dossier.photo) {
    const img = $('#detail-image');
    img.src = dossier.photo.url;
    if (dossier.photo.full) img.dataset.full = dossier.photo.full;
    // planespotters require the thumbnail to link to the photo's own page
    if (dossier.photo.link) img.dataset.link = dossier.photo.link;
    img.hidden = false;
    // A photo of the model is not a photo of this aircraft, and the card says so.
    addField(
      dossier.photo.kind === 'type' ? 'Type photo' : 'Photo',
      dossier.photo.kind === 'type'
        ? `${dossier.model || 'model'} — not this airframe · ${dossier.photo.credit}`
        : `© ${dossier.photo.credit || 'planespotters.net'}`
    );
  } else {
    addField('Photo', 'none published for this airframe');
  }
  if (dossier.route) {
    drawRoute(dossier.route, aircraft);
    addField('From', `${dossier.route.origin.code} ${dossier.route.origin.city || ''}`);
    addField('To', `${dossier.route.destination.code} ${dossier.route.destination.city || ''}`);
    if (dossier.route.airline) {
      addField('Operator', dossier.route.airline);
      addEntityExpand(dossier.route.airline, 'Who operates it');
    }
  }
}

/**
 * A field value, as text or as a link if it is one.
 *
 * Cards had been printing URLs as plain text, which for a WHO report or a
 * receiver you want to listen through is a URL you have to select and copy. Any
 * value that is an http address becomes an anchor instead, everywhere at once.
 */
function fieldValue(dd, value) {
  const text = String(value);
  if (/^https?:\/\/\S+$/.test(text)) {
    const a = document.createElement('a');
    a.href = text;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.className = 'field-link';
    // The whole URL is rarely the useful part; the host almost always is.
    try { a.textContent = new URL(text).hostname.replace(/^www\./, '') + ' \u2197'; }
    catch (_) { a.textContent = text; }
    a.title = text;
    dd.append(a);
    return;
  }
  dd.textContent = text;
}

function addField(key, value) {
  // An empty row is worse than no row: it reads as a fact that came back blank.
  if (value == null || value === '' || value === 'undefined') return;
  const dl = $('#detail-fields');
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  fieldValue(dd, value);
  dl.append(dt, dd);
}

/* ------------------------------------------------------- camera projection */

/*
 * A road camera knows where it stands but not where it looks: the public feeds
 * carry no heading, no field of view, no range. So the footprint is drawn from
 * an editable guess — point it, widen it, push it out until the image lines up
 * with the ground — and the calibration is remembered per station.
 */

const projection = { station: null, cfg: null, refresh: null };
const CAL_DEFAULT = { heading: 0, fov: 55, range: 260 };
const CAL_STORE = 'gcv.camera.calibration';

function loadCalibrations() {
  try {
    return JSON.parse(localStorage.getItem(CAL_STORE) || '{}');
  } catch (_) {
    return {};
  }
}

function offsetMetres(lon, lat, bearing, metres) {
  return [
    lon + (metres * Math.sin(bearing)) / (111320 * Math.cos(Cesium.Math.toRadians(lat))),
    lat + (metres * Math.cos(bearing)) / 110540,
  ];
}

function footprint(station, cfg) {
  const heading = Cesium.Math.toRadians(cfg.heading);
  const half = Cesium.Math.toRadians(cfg.fov) / 2;
  const near = Math.max(6, cfg.range * 0.12);
  const corners = [
    offsetMetres(station.lon, station.lat, heading - half, near),
    offsetMetres(station.lon, station.lat, heading + half, near),
    offsetMetres(station.lon, station.lat, heading + half, cfg.range),
    offsetMetres(station.lon, station.lat, heading - half, cfg.range),
  ];
  return corners.flat();
}

function drawProjection() {
  const { station, cfg } = projection;
  if (!station) return;
  viewer.entities.removeById('gcv-projection');
  viewer.entities.removeById('gcv-projection-edge');

  const ring = footprint(station, cfg);
  const image = $('#detail-image').src || station.image;

  viewer.entities.add({
    id: 'gcv-projection',
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(ring),
      material: new Cesium.ImageMaterialProperty({
        image,
        transparent: true,
        color: Cesium.Color.WHITE.withAlpha(0.85),
      }),
      // the texture runs from the camera outwards, so it turns with the heading
      stRotation: Cesium.Math.toRadians(-cfg.heading),
      // Flat on the ellipsoid when there is no terrain, because classification
      // silently draws nothing without it. With ion terrain and buildings on,
      // the frame is draped over both instead — the camera image wraps the
      // ground and the walls it is actually looking at.
      ...(scene.globe.depthTestAgainstTerrain
        ? { classificationType: Cesium.ClassificationType.BOTH }
        : { height: 1.0 }),
    },
  });

  viewer.entities.add({
    id: 'gcv-projection-edge',
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights(
        ring.concat(ring.slice(0, 2)).flatMap((v, i) => (i % 2 ? [v, 1.5] : [v]))
      ),
      width: 1.6,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString('#7dffab'),
        dashLength: 14,
      }),
    },
  });
}

function startProjection(station) {
  const saved = loadCalibrations()[station.id];
  projection.station = station;
  projection.cfg = { ...CAL_DEFAULT, ...(saved || {}) };
  syncCalibrationInputs();
  $('#calibration').hidden = false;
  $('#project').classList.add('active');
  $('#project').textContent = 'PROJECTION ON';
  drawProjection();
  clearInterval(projection.refresh);
  projection.refresh = setInterval(drawProjection, 30_000);
  log(`projecting ${station.name} onto the ground`);
}

function stopProjection() {
  clearInterval(projection.refresh);
  viewer.entities.removeById('gcv-projection');
  viewer.entities.removeById('gcv-projection-edge');
  projection.station = null;
  $('#calibration').hidden = true;
  $('#project').classList.remove('active');
  $('#project').textContent = 'PROJECT ONTO GROUND';
}

function syncCalibrationInputs() {
  const cfg = projection.cfg;
  $('#cal-heading').value = cfg.heading;
  $('#cal-fov').value = cfg.fov;
  $('#cal-range').value = cfg.range;
  $('#cal-heading-out').textContent = `${cfg.heading}\u00b0`;
  $('#cal-fov-out').textContent = `${cfg.fov}\u00b0`;
  $('#cal-range-out').textContent = `${cfg.range} m`;
}

for (const field of ['heading', 'fov', 'range']) {
  $(`#cal-${field}`).oninput = (e) => {
    if (!projection.station) return;
    projection.cfg[field] = Number(e.target.value);
    syncCalibrationInputs();
    drawProjection();
  };
}

$('#project').onclick = () => {
  if (projection.station) return stopProjection();
  const ref = detail.dataset.camera && JSON.parse(detail.dataset.camera);
  if (ref) startProjection(ref);
};

$('#cal-save').onclick = () => {
  if (!projection.station) return;
  // A saved calibration is the only thing that earns a camera a viewshed, so the
  // cone appears the moment the numbers are set rather than on the next reload.
  setTimeout(drawViewsheds, 0);
  const all = loadCalibrations();
  all[projection.station.id] = projection.cfg;
  localStorage.setItem(CAL_STORE, JSON.stringify(all));
  log(`calibration saved for ${projection.station.name}`);
};

$('#cal-reset').onclick = () => {
  if (!projection.station) return;
  projection.cfg = { ...CAL_DEFAULT };
  syncCalibrationInputs();
  drawProjection();
};

/* ----------------------------------------------------------------- ruler */

/*
 * Measuring is how you tell a 170 m submarine from a 110 m one, so the ruler
 * works on the ellipsoid rather than in screen pixels: each leg is a geodesic
 * surface distance, which stays honest at any latitude and any zoom.
 */

const rulerLines = scene.primitives.add(new Cesium.PolylineCollection());
const rulerLabels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
const rulerPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const ruler = { on: false, points: [] };
const geodesic = new Cesium.EllipsoidGeodesic();

/**
 * Three numbers, because they answer different questions.
 *
 * `direct` is the straight line through space between the two points, which is
 * what you want when measuring an object - a hull, a runway, a building.
 * `ground` is the distance over the ellipsoid, which is what you want for
 * travel. `climb` is the height between them, and it is the reason the two
 * differ: measuring up a hillside, the ground distance understates the tape.
 *
 * At the scale of a ship they agree to within centimetres. Across a fjord they
 * do not, and the readout says so rather than picking one silently.
 */
function metresBetweenCartographic(a, b) {
  geodesic.setEndPoints(
    Cesium.Cartographic.fromRadians(a.longitude, a.latitude, 0),
    Cesium.Cartographic.fromRadians(b.longitude, b.latitude, 0)
  );
  const ground = geodesic.surfaceDistance;
  const climb = Math.abs((b.height || 0) - (a.height || 0));
  const direct = Cesium.Cartesian3.distance(
    Cesium.Cartographic.toCartesian(a), Cesium.Cartographic.toCartesian(b)
  );
  return { direct, ground, climb };
}

/** The one number a leg is labelled with: the line between the two points. */
function legMetres(a, b) {
  return metresBetweenCartographic(a, b).direct;
}

const readable = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

function toggleRuler() {
  ruler.on = !ruler.on;
  $('#measure').classList.toggle('active', ruler.on);
  $('#measure').textContent = ruler.on ? 'MEASURING · CLICK POINTS' : 'MEASURE DISTANCE';
  $('#measure-readout').hidden = !ruler.on;
  if (!ruler.on) clearRuler();
}

function clearRuler() {
  ruler.points = [];
  rulerLines.removeAll();
  rulerLabels.removeAll();
  rulerPoints.removeAll();
  $('#measure-total').textContent = '0 m';
  $('#measure-legs').textContent = 'no legs';
}

function addRulerPoint(cartographic) {
  ruler.points.push(cartographic);
  rulerPoints.add({
    position: Cesium.Cartographic.toCartesian(cartographic),
    pixelSize: 7,
    color: Cesium.Color.fromCssColorString('#ffb347'),
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 1,
    disableDepthTestDistance: MARK_THROUGH_M,
  });
  if (ruler.points.length < 2) {
    $('#measure-legs').textContent = 'click the next point';
    return;
  }

  const a = ruler.points[ruler.points.length - 2];
  const b = cartographic;
  const measured = metresBetweenCartographic(a, b);
  const leg = measured.direct;
  const from = Cesium.Cartographic.toCartesian(a);
  const to = Cesium.Cartographic.toCartesian(b);

  rulerLines.add({
    positions: [from, to],
    width: 2,
    material: Cesium.Material.fromType('Color', {
      color: Cesium.Color.fromCssColorString('#ffb347').withAlpha(0.9),
    }),
  });
  rulerLabels.add({
    position: Cesium.Cartesian3.midpoint(from, to, new Cesium.Cartesian3()),
    text: readable(leg),
    font: '600 12px "JetBrains Mono", Consolas, monospace',
    fillColor: Cesium.Color.fromCssColorString('#ffb347'),
    showBackground: true,
    backgroundColor: new Cesium.Color(0.02, 0.05, 0.08, 0.8),
    backgroundPadding: new Cesium.Cartesian2(5, 3),
    disableDepthTestDistance: MARK_THROUGH_M,
  });

  let total = 0;
  for (let i = 1; i < ruler.points.length; i++) {
    total += legMetres(ruler.points[i - 1], ruler.points[i]);
  }
  $('#measure-total').textContent = readable(total);
  // Only worth saying when it changes the answer: a metre of climb over a
  // kilometre is noise, forty over eighty is the whole story.
  const notable = measured.climb > 5 && measured.climb > measured.ground * 0.02;
  $('#measure-legs').textContent =
    `${ruler.points.length - 1} leg${ruler.points.length > 2 ? 's' : ''} \u00b7 last `
    + readable(leg)
    + (notable ? ` \u00b7 ${readable(measured.ground)} over ground, `
        + `${readable(measured.climb)} of climb` : '');
}

$('#measure').onclick = toggleRuler;

/* ------------------------------------------------------------------ marks */

/*
 * A mark stores the whole camera — position, heading and pitch — not just a
 * coordinate, so returning to it gives you back the view you were looking at
 * rather than a spot on a map.
 */

const MARK_STORE = 'gcv.marks';
const markPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const markLabels = scene.primitives.add(new Cesium.LabelCollection({ scene }));

/*
 * Marks live in a file on the server, because localStorage is scoped to the
 * exact origin: start the server on another port and a browser will swear you
 * never saved anything. The browser copy is kept as a mirror, so the marks still
 * draw if the server is unreachable, and anything found there on first run is
 * migrated up.
 */
let marks = [];

const localMarks = () => {
  try {
    return JSON.parse(localStorage.getItem(MARK_STORE) || '[]');
  } catch (_) {
    return [];
  }
};

const loadMarks = () => marks;

async function saveMarks(next) {
  marks = next;
  localStorage.setItem(MARK_STORE, JSON.stringify(next));
  try {
    const res = await fetch('/api/marks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marks: next }),
    });
    if (!res.ok) throw new Error(res.status);
  } catch (err) {
    log('marks saved in this browser only — server write failed', 'warn');
  }
}

async function initMarks() {
  let stored = [];
  try {
    stored = (await getJSON('/api/marks')).marks || [];
  } catch (_) {
    stored = [];
  }
  const local = localMarks();
  if (!stored.length && local.length) {
    marks = local;
    await saveMarks(local);   // migrate what the browser was holding
    log(`marks: moved ${local.length} from this browser onto disk`);
  } else {
    marks = stored;
    localStorage.setItem(MARK_STORE, JSON.stringify(stored));
  }
  renderMarks();
}

/*
 * Marks are named after somebody's life, not after the world: a mother, a
 * friend, a home. They are drawn with their names on the globe, which is right
 * while you are looking and wrong the moment you record.
 *
 * This app is used to film a YouTube channel. Without this switch every video
 * published from it carries the author's private addresses, labelled, at a
 * readable size. That is not a screenshot problem, it is a standing leak, and
 * one nobody would notice until it had already happened a dozen times.
 *
 * The list in the panel stays either way. Only the globe stops showing them.
 */
let marksHidden = localStorage.getItem('gcv-marks-hidden') === '1';

function applyMarksHidden() {
  markPoints.show = !marksHidden;
  markLabels.show = !marksHidden;
  $('#marks-hide').checked = marksHidden;
}

$('#marks-hide').onchange = (e) => {
  marksHidden = e.target.checked;
  localStorage.setItem('gcv-marks-hidden', marksHidden ? '1' : '0');
  applyMarksHidden();
  log(marksHidden
    ? 'marks hidden on the globe · safe to record'
    : 'marks visible again');
};

function renderMarks() {
  const marks = loadMarks();
  const list = $('#marks');
  list.innerHTML = '';
  markPoints.removeAll();
  markLabels.removeAll();

  for (const mark of marks) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${mark.name}</span><button class="drop" title="forget">×</button>`;
    li.onclick = (e) => {
      if (e.target.classList.contains('drop')) {
        saveMarks(loadMarks().filter((m) => m.id !== mark.id)).then(renderMarks);
        renderMarks();
        return;
      }
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(mark.lon, mark.lat, mark.height),
        orientation: { heading: mark.heading, pitch: mark.pitch, roll: 0 },
        duration: 2,
        complete: carryCameraInto3D,
      });
      log(`mark: ${mark.name}`);
    };
    li.title = `${mark.lat.toFixed(5)}, ${mark.lon.toFixed(5)} · ${Math.round(mark.height)} m`;
    list.append(li);

    markPoints.add({
      position: Cesium.Cartesian3.fromDegrees(mark.lon, mark.lat, 0),
      pixelSize: 8,
      color: Cesium.Color.fromCssColorString('#4fd6ff'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      scaleByDistance: new Cesium.NearFarScalar(1000, 1.3, 8_000_000, 0.5),
      id: { type: 'mark', ref: mark },
    });
    markLabels.add({
      position: Cesium.Cartesian3.fromDegrees(mark.lon, mark.lat, 0),
      text: mark.name,
      font: '600 11px "JetBrains Mono", Consolas, monospace',
      fillColor: Cesium.Color.fromCssColorString('#4fd6ff'),
      showBackground: true,
      backgroundColor: new Cesium.Color(0.02, 0.05, 0.08, 0.75),
      backgroundPadding: new Cesium.Cartesian2(5, 3),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(10, 0),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3_000_000),
    });
  }
  applyMarksHidden();
}

function markThisView() {
  const input = $('#mark-name');
  const carto = viewer.camera.positionCartographic;
  const mark = {
    id: `m${marks.length + 1}-${Math.round(carto.height)}`,
    name: (input.value || '').trim() || `mark ${marks.length + 1}`,
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    height: carto.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
  };
  saveMarks([...marks, mark]);
  input.value = '';
  renderMarks();
  log(`marked ${mark.name}`);
}

$('#mark-save').onclick = markThisView;
$('#mark-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') markThisView();
});

initMarks();

/* -------------------------------------------------------------- following */

/*
 * Following a contact means rebuilding the camera's reference frame from the
 * target's position every frame and re-seating the camera at the same offset
 * inside it. The offset is read back after each frame, so orbiting and zooming
 * with the mouse still works and simply changes where you sit relative to the
 * target. (lookAtTransform with no offset preserves the camera's *world*
 * position, which looks like following doing nothing at all.)
 */

let followed = null;
const followOffset = new Cesium.Cartesian3();

const FOLLOW_RANGE = { flight: 40_000, vessel: 4_000, satellite: 1_800_000 };

function positionOf(entry) {
  if (entry.type === 'satellite') return entry.ref.point && entry.ref.point.position;
  return entry.ref.billboard && entry.ref.billboard.position;
}

function startFollow(type, ref) {
  followed = { type, ref };
  const position = positionOf(followed);
  if (!position) return;
  // Following means moving the camera every frame, and Google's 3D view has no
  // smooth way to be told that often - it would judder rather than track. The
  // globe does it properly, so photoreal steps aside, the same as it does for
  // the moon. Said out loud, because a view that changes under you without a
  // reason is worse than one that explains itself.
  if (map3d && !$('#map3d').hidden) {
    $('#photoreal').checked = false;
    showPhotoreal(false);
    log('photoreal 3D off · tracking follows on the globe, which can turn with it');
  }
  viewer.camera.lookAt(
    position,
    new Cesium.HeadingPitchRange(
      viewer.camera.heading,
      Cesium.Math.toRadians(-25),
      FOLLOW_RANGE[type] || 20_000
    )
  );
  Cesium.Cartesian3.clone(viewer.camera.position, followOffset);
  $('#follow').classList.add('active');
  $('#follow').textContent = 'FOLLOWING · CLICK TO RELEASE';
  log(`tracking ${$('#detail-title').textContent}`);
}

function stopFollow() {
  followed = null;
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  $('#follow').classList.remove('active');
  $('#follow').textContent = 'FOLLOW';
}

$('#follow').onclick = () => {
  if (followed) return stopFollow();
  const target = detail.dataset.target;
  if (!target) return;
  const [type, key] = target.split(':');
  const ref =
    type === 'flight' ? flights.get(key)
    : type === 'vessel' ? vessels.get(Number(key))
    : satellites.find((s) => s.norad === key);
  if (ref) startFollow(type, ref);
};

scene.preRender.addEventListener(() => {
  if (!followed) return;
  const position = positionOf(followed);
  if (!position) return stopFollow();
  viewer.camera.lookAtTransform(
    Cesium.Transforms.eastNorthUpToFixedFrame(position),
    followOffset
  );
});

// Read the offset back after the frame so mouse orbit and zoom stick.
scene.postRender.addEventListener(() => {
  if (followed) Cesium.Cartesian3.clone(viewer.camera.position, followOffset);
});

/* ------------------------------------------------------- camera lightbox */

const lightbox = $('#lightbox');
const lightboxImage = $('#lightbox-image');
const view = { zoom: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

function applyLightbox() {
  lightboxImage.style.transform =
    `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.zoom})`;
  $('#lightbox-zoom').textContent = `${Math.round(view.zoom * 100)}%`;
}

function openLightbox(src, title) {
  lightboxImage.src = src;
  $('#lightbox-title').textContent = title;
  view.zoom = 1;
  view.x = 0;
  view.y = 0;
  applyLightbox();
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImage.removeAttribute('src');
}

lightbox.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  view.zoom = clamp(view.zoom * factor, 0.5, 12);
  applyLightbox();
}, { passive: false });

lightbox.addEventListener('pointerdown', (e) => {
  view.dragging = true;
  view.lastX = e.clientX;
  view.lastY = e.clientY;
  lightbox.classList.add('dragging');
  lightbox.setPointerCapture(e.pointerId);
});
lightbox.addEventListener('pointermove', (e) => {
  if (!view.dragging) return;
  view.x += e.clientX - view.lastX;
  view.y += e.clientY - view.lastY;
  view.lastX = e.clientX;
  view.lastY = e.clientY;
  applyLightbox();
});
lightbox.addEventListener('pointerup', (e) => {
  view.dragging = false;
  lightbox.classList.remove('dragging');
  // a click that did not drag closes the viewer
  if (Math.abs(view.x) < 3 && Math.abs(view.y) < 3 && view.zoom === 1) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
});

$('#detail-image').onclick = () => {
  const img = $('#detail-image');
  if (!img.src) return;
  // Where the licence ties the picture to a page — planespotters do — the click
  // has to go there rather than into our own viewer.
  if (img.dataset.link) {
    window.open(img.dataset.link, '_blank');
    return;
  }
  openLightbox(img.dataset.full || img.src, $('#detail-title').textContent);
};

$('#detail-close').onclick = () => {
  detail.hidden = true;
  clearInterval(cameraRefresh);
  orbitTrack.removeAll();
  clearRoute();
  if (selectedSat && selectedSat.point) {
    selectedSat.point.pixelSize = 2;
    selectedSat.point.outlineWidth = 0;
    selectedSat = null;
  }
};

viewer.screenSpaceEventHandler.setInputAction((click) => {
  if (ruler.on) {
    // pickEllipsoid sends the ray *through* whatever is being aimed at and on
    // down to sea level, so the point lands beyond the target - both ends pushed
    // outward, the far one more on an oblique view. That is why it read long.
    // surfacePoint stops at what is actually drawn.
    const ground = surfacePoint(click.position);
    if (ground) addRulerPoint(Cesium.Cartographic.fromCartesian(ground));
    return;
  }
  if (standing.picking) {
    const ground = surfacePoint(click.position);
    if (ground) standAt(Cesium.Cartographic.fromCartesian(ground), true);
    return;
  }
  const picked = scene.pick(click.position);
  if (!picked || !picked.id || !picked.id.type) return;
  const { type, ref } = picked.id;

  describePicked(type, ref);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

viewer.screenSpaceEventHandler.setInputAction((move) => {
  const carto = viewer.camera.pickEllipsoid(move.endPosition, scene.globe.ellipsoid);
  if (!carto) {
    $('#cursor').textContent = '--.---- , ---.----';
    return;
  }
  const c = Cesium.Cartographic.fromCartesian(carto);
  $('#cursor').textContent =
    `${Cesium.Math.toDegrees(c.latitude).toFixed(4)} , ${Cesium.Math.toDegrees(c.longitude).toFixed(4)}`;
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

function updateEyeReadout() {
  const height = viewer.camera.positionCartographic.height;
  $('#altitude').textContent =
    height < 10_000
      ? `EYE ${Math.round(height).toLocaleString('en-US')} m`
      : `EYE ${Math.round(height / 1000).toLocaleString('en-US')} km`;
}
scene.camera.changed.addEventListener(updateEyeReadout);
scene.camera.moveEnd.addEventListener(updateEyeReadout);
scene.camera.percentageChanged = 0.1;
updateEyeReadout();

/* ------------------------------------------------------------- detection */

/*
 * Detection mode puts a reticle and a designator on whatever the sensor can
 * actually see. Labelling 20 000 contacts would be unreadable and slow, so the
 * pool is fixed: every pass ranks the visible contacts by how close they are to
 * the centre of the view and the best `density` of them get a bracket.
 */

const trackBrackets = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
const trackLabels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
const detection = { on: true, density: 40, visible: 0, sources: 0, frameMs: 0 };

const DESIGNATORS = {
  satellite: (o) => [`SAT-${o.norad}`, o.name],
  flight: (o) => [
    `${o.role === 'police' ? 'POL' : o.rotorcraft ? 'ROT' : o.military ? 'MIL' : 'AIR'}-${o.callsign}`,
    [o.reg, o.acType].filter(Boolean).join(' ') || o.country || '',
  ],
  vessel: (o) => [`SEA-${o.mmsi}`, o.name],
  capital: (o) => [o.hull, o.name.replace('USS ', '')],
  base: (o) => ['SUBBASE', o.name],
  camera: (o) => [`CAM-${String(o.id).replace(/\D/g, '').slice(-5)}`, o.name],
  vehicle: (o) => [o.id, o.road || o.kind || ''],
};
const TRACK_COLORS = {
  satellite: '#7fe8ff',
  flight: '#ffb347',
  military: '#ff4d4d',
  vessel: '#4fd6ff',
  camera: '#7dffab',
  vehicle: '#ffd166',
  capital: '#ff4d4d',
  base: '#b58cff',
};

const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
const centreScratch = new Cesium.Cartesian2();

function collectTargets() {
  const width = scene.canvas.clientWidth;
  const height = scene.canvas.clientHeight;
  const cx = width / 2;
  const cy = height / 2;
  occluder.cameraPosition = scene.camera.positionWC;
  const found = [];

  const consider = (position, type, ref) => {
    if (!position || !occluder.isPointVisible(position)) return;
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, centreScratch);
    if (!win || win.x < 0 || win.y < 0 || win.x > width || win.y > height) return;
    found.push({ type, ref, position: Cesium.Cartesian3.clone(position),
                 x: win.x, y: win.y, d: (win.x - cx) ** 2 + (win.y - cy) ** 2 });
  };

  // From street level the sky fills with Starlink designators, which is noise
  // when you are looking at a building: orbital contacts only get labelled from
  // an altitude where they are what you came to see.
  if (collections.satellites.show && scene.camera.positionCartographic.height > 5_000) {
    for (const sat of satellites) {
      if (sat.point && sat.point.show) consider(sat.point.position, 'satellite', sat);
    }
  }
  for (const f of flights.values()) {
    if (!f.billboard) continue;
    if (!(f.role ? collections.services.show : collections.flights.show)) continue;
    consider(f.billboard.position, 'flight', f);
  }
  if (collections.vessels.show) {
    for (const v of vessels.values()) if (v.billboard) consider(v.billboard.position, 'vessel', v);
  }
  if (subBases.show) {
    for (let i = 0; i < subBases.length; i++) {
      const b = subBases.get(i);
      consider(b.position, 'base', b.id.ref);
    }
  }
  if (capitalShips.show) {
    for (let i = 0; i < capitalShips.length; i++) {
      const b = capitalShips.get(i);
      consider(b.position, 'capital', b.id.ref);
    }
  }
  if (collections.cameras.show) {
    const cams = collections.cameras;
    for (let i = 0; i < cams.length; i++) {
      const b = cams.get(i);
      if (b.show) consider(b.position, 'camera', b.id.ref);
    }
  }
  return found;
}

/*
 * The reticles and labels are a fixed pool that gets reused: tearing the
 * collections down and rebuilding them twice a second churns Cesium's label
 * texture atlas, and that grinds GPU memory until the renderer gives up.
 */
const POOL = 120;
let poolBuilt = false;

function buildPool() {
  for (let i = 0; i < POOL; i++) {
    trackBrackets.add({
      image: GLYPHS.bracket,
      position: Cesium.Cartesian3.ZERO,
      scale: 0.75,
      show: false,
      disableDepthTestDistance: MARK_THROUGH_M,
    });
    trackLabels.add({
      position: Cesium.Cartesian3.ZERO,
      text: '',
      font: '600 11px "JetBrains Mono", Consolas, monospace',
      showBackground: true,
      backgroundColor: new Cesium.Color(0.02, 0.05, 0.08, 0.72),
      backgroundPadding: new Cesium.Cartesian2(5, 3),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(16, -14),
      disableDepthTestDistance: MARK_THROUGH_M,
      show: false,
    });
  }
  poolBuilt = true;
}

function hidePool(from) {
  for (let i = from; i < POOL; i++) {
    trackBrackets.get(i).show = false;
    trackLabels.get(i).show = false;
  }
}

function updateDetection() {
  const started = performance.now();
  if (!poolBuilt) buildPool();
  if (!detection.on) {
    hidePool(0);
    detection.visible = 0;
    return;
  }

  const targets = collectTargets();
  detection.sources = targets.length;

  // One contact per screen cell, otherwise the nearest 40 targets are all
  // within a few pixels of the crosshair and the labels pile up unreadably.
  const cellW = Math.max(110, scene.canvas.clientWidth / 12);
  const cellH = Math.max(72, scene.canvas.clientHeight / 9);
  const cells = new Map();
  const rank = (t) => (t.type === 'flight' && t.ref.military ? t.d - 1e9 : t.d);
  for (const target of targets) {
    const key = `${Math.floor(target.x / cellW)},${Math.floor(target.y / cellH)}`;
    const held = cells.get(key);
    // A military contact always wins its cell: it is the one worth naming.
    if (!held || rank(target) < rank(held)) cells.set(key, target);
  }
  const shown = [...cells.values()]
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.min(detection.density, POOL));
  detection.visible = shown.length;

  shown.forEach((target, i) => {
    const [designator, name] = DESIGNATORS[target.type](target.ref);
    const key = target.type === 'flight' && target.ref.military ? 'military' : target.type;
    const color = Cesium.Color.fromCssColorString(TRACK_COLORS[key]);
    const identity = { type: target.type, ref: target.ref };

    const bracket = trackBrackets.get(i);
    bracket.position = target.position;
    bracket.color = color.withAlpha(0.9);
    // The reticle sits on top of the contact it marks, so it carries the same
    // identity — otherwise clicking a labelled target selects nothing.
    bracket.id = identity;
    bracket.show = true;

    const label = trackLabels.get(i);
    label.position = target.position;
    label.text = name ? `${designator}
${name}` : designator;
    label.fillColor = color;
    label.id = identity;
    label.show = true;
  });
  hidePool(shown.length);
  detection.frameMs = performance.now() - started;
}

setInterval(updateDetection, 450);

setInterval(() => {
  $('#telemetry').textContent =
    `VIS:${detection.visible} SRC:${detection.sources} ` +
    `DENS:${detection.density} ${detection.frameMs.toFixed(1)}ms`;
}, 500);

/* ---------------------------------------------------------- CRT post-pass */

/*
 * The CRT look is a real post-process on the rendered scene rather than a CSS
 * filter, because it has to warp geometry: barrel distortion, phosphor scan
 * lines, a little chromatic separation at the edges, and a vignette.
 */

const CRT_SHADER = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 warp = uv + c * r2 * 0.14;
  if (warp.x < 0.0 || warp.x > 1.0 || warp.y < 0.0 || warp.y > 1.0) {
    out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float split = 0.0014 + r2 * 0.004;
  vec3 col;
  col.r = texture(colorTexture, warp + vec2(split, 0.0)).r;
  col.g = texture(colorTexture, warp).g;
  col.b = texture(colorTexture, warp - vec2(split, 0.0)).b;
  col *= 0.88 + 0.12 * sin(warp.y * 620.0);
  col *= 1.0 - 0.85 * r2;
  col = pow(max(col, 0.0), vec3(0.92)) * 1.12;
  out_FragColor = vec4(col, 1.0);
}
`;

/*
 * Night vision and FLIR are sensor emulations rather than colour grades: the
 * scene is reduced to luminance and then mapped onto the sensor's own palette —
 * green phosphor with a bloom and a little noise, or the white-hot ramp.
 */

const SCOPE_SHADER = `
uniform sampler2D colorTexture;
uniform float u_flir;
in vec2 v_textureCoordinates;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = v_textureCoordinates;
  vec3 src = texture(colorTexture, uv).rgb;
  float l = luma(src);

  // a cheap bloom: the neighbourhood's brightest light bleeds into the pixel
  float bloom = 0.0;
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      vec2 o = vec2(float(i), float(j)) * 0.0022;
      bloom = max(bloom, luma(texture(colorTexture, uv + o).rgb));
    }
  }

  vec3 col;
  if (u_flir > 0.5) {
    // white-hot: black through red and orange to white
    // Keep the ramp off its white end: a thermal image where everything is the
    // hottest thing in frame tells you nothing.
    float t = clamp(l * 0.82 + bloom * 0.18, 0.0, 1.0);
    col = mix(vec3(0.02, 0.0, 0.06), vec3(0.7, 0.09, 0.0), smoothstep(0.0, 0.5, t));
    col = mix(col, vec3(1.0, 0.66, 0.08), smoothstep(0.5, 0.85, t));
    col = mix(col, vec3(1.0), smoothstep(0.9, 1.0, t));
  } else {
    float t = clamp(l * 1.4 + bloom * 0.4, 0.0, 1.0);
    col = vec3(0.05, 1.0, 0.35) * t;          // phosphor green
    col += vec3(0.0, 0.35, 0.1) * pow(bloom, 3.0);  // halation around lights
  }

  // sensor noise, and the vignette every intensifier has
  float grain = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.06;
  vec2 c = uv - 0.5;
  col *= 1.0 - 0.9 * dot(c, c);
  out_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

let crtStage = null;
let scopeStage = null;

function setCrt(enabled) {
  if (enabled && !crtStage) {
    crtStage = scene.postProcessStages.add(
      new Cesium.PostProcessStage({ name: 'gcv_crt', fragmentShader: CRT_SHADER })
    );
  }
  if (crtStage) crtStage.enabled = !!enabled;
}

function setScope(mode) {
  if (mode && !scopeStage) {
    scopeStage = scene.postProcessStages.add(
      new Cesium.PostProcessStage({
        name: 'gcv_scope',
        fragmentShader: SCOPE_SHADER,
        uniforms: { u_flir: () => (currentStyle === 'flir' ? 1.0 : 0.0) },
      })
    );
  }
  if (scopeStage) scopeStage.enabled = !!mode;
}

/* ------------------------------------------------------------ ground level */

/*
 * Photorealistic 3D tiles need a paid key, so street level is built from OSM
 * footprints extruded by building:levels — fetched a 0.01° tile at a time and
 * kept until the camera has wandered far enough away.
 */

const buildingTiles = new Map();
const BUILDING_TILE = 0.01;
const BUILDING_CEILING = 3500; // metres of eye height below which they load
let buildingsWanted = true;

function tileKey(lat, lon) {
  return `${Math.floor(lat / BUILDING_TILE)},${Math.floor(lon / BUILDING_TILE)}`;
}

async function loadBuildingTile(latIndex, lonIndex) {
  const key = `${latIndex},${lonIndex}`;
  if (buildingTiles.has(key)) return;
  buildingTiles.set(key, null); // reserve the slot so it is fetched once
  try {
    const data = await getJSON(`/api/buildings?lat=${latIndex}&lon=${lonIndex}`);
    const instances = [];
    for (const b of data.buildings) {
      const ring = b.ring;
      if (ring.length < 8) continue;
      const positions = Cesium.Cartesian3.fromDegreesArray(ring.slice(0, -2));
      if (positions.length < 3) continue;
      const shade = 0.32 + Math.min(b.h, 90) / 260;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(positions),
            extrudedHeight: b.h,
            height: 0,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              new Cesium.Color(shade * 0.75, shade * 0.85, shade, 1.0)
            ),
          },
          id: { type: 'building', ref: b },
        })
      );
    }
    if (!instances.length) return;
    const primitive = scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({ closed: true }),
        asynchronous: true,
      })
    );
    buildingTiles.set(key, primitive);
    log(`ground: ${instances.length} buildings in tile ${key}`);
  } catch (err) {
    buildingTiles.delete(key);
    log(`buildings unavailable (${err.message})`, 'warn');
  }
}

/*
 * The fixed networks (Sweden, Finland, London) are small enough to load whole.
 * Windy's 70 000 webcams are not, and the free tier will only page 1 000 deep, so
 * the rest of the world arrives a viewport at a time: one lookup per whole degree
 * of view centre, cached server-side for a day.
 */

const cameraIds = new Set();
const nearbyAsked = new Set();

async function loadCamerasNearby() {
  const carto = viewer.camera.positionCartographic;
  if (carto.height > 3_000_000) return; // too wide to be a place you are looking at
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const cell = `${Math.round(lat)},${Math.round(lon)}`;
  if (nearbyAsked.has(cell)) return;
  nearbyAsked.add(cell);

  try {
    const data = await getJSON(`/api/cameras-nearby?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
    let added = 0;
    for (const station of data.stations) {
      if (cameraIds.has(station.id)) continue;
      addCameraStation(station);
      added++;
    }
    if (added) {
      setCount('cameras', collections.cameras.length);
      log(`cameras: +${added} nearby ${cell}`);
    }
  } catch (err) {
    nearbyAsked.delete(cell);
    log(`nearby cameras unavailable (${err.message})`, 'warn');
  }
}

function addCameraStation(station) {
  cameraIds.add(station.id);
  collections.cameras.add({
    image: GLYPHS.camera,
    scale: 0.5,
    color: Cesium.Color.fromCssColorString('#7dffab'),
    position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 60),
    scaleByDistance: SCALE.camera,
    id: { type: 'camera', ref: station },
    show: safeCameraAllowed(station),
  }).gcvAt = [station.lon, station.lat];
}

/* ------------------------------------------------------------ world terrain */

/*
 * Without terrain the earth is a smooth ellipsoid: a fjord is a painting of a
 * fjord on a billiard ball. Cesium ion's Community tier is free for personal,
 * non-commercial use and carries world terrain and worldwide 3D buildings, which
 * is as close to photorealistic ground as this app gets without paying Google.
 */

let ionBuildings = null;
let flatTerrain = null;
let googleKey = '';

async function enableIon() {
  let token = '';
  try {
    const keys = await getJSON('/api/ion-token');
    token = keys.token || '';
    googleKey = keys.google || '';
  } catch (_) { return; }
  if (googleKey) {
    Cesium.GoogleMaps.defaultApiKey = googleKey;
    $('#photoreal-row').hidden = false;
    // The Map Tiles refusal used to hide this switch. It now drives Google's own
    // 3D renderer, which that refusal never applied to, so any remembered block
    // is stale and is cleared rather than honoured.
    localStorage.removeItem(PHOTOREAL_REFUSED);
    localStorage.removeItem('gcv-photoreal-blocked');
    showQuota();
    renderMeters();
  }
  if (!token) return;

  Cesium.Ion.defaultAccessToken = token;
  flatTerrain = viewer.terrainProvider;

  try {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync({
      requestVertexNormals: true,
    });
    scene.globe.depthTestAgainstTerrain = true;
    $('#terrain-row').hidden = false;
    log('terrain: Cesium World Terrain on');
  } catch (err) {
    log(`world terrain unavailable (${err.message})`, 'warn');
    return;
  }

  try {
    ionBuildings = await Cesium.createOsmBuildingsAsync();
    scene.primitives.add(ionBuildings);
    ionBuildings.show = $('#buildings').checked;
    // Cesium's own buildings cover the planet; ours were a stand-in for them.
    buildingsWanted = false;
    for (const primitive of buildingTiles.values()) {
      if (primitive) primitive.show = false;
    }
    log('buildings: Cesium OSM Buildings worldwide');
  } catch (err) {
    log(`ion buildings unavailable (${err.message})`, 'warn');
  }
}

$('#terrain').onchange = async (e) => {
  if (!flatTerrain) return;
  if (e.target.checked) {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync({ requestVertexNormals: true });
    scene.globe.depthTestAgainstTerrain = true;
  } else {
    viewer.terrainProvider = flatTerrain;
    scene.globe.depthTestAgainstTerrain = false;
  }
};

/**
 * Ground height under a point, so standing on a hillside puts you on the hill
 * rather than inside it. Falls back to sea level without terrain.
 */
async function groundHeight(cartographic) {
  if (!scene.globe.depthTestAgainstTerrain) return 0;
  try {
    const [sampled] = await Cesium.sampleTerrainMostDetailed(
      viewer.terrainProvider, [Cesium.Cartographic.clone(cartographic)]
    );
    return sampled.height || 0;
  } catch (_) {
    return 0;
  }
}

enableIon();


/* ------------------------------------------------------ photorealistic 3D */

/*
 * OSM buildings are footprints pushed up to their height: a tower block and a
 * cathedral are the same object with different dimensions. Google's tileset is
 * photogrammetry — the roofs, the balconies and the trees are measured, not
 * guessed. It is the difference between the skyline in the WorldView videos and
 * a bag of grey boxes.
 *
 * Billing is per root-tile request, not per tile, and one root request buys
 * three hours of streaming. Google gives 1000 of them a month for nothing. So
 * the tileset is built the first time the switch is turned on and never again:
 * flying around, reloading the layer, toggling it back off — none of that costs
 * a second request. Leaving the switch alone costs nothing at all.
 */

let googleTiles = null;
let googleBusy = false;

/** Ask Google why it refused, because Cesium will not say. */
async function googleComplaint(err) {
  try {
    const res = await fetch(
      `https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleKey}`
    );
    if (!res.ok) {
      const body = await res.json();
      const message = body.error && body.error.message;
      // The app can be reached as either 127.0.0.1 or localhost, and Google
      // treats them as different sites. A key allowed only one of them fails
      // here for no reason the user can see.
      if (message && /referer|referrer/i.test(message)) {
        return `your key does not allow this address. The app is open at `
          + `${location.origin}, so add that to the key's website restrictions. `
          + 'Allow both http://127.0.0.1:8820/* and http://localhost:8820/* — '
          + 'Google counts them as different sites.';
      }
      // Google withdrew satellite and photorealistic tiles from customers with
      // an EEA billing address on 8 July 2025. Nothing about the key, the
      // billing, or which APIs are enabled changes it, so this must not be
      // reported like the two faults above, which are worth another try.
      if (message && /not available for your account and region/i.test(message)) {
        // Withdrawn under the EEA terms. Verified twice against Google: both
        // the 3D root and a 2D satellite session answer 403 with this message.
        blockPhotoreal('eea');
        return 'withdrawn under the EEA terms · HELP has the detail';
      }
      if (message && /has not been used|is disabled/.test(message)) {
        return 'the Map Tiles API is not enabled on your Google project. '
          + 'Cloud console → APIs & Services → Library → Map Tiles API '
          + '→ Enable. The "enable all Google Maps APIs" box at signup does '
          + 'not include it.';
      }
      return message || `Google returned ${res.status}`;
    }
  } catch (_) { /* fall through to whatever Cesium gave us */ }
  return err.message || String(err);
}

/*
 * The billing counter. Google charges per root-tile request — one per session,
 * three hours of streaming each — and gives away 1000 a month. The request goes
 * from this page straight to Google, so the server never sees it and cannot
 * count it; the page reports each one instead.
 *
 * This therefore counts what this app asked for, from the day counting started.
 * It cannot see a session opened by anything else using the same key, and it is
 * not the bill. The number links to the Google console, which is.
 */
async function showQuota() {
  const link = $('#quota');
  if (!googleKey) return;
  try {
    const usage = await getJSON('/api/usage');
    const used = usage.google_root;
    const limit = usage.free_limit;
    const sv = usage.streetview
      ? ` · ${usage.streetview}/${usage.streetview_limit} street view`
      : '';
    link.textContent = `${used} / ${limit} free sessions used in ${usage.month}${sv}`;
    link.title = 'Counted by this app since ' + usage.since
      + '. Click for Google\'s own figure, which is the one you are billed on.';
    link.classList.toggle('near', used >= limit * 0.8 && used < limit);
    link.classList.toggle('over', used >= limit);
    link.hidden = false;
  } catch (_) { /* leave it hidden rather than show a wrong number */ }
}

async function countRootRequest() {
  try {
    await fetch('/api/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'google_root' }),
    });
  } catch (_) { /* the picture matters more than the tally */ }
  showQuota();
  renderMeters();
}

/*
 * Some refusals are permanent, and a switch that will never work is worse than
 * no switch: it invites the user to keep trying, and the meter beside it counts
 * a free allowance they cannot spend. So the row, its explanation and its meter
 * all go, and the reason moves to the help tab where it is findable without
 * being in the way.
 *
 * What is stored is a code and not the sentence. Storing the prose meant that
 * rewriting the wording never reached anybody already blocked - they kept seeing
 * the first draft, cached, for as long as the browser remembered it.
 */
const PHOTOREAL_REFUSED = 'gcv-photoreal-refused';

function blockPhotoreal(code) {
  // Always written. A first attempt at this only stored on the first refusal, so
  // recalling one from the older key erased that key without replacing it, and
  // the switch came back on the next launch as if nothing had happened.
  localStorage.setItem(PHOTOREAL_REFUSED, code);
  localStorage.removeItem('gcv-photoreal-blocked');   // the old prose-shaped key
  const row = $('#photoreal-row');
  const note = $('#photoreal-blocked');
  if (row) row.hidden = true;
  if (note) note.hidden = true;
  const box = $('#photoreal');
  if (box) {
    box.checked = false;
    box.disabled = true;
  }
  photorealRefused = code;
  renderMeters();
}

/** Which refusal, if any, is standing. Empty while the switch is usable. */
let photorealRefused = '';

/* --------------------------------------------------------------- air quality */

/*
 * What people are breathing, from OpenAQ. Every other layer that looks at the
 * ground looks at the ground; this one measures a thing happening to people, and
 * it is the layer most likely to matter to somebody watching from the place being
 * looked at.
 *
 * Colour is the WHO daily guideline and the steps above it, so green is not
 * "good" in some vague sense - it is under the number the guideline names. A
 * reading carries a station id and not a station name, because getting names
 * would be one request per station and a hundred requests for one glance.
 */

const PM25_STEPS = [
  { max: 15, color: '#4ade80' },    // at or under the WHO 24-hour guideline
  { max: 35, color: '#fcd34d' },
  { max: 55, color: '#fb923c' },
  { max: 150, color: '#ef4444' },
  { max: Infinity, color: '#a855f7' },
];

const airMarks = scene.primitives.add(new Cesium.PointPrimitiveCollection());
let airAt = '';

LAYER_ON_DEMAND.air = () => loadAir(true);

async function loadAir(force) {
  if (!LAYERS.find((l) => l.id === 'air').on) return;
  const c = scene.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(c.latitude);
  const lon = Cesium.Math.toDegrees(c.longitude);
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (key === airAt && !force) return;
  airAt = key;

  try {
    const data = await getJSON(`/api/airquality?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=25`);
    if (data.needs_key) {
      log(`air quality: no OpenAQ key — ${data.how}`, 'warn');
      setCount('air', 0);
      return;
    }
    if (data.error) {
      log(`air quality unavailable: ${data.error}`, 'warn');
      return;
    }
    airMarks.removeAll();
    for (const r of data.readings) {
      if (r.pm25 === null || r.pm25 === undefined) continue;
      const shade = PM25_STEPS.find((step) => r.pm25 < step.max).color;
      airMarks.add({
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString(shade),
        outlineColor: MARK_HALO,
        outlineWidth: 2.5,
        disableDepthTestDistance: MARK_THROUGH_M,
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.4, 3e6, 0.8),
        id: { type: 'air', ref: r },
      });
    }
    setCount('air', data.readings.length);
    log(`air quality: ${data.readings.length} PM2.5 readings within `
      + `${data.radius_km} km · OpenAQ`);
  } catch (err) {
    log(`air quality unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(() => loadAir(false));

/* ------------------------------------------------------------------ fishing */

/*
 * Global Fishing Watch turn AIS into behaviour: not where a vessel is, which the
 * vessel layer already shows, but what it appears to be doing.
 *
 * The gaps deserve their own warning and get it on the card. A transponder stops
 * for a great many innocent reasons - equipment, coverage, a satellite missing a
 * pass - so a gap is a question and not an accusation. A map that quietly implies
 * smuggling is worse than no map at all.
 */

const FISHING_KINDS = {
  fishing: { color: '#34d399', label: 'fishing' },
  encounter: { color: '#fbbf24', label: 'encounter' },
  gap: { color: '#f472b6', label: 'AIS gap' },
};

const fishingMarks = scene.primitives.add(new Cesium.PointPrimitiveCollection());
let fishingAt = '';

LAYER_ON_DEMAND.fishing = () => loadFishing(true);

async function loadFishing(force) {
  if (!LAYERS.find((l) => l.id === 'fishing').on) return;
  const c = scene.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(c.latitude);
  const lon = Cesium.Math.toDegrees(c.longitude);
  const radius = Math.max(50, Math.min(c.height / 1000, 600));
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${Math.round(radius)}`;
  if (key === fishingAt && !force) return;
  fishingAt = key;

  try {
    const data = await getJSON(`/api/fishing?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`
      + `&radius=${Math.round(radius)}`);
    if (data.needs_key) {
      log(`fishing activity: no Global Fishing Watch token — ${data.how}`, 'warn');
      setCount('fishing', 0);
      return;
    }
    if (data.error) {
      log(`fishing activity unavailable: ${data.error}`, 'warn');
      return;
    }
    fishingMarks.removeAll();
    for (const e of data.events) {
      const kind = FISHING_KINDS[e.kind] || { color: '#94a3b8' };
      fishingMarks.add({
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0),
        pixelSize: e.kind === 'gap' ? 13 : 10,
        color: Cesium.Color.fromCssColorString(kind.color),
        outlineColor: MARK_HALO,
        outlineWidth: 2.5,
        disableDepthTestDistance: MARK_THROUGH_M,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.4, 8e6, 0.7),
        id: { type: 'fishing', ref: e },
      });
    }
    const gaps = data.events.filter((e) => e.kind === 'gap').length;
    setCount('fishing', data.events.length);
    log(`fishing activity: ${data.events.length} events in ${data.days} days `
      + `· ${gaps} of them transponder gaps · Global Fishing Watch`);
  } catch (err) {
    log(`fishing activity unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(() => loadFishing(false));

/* ----------------------------------------------------------- traffic jams */

/*
 * The flow tiles colour a road by how fast it is moving. This is the reason it
 * is not moving: queuing traffic, a closure, roadworks, a crash - each on its
 * own stretch of road, with the seconds it is costing.
 *
 * TomTom grade delay 1 to 3 and use 4 for a closure, but most incidents come
 * back graded 0. That is not missing data: roadworks block a road without there
 * being a measured delay to quote. Graded ones get a colour that says how bad,
 * ungraded ones are drawn thin and grey, and the card says which it is rather
 * than implying every line is a jam.
 *
 * Nobody is asking for small animated cars here, tempting as they are. There is
 * no feed of individual cars, so they would be invented - and a moving dot that
 * is not a car is the thing this app took out once already.
 */

const JAM_GRADES = {
  1: { color: '#fcd34d', width: 5, label: 'minor delay' },
  2: { color: '#fb923c', width: 7, label: 'moderate delay' },
  3: { color: '#ef4444', width: 9, label: 'major delay' },
  4: { color: '#c084fc', width: 6, label: 'road blocked' },
};
const JAM_UNGRADED = { color: '#8a97a6', width: 3, label: 'no delay graded' };

let jamPrimitive = null;
let jamAt = '';

LAYER_ON_DEMAND.jams = () => loadJams(true);

async function loadJams(force) {
  if (!LAYERS.find((l) => l.id === 'jams').on) return;
  const view = viewer.camera.computeViewRectangle();
  if (!view) return;
  const box = {
    south: Cesium.Math.toDegrees(view.south),
    west: Cesium.Math.toDegrees(view.west),
    north: Cesium.Math.toDegrees(view.north),
    east: Cesium.Math.toDegrees(view.east),
  };
  const key = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(2)).join(',');
  if (key === jamAt && !force) return;
  jamAt = key;

  try {
    const data = await getJSON('/api/incidents?'
      + `south=${box.south.toFixed(3)}&west=${box.west.toFixed(3)}`
      + `&north=${box.north.toFixed(3)}&east=${box.east.toFixed(3)}`);
    if (data.needs_key) {
      log(`traffic jams: no TomTom key — ${data.how}`, 'warn');
      setCount('jams', 0);
      return;
    }
    if (data.too_wide) {
      // A 0 here reads as "no jams in Sweden", which is quite the claim. The
      // layer has no answer at this height, and says so instead of a number.
      log(`traffic jams: ${data.note}`, 'warn');
      if (jamPrimitive) { scene.primitives.remove(jamPrimitive); jamPrimitive = null; }
      const layer = LAYERS.find((l) => l.id === 'jams');
      layer.count = 0;
      layer.noCount = true;
      renderLayerList();
      return;
    }
    if (data.error) {
      jamAt = '';
      log(`traffic jams unavailable: ${data.error} · will retry`, 'warn');
      return;
    }

    const instances = [];
    for (const inc of data.incidents) {
      if (!inc.line || inc.line.length < 4) continue;
      const grade = JAM_GRADES[inc.magnitude] || JAM_UNGRADED;
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.GroundPolylineGeometry({
          positions: Cesium.Cartesian3.fromDegreesArray(inc.line),
          width: grade.width,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(grade.color).withAlpha(0.9)
          ),
        },
        id: { type: 'jam', ref: inc },
      }));
    }
    if (jamPrimitive) scene.primitives.remove(jamPrimitive);
    jamPrimitive = instances.length ? scene.primitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      })
    ) : null;

    const graded = data.incidents.filter((x) => JAM_GRADES[x.magnitude]).length;
    LAYERS.find((l) => l.id === 'jams').noCount = false;
    setCount('jams', data.incidents.length);
    log(`traffic jams: ${data.incidents.length} incidents in view, ${graded} with a `
      + `graded delay · TomTom`);
  } catch (err) {
    jamAt = '';
    log(`traffic jams unavailable (${err.message}) · will retry`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(() => loadJams(false));

/*
 * Traffic is the one layer here where sitting still is the normal way to watch
 * it. Everything else you fly around; a jam you stare at. So this cannot wait
 * for the camera to move, the way the other view-shaped layers do - it has to
 * come back on its own or the picture quietly freezes while looking live.
 *
 * Two minutes, and only while the layer is lit. TomTom's own cache headers say
 * no-store, so nothing between here and them is holding an old answer.
 */
const JAM_REFRESH_MS = 120_000;
setInterval(() => {
  if (LAYERS.find((l) => l.id === 'jams').on) loadJams(true);
}, JAM_REFRESH_MS);

/* ------------------------------------------------------------------ launches */

/*
 * The satellite layer shows what is already up there. This is what is on its way
 * up, which is the more watchable half: a launch has a place and a time, so it is
 * the one thing on this globe you can plan to be looking at.
 *
 * A scheduled launch is a plan and not a fact, so the status comes through
 * untranslated - Go, TBD, Hold - and the marker dims for anything that is not Go.
 * Half of spaceflight is slipping to the right and the map should say so.
 */

const launchPads = scene.primitives.add(new Cesium.PointPrimitiveCollection());

LAYER_ON_DEMAND.launches = () => loadLaunches();

async function loadLaunches() {
  if (!LAYERS.find((l) => l.id === 'launches').on) return;
  try {
    const data = await getJSON('/api/launches');
    if (data.error) {
      log(`launches unavailable: ${data.error}`, 'warn');
      return;
    }
    launchPads.removeAll();
    const now = Date.now();
    let soon = 0;
    for (const L of data.launches) {
      const when = Date.parse(L.when);
      const hours = Number.isFinite(when) ? (when - now) / 3600000 : Infinity;
      if (hours < 24) soon += 1;
      const go = L.status === 'Go' || L.status === 'Success';
      launchPads.add({
        position: Cesium.Cartesian3.fromDegrees(L.lon, L.lat, 0),
        pixelSize: hours < 24 ? 15 : 11,
        color: Cesium.Color.fromCssColorString(go ? '#fb923c' : '#7c8794'),
        outlineColor: MARK_HALO,
        outlineWidth: 2.5,
        disableDepthTestDistance: MARK_THROUGH_M,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.4, 2e7, 0.75),
        id: { type: 'launch', ref: { ...L, hours } },
      });
    }
    setCount('launches', data.launches.length);
    log(`launches: ${data.launches.length} scheduled · ${soon} inside 24 hours `
      + `· The Space Devs`);
  } catch (err) {
    log(`launches unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------------ infrastructure */

/*
 * Two kinds of thing that are enormous, quietly critical, and on no other layer
 * here: the buildings the internet actually runs in, and the walls holding back
 * the water above towns.
 *
 * Queried live for the view rather than bundled. A bundled extract would be a
 * copy of somebody's database under ODbL with share-alike attached; asking for
 * what is on screen avoids both that and a file that quietly goes stale.
 *
 * Most dams in OpenStreetMap have no name. The card says "unnamed" rather than
 * reaching for the nearest label, because a wall with the wrong name on it is
 * worse than a wall with none.
 */

const infraMarks = scene.primitives.add(new Cesium.PointPrimitiveCollection());
let infraAt = '';

LAYER_ON_DEMAND.infra = () => loadInfrastructure(true);

async function loadInfrastructure(force) {
  if (!LAYERS.find((l) => l.id === 'infra').on) return;
  const view = viewer.camera.computeViewRectangle();
  if (!view) return;
  const box = {
    south: Cesium.Math.toDegrees(view.south),
    west: Cesium.Math.toDegrees(view.west),
    north: Cesium.Math.toDegrees(view.north),
    east: Cesium.Math.toDegrees(view.east),
  };
  const key = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(1)).join(',');
  if (key === infraAt && !force) return;
  infraAt = key;

  try {
    const data = await getJSON('/api/infrastructure?'
      + `south=${box.south.toFixed(3)}&west=${box.west.toFixed(3)}`
      + `&north=${box.north.toFixed(3)}&east=${box.east.toFixed(3)}`);
    if (data.too_wide) {
      // Said out loud rather than drawing nothing: an empty layer at world zoom
      // reads as "there are no dams", which is quite the claim.
      log(`infrastructure: ${data.note}`, 'warn');
      infraMarks.removeAll();
      setCount('infra', 0);
      return;
    }
    if (data.error) {
      // Overpass is a free shared service and times out under load. Forgetting
      // where we asked means the next camera move tries again, instead of the
      // layer sitting empty for as long as you hold still.
      infraAt = '';
      log(`infrastructure unavailable: ${data.error} · will retry`, 'warn');
      return;
    }
    infraMarks.removeAll();
    for (const site of data.sites) {
      const dam = site.kind === 'dam';
      infraMarks.add({
        position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 0),
        pixelSize: dam ? 11 : 13,
        color: Cesium.Color.fromCssColorString(dam ? '#38bdf8' : '#c084fc'),
        outlineColor: MARK_HALO,
        outlineWidth: 2.5,
        disableDepthTestDistance: MARK_THROUGH_M,
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.4, 4e6, 0.7),
        id: { type: 'infra', ref: site },
      });
    }
    const dams = data.sites.filter((x) => x.kind === 'dam').length;
    setCount('infra', data.sites.length);
    log(`infrastructure: ${dams} dams, ${data.sites.length - dams} data centres `
      + `· OpenStreetMap`);
  } catch (err) {
    infraAt = '';
    log(`infrastructure unavailable (${err.message}) · will retry`, 'warn');
  }
  applyVisibility();
}

viewer.camera.moveEnd.addEventListener(() => loadInfrastructure(false));

/* ------------------------------------------------------------------ traffic */

/*
 * Measured traffic flow, from TomTom.
 *
 * The simulated version this replaces was taken out for a good reason: a moving
 * dot that is not a car is worse than no dot at all, because it looks like
 * information. This one is measured, which is the whole difference, and it needs
 * a key to say so.
 *
 * Tiles rather than points, and fetched by the browser rather than through the
 * server, because TomTom restrict browser keys by referrer exactly as Google do.
 */

let trafficLayer = null;
let tomtomKey = null;

LAYER_ON_DEMAND.traffic = () => showTraffic(true);

async function showTraffic(on) {
  if (!on) {
    if (trafficLayer) trafficLayer.show = false;
    return;
  }
  // applyVisibility runs on every layer change, so this is re-entered constantly.
  // Without the guard each pass fired its own request for the key.
  if (showTraffic.asking) return;

  if (!tomtomKey) {
    showTraffic.asking = true;
    try {
      const data = await getJSON('/api/tomtom');
      tomtomKey = data.key || '';
      if (!tomtomKey) {
        // Deliberately not remembered. An earlier version cached the empty
        // answer, so pasting a key into SETUP and switching the layer on did
        // nothing at all until a reload - the app had decided there was no key
        // and stopped asking.
        if (!showTraffic.said) {
          log(`traffic: no TomTom key — ${data.how}`, 'warn');
          showTraffic.said = true;
        }
        return;
      }
      showTraffic.said = false;
    } catch (err) {
      log(`traffic unavailable (${err.message})`, 'warn');
      return;
    } finally {
      showTraffic.asking = false;
    }
  }

  if (!trafficLayer) {
    trafficLayer = newTrafficLayer();
    log('traffic: TomTom flow on · measured, not simulated');
  }
  trafficLayer.show = true;
}

/** One flow layer, stamped so the next one is a different set of tiles. */
function newTrafficLayer() {
  return viewer.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      // The stamp is what makes a refresh possible at all. Cesium keeps a tile
      // it has already drawn and will not ask for it again, however short-lived
      // TomTom say it is, because as far as Cesium is concerned the URL has not
      // changed. Changing it is the only honest way to get a new picture.
      url: 'https://api.tomtom.com/traffic/map/4/tile/flow/relative0/'
        + `{z}/{x}/{y}.png?key=${encodeURIComponent(tomtomKey)}`
        + `&_t=${Math.floor(Date.now() / TRAFFIC_REFRESH_MS)}`,
      maximumLevel: 18,
      credit: new Cesium.Credit('Traffic flow © TomTom'),
    })
  );
}

/*
 * Rebuilt on the same two minutes as the incidents, and deliberately not by
 * swapping one layer for another: the new one is laid over the old and the old
 * removed a few seconds later, once it has something to show. Removing first
 * blanks every road on screen for as long as the tiles take, which during a
 * recording is worse than a slightly stale picture.
 */
const TRAFFIC_REFRESH_MS = 120_000;

setInterval(() => {
  if (!trafficLayer || !LAYERS.find((l) => l.id === 'traffic').on) return;
  if (!tomtomKey) return;
  const old = trafficLayer;
  trafficLayer = newTrafficLayer();
  trafficLayer.show = true;
  setTimeout(() => {
    try { viewer.imageryLayers.remove(old, true); } catch (_) { /* already gone */ }
  }, 4000);
}, TRAFFIC_REFRESH_MS);

/* ---------------------------------------------------------- camera viewsheds */

/*
 * A camera marker says where a camera is. It does not say what it can see, which
 * is the question you actually have when you are looking at one.
 *
 * Only calibrated cameras get a cone. The feeds carry a position and nothing
 * else - no bearing, no field of view - so for an uncalibrated camera any cone
 * would be a direction invented by me and pointed at somebody's house. Calibrate
 * one from its card and it gets a real cone, from real numbers you set.
 */

const viewsheds = scene.primitives.add(new Cesium.PrimitiveCollection());

function drawViewsheds() {
  viewsheds.removeAll();
  const layer = LAYERS.find((l) => l.id === 'cameras');
  if (!layer || !layer.on) return;
  const calibrations = loadCalibrations();
  let drawn = 0;

  for (let i = 0; i < collections.cameras.length; i++) {
    const primitive = collections.cameras.get(i);
    const station = primitive.id && primitive.id.ref;
    if (!station || primitive.show === false) continue;
    const cal = calibrations[station.id];
    if (!cal) continue;

    const heading = cal.heading || 0;
    const fov = cal.fov || 55;
    const range = cal.range || 260;
    // A wedge: the camera, then the arc it covers, then back to the camera.
    const points = [station.lon, station.lat];
    for (let a = -fov / 2; a <= fov / 2; a += Math.max(2, fov / 24)) {
      const bearing = Cesium.Math.toRadians(heading + a);
      points.push(
        station.lon + (range * Math.sin(bearing))
          / (111320 * Math.cos(Cesium.Math.toRadians(station.lat))),
        station.lat + (range * Math.cos(bearing)) / 110540
      );
    }
    points.push(station.lon, station.lat);

    viewsheds.add(new Cesium.GroundPrimitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(points)
          ),
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString('#7dffab').withAlpha(0.22)
          ),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true }),
    }));
    drawn += 1;
  }
  if (drawn) log(`viewsheds: ${drawn} calibrated camera(s) drawn`);
}

/* -------------------------------------------------------------- ISS passes */

/*
 * When the station goes over, and whether it will be lit.
 *
 * Worked out from the orbit this app already propagates rather than from a pass
 * API, so it needs no extra source and agrees with the dot on screen by
 * construction. Stepped forward a quarter of a minute at a time for a day, which
 * is coarse enough to be quick and fine enough that a six-minute pass cannot slip
 * between two samples.
 *
 * Ten degrees is the floor. Lower than that and the station is behind whatever
 * is on your horizon, so a pass that peaks at four degrees is not a pass you can
 * watch, and printing it would be a promise the sky does not keep.
 */

const ISS_NORAD = 25544;
const PASS_FLOOR_DEG = 10;

/** Next ISS passes over wherever the camera is pointed, as card rows. */
function issPassRows() {
  const carto = viewer.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const passes = issPasses(lat, lon);
  if (!passes) return [];
  if (!passes.length) {
    return [['Passes overhead', `none above ${PASS_FLOOR_DEG}\u00b0 in the next 24 hours`]];
  }
  const rows = [['Passes over', `${lat.toFixed(2)}, ${lon.toFixed(2)} \u00b7 `
    + `next 24 hours, above ${PASS_FLOOR_DEG}\u00b0`]];
  for (const pass of passes) {
    const clock = (d) => d.toISOString().slice(11, 16);
    const minutes = Math.round((pass.end - pass.start) / 60000);
    rows.push([clock(pass.start) + ' UTC',
      `peaks ${Math.round(pass.peak)}\u00b0 at ${clock(pass.peakAt)}, `
      + `${minutes} min, ${Math.round(pass.range / 1000)} km at closest`]);
  }
  return rows;
}

function issPasses(lat, lon, hours = 24) {
  const iss = satellites.find((sat) => Number(sat.norad) === ISS_NORAD);
  if (!iss || !iss.satrec) return null;

  const observer = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const up = Cesium.Cartesian3.normalize(observer, new Cesium.Cartesian3());
  const passes = [];
  const toSat = new Cesium.Cartesian3();
  let current = null;

  for (let t = 0; t < hours * 3600; t += 15) {
    const when = new Date(Date.now() + t * 1000);
    const eci = satellite.propagate(iss.satrec, when);
    if (!eci || !eci.position || Number.isNaN(eci.position.x)) continue;
    const geo = satellite.eciToGeodetic(eci.position, satellite.gstime(when));
    const at = Cesium.Cartesian3.fromRadians(
      geo.longitude, geo.latitude, geo.height * 1000);

    Cesium.Cartesian3.subtract(at, observer, toSat);
    const range = Cesium.Cartesian3.magnitude(toSat);
    Cesium.Cartesian3.normalize(toSat, toSat);
    const elevation = 90 - Cesium.Math.toDegrees(
      Math.acos(Cesium.Math.clamp(Cesium.Cartesian3.dot(up, toSat), -1, 1))
    );

    if (elevation >= PASS_FLOOR_DEG) {
      if (!current) {
        current = { start: when, peak: elevation, peakAt: when, range };
      } else if (elevation > current.peak) {
        current.peak = elevation;
        current.peakAt = when;
        current.range = range;
      }
    } else if (current) {
      current.end = when;
      passes.push(current);
      current = null;
      if (passes.length >= 4) break;
    }
  }
  return passes;
}

/* --------------------------------------------------------- ground change */

/*
 * Radar and change detection, from NASA's OPERA products through GIBS.
 *
 * Everything else on this globe that looks at the ground looks at it in visible
 * light, which means night and cloud hide whatever is happening - and whatever is
 * happening is often exactly why there is cloud. Sentinel-1 is radar: it does not
 * care about either, and it is the only layer here that can see a flood while the
 * storm is still overhead.
 *
 * Three products, and they answer different questions:
 *
 *   backscatter  what the surface is made of and how rough it is. Water goes
 *                black, cities go bright, and a ship on open sea is a dot where
 *                no dot should be.
 *   disturbance  where vegetation cover has dropped since a baseline. Burn scars,
 *                clear-cuts, and ground churned up by something heavy.
 *   surface water  where there is water today that is not normally water.
 *
 * They lag. A swath has to be flown, downlinked and processed, so these carry
 * their own delay on top of the day slider and each layer says its own date in
 * the feed. This is imagery of something that happened, not a live view.
 *
 * NASA, so public domain and safe in commercial mode - the one family of sources
 * here that needs no argument about terms.
 */

const OPERA_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';

const OPERA = [
  {
    id: 'sar',
    product: 'OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1',
    // Two days: a Sentinel-1 swath is rarely through processing before then, and
    // asking for today just paints nothing and looks like a broken layer.
    lag: 2,
    alpha: 0.85,
  },
  {
    id: 'disturb',
    product: 'OPERA_L3_DIST-ALERT-HLS_Color_Index',
    // Built from Landsat and Sentinel-2 together, and published furthest behind.
    lag: 3,
    alpha: 0.9,
  },
  {
    id: 'water',
    product: 'OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1',
    lag: 2,
    alpha: 0.9,
  },
];

// Roughly a country in view. Above this the bands are swath outlines and
// nothing readable, so the layer holds its fire.
const OPERA_MIN_LEVEL = 5;

/*
 * Held back until it is worth drawing, for two reasons that both survive the
 * logo being switched off.
 *
 * A 10 m product read from orbit height shows nothing 10 m wide, which is the
 * same argument the OPERA layers are held back on. And every tile is one
 * request against a monthly allowance of thirty thousand, so a screen filled at
 * continental zoom spends thirty of them to show a blur. Requests are the quota
 * anyone meets first, and this is the cheapest place to not waste them.
 */
const CDSE_MIN_LEVEL = 8;
const CDSE_HINT_M = 400_000;
const OPERA_HINT_M = 1_200_000;

const operaLayers = new Map();   // id -> Cesium.ImageryLayer

/** The date to ask an OPERA product for: the day slider, plus its own lag. */
function operaDay(spec) {
  const ms = Date.now() - (36 + (dayOffset + spec.lag) * 24) * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function showOpera(spec, on) {
  let layer = operaLayers.get(spec.id);
  if (on && !layer) {
    const day = operaDay(spec);
    layer = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: `${OPERA_BASE}${spec.product}/default/${day}/`
          + 'GoogleMapsCompatible_Level12/{z}/{y}/{x}.png',
        maximumLevel: 12,
        credit: new Cesium.Credit('NASA OPERA / GIBS \u2014 public domain'),
      })
    );
    layer.alpha = spec.alpha;
    // These are 30 m products. Seen from orbit height the swaths draw as broad
    // diagonal bands across a continent - you are reading where the satellite
    // flew, not what it measured, and it looks like damage to the map rather
    // than information on it. Below this level the layer stays off and says so.
    layer.minimumTerrainLevel = OPERA_MIN_LEVEL;
    operaLayers.set(spec.id, layer);
    const layerName = LAYERS.find((l) => l.id === spec.id);
    log(`${layerName ? layerName.name.toLowerCase() : spec.id}: NASA OPERA, ${day} `
      + `\u00b7 30 m, radar sees through cloud and night`);
    // Turned on from too far out it draws nothing, and silence reads as broken.
    if (scene.camera.positionCartographic.height > OPERA_HINT_M) {
      log(`${layerName ? layerName.name.toLowerCase() : spec.id}: too far out to `
        + `draw · zoom in to about a country and it appears`, 'warn');
    }
  }
  if (layer) layer.show = on;
}

/** Rebuild any lit OPERA layer for a new date. Called when the day slider moves. */
function refreshOpera() {
  for (const spec of OPERA) {
    const layer = operaLayers.get(spec.id);
    if (!layer) continue;
    viewer.imageryLayers.remove(layer, true);
    operaLayers.delete(spec.id);
  }
  for (const spec of OPERA) {
    const wanted = LAYERS.find((l) => l.id === spec.id);
    if (wanted && wanted.on) showOpera(spec, true);
  }
}

/* ------------------------------------------------- layers in the 3D view */

/*
 * Google's 3D view is a separate renderer, so nothing drawn in Cesium appears in
 * it. Rather than port each layer by hand - twenty-odd of them, drifting apart
 * the first time one changes - the layers are read back out of the Cesium
 * collections they already live in and mirrored as Google markers. One
 * mechanism, and a new layer joins it by adding a line to the table below.
 *
 * Two limits, both stated in the feed rather than hidden.
 *
 * Markers here are DOM elements, not points in a vertex buffer. Twelve thousand
 * aircraft would be twelve thousand custom elements and the tab would stop
 * responding, so only the nearest few hundred to the middle of the view are
 * drawn. The 3D view is a view of a city; the rest of the planet is not on
 * screen anyway.
 *
 * And borders and place names are not mirrored at all. Google draw their own in
 * hybrid mode, better than a mirrored copy would, and drawing both would put two
 * slightly different sets of lines on the same coastline.
 */

const MAP3D_CAP = 300;

// Layer id to the Cesium collection it lives in. Satellites are left out on
// purpose: in a view of a few city blocks a thing 500 km up is not on screen,
// and a marker clamped to the ground for it would be a lie about where it is.
const MAP3D_SOURCES = [
  ['flights', () => collections.flights],
  ['services', () => collections.services],
  ['vessels', () => collections.vessels],
  ['cameras', () => collections.cameras],
  ['cables', () => collections.landings],
  ['quakes', () => quakes],
  ['fires', () => fires],
  ['outbreaks', () => outbreaks],
  ['own', () => ownEntries],
  ['volcanoes', () => volcanoes],
  ['radio', () => radios],
  ['broadcast', () => broadcast],
  ['scanners', () => scanners],
  ['aprs', () => aprs],
  ['airports', () => airports],
  ['weather', () => alerts],
  ['plants', () => plants],
  ['launches', () => launchPads],
  ['infra', () => infraMarks],
  ['air', () => airMarks],
  ['fishing', () => fishingMarks],
  ['netout', () => netOut],
  ['mesh', () => meshNodes],
  ['news', () => newsHeat],
  ['trains', () => trains],
  ['bases', () => subBases],
  ['capital', () => capitalShips],
];

let map3dMarkers = [];
let map3dPin = null;
let mirrorPending = 0;

/** Every drawn thing in an on layer, as plain numbers. */
function readCollections() {
  const out = [];
  const carto = new Cesium.Cartographic();
  for (const [id, get] of MAP3D_SOURCES) {
    const layer = LAYERS.find((l) => l.id === id);
    if (!layer || !layer.on) continue;
    let col;
    try { col = get(); } catch (_) { continue; }
    if (!col || !col.length) continue;
    for (let i = 0; i < col.length; i++) {
      const item = col.get(i);
      if (!item || item.show === false || !item.position) continue;
      Cesium.Cartographic.fromCartesian(item.position, undefined, carto);
      out.push({
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
        height: carto.height || 0,
        colour: layer.color,
        pick: item.id,
      });
    }
  }
  return out;
}

/** Draw the on layers into the 3D view, nearest to the middle of it first. */
async function mirrorLayers() {
  if (!map3d || $('#map3d').hidden) return;
  // Steadying the camera fires more than once; only the last one matters.
  const mine = ++mirrorPending;
  const maps = await loadMapsJs();
  const lib = await maps.importLibrary('maps3d');
  const { PinElement } = await maps.importLibrary('marker');
  if (mine !== mirrorPending) return;

  for (const marker of map3dMarkers) marker.remove();
  map3dMarkers = [];

  const centre = map3d.center || { lat: 0, lng: 0 };
  const found = readCollections();
  // Rough degrees rather than a great-circle distance: this only has to rank
  // things by how near the middle they are, and it ranks a few thousand of them
  // every time the camera settles.
  const scale = Math.cos(Cesium.Math.toRadians(centre.lat)) || 1;
  for (const thing of found) {
    const dx = (thing.lon - centre.lng) * scale;
    const dy = thing.lat - centre.lat;
    thing.d = dx * dx + dy * dy;
  }
  found.sort((a, b) => a.d - b.d);
  const shown = found.slice(0, MAP3D_CAP);

  for (const thing of shown) {
    // Anything genuinely in the air keeps its altitude - an aircraft on the
    // ground beneath itself would be the whole point missed. Everything else is
    // clamped, because its height came from a globe with different terrain.
    const flying = thing.height > 150;
    const marker = new lib.Marker3DInteractiveElement({
      position: { lat: thing.lat, lng: thing.lon, altitude: flying ? thing.height : 0 },
      altitudeMode: flying ? lib.AltitudeMode.ABSOLUTE : lib.AltitudeMode.CLAMP_TO_GROUND,
      extruded: flying,   // a line down to the ground, or it floats with no depth
    });
    marker.append(new PinElement({
      background: thing.colour,
      borderColor: '#04070c',
      glyphColor: '#04070c',
      scale: 0.7,
    }));
    if (thing.pick && thing.pick.type) {
      marker.addEventListener('gmp-click', () => {
        describePicked(thing.pick.type, thing.pick.ref);
      });
    }
    map3d.append(marker);
    map3dMarkers.push(marker);
  }

  if (found.length > shown.length) {
    log(`3D view: ${shown.length} of ${found.length} marks drawn `
      + `\u00b7 nearest the middle, the rest left out to keep it responsive`);
  } else if (shown.length) {
    log(`3D view: ${shown.length} marks drawn`);
  }
}

/*
 * Photorealistic 3D, through Google's own renderer rather than Cesium's.
 *
 * The Map Tiles API refuses this account outright - "satellite tiles and 3D
 * tiles are not available for your account and region", the EEA withdrawal of
 * 8 July 2025 - and no key, card or quota changes that. Photorealistic 3D Maps
 * in the Maps JavaScript API is a different service, is absent from Google's own
 * list of EEA-adjusted services, and serves this account. Confirmed on screen
 * over Stockholm before any of this was written.
 *
 * It brings its own renderer, so the two cannot share a canvas. Google's element
 * sits over Cesium's and they hand the camera between them, which means turning
 * it on does not lose your place and turning it off does not either.
 */

let map3d = null;

/** Where the camera is looking, as a point on the ground rather than in the air. */
function cameraTarget() {
  const middle = new Cesium.Cartesian2(
    scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  // Deliberately not surfacePoint, which asks the depth buffer first. That is the
  // right answer for a ruler, which measures what is drawn, and the wrong one
  // here: this runs the instant the switch is flipped, and a depth buffer that
  // has not been rendered this frame reads back as a point sixty kilometres from
  // where the camera is actually looking. Measured, on this machine.
  //
  // Ray against the ellipsoid is pure geometry and needs no frame at all. It
  // answers sea level rather than terrain, which costs nothing here: Google
  // bring their own ground, and the handover only has to arrive at the right
  // place, not at the right altitude.
  const onEllipsoid = viewer.camera.pickEllipsoid(middle, scene.globe.ellipsoid);
  if (Cesium.defined(onEllipsoid)) return onEllipsoid;
  // Pointed at the sky there is no ground point at all. Straight down is where
  // the eye ends up anyway once the view tips back over.
  const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0);
}

async function showPhotoreal(on) {
  if (!googleKey || googleBusy) return;
  const host = $('#map3d');

  if (!on) {
    if (map3d) {
      // Carry the camera back, so switching off leaves you where you were
      // standing rather than where you last were in Cesium.
      const c = map3d.center;
      if (c) {
        const target = Cesium.Cartesian3.fromDegrees(c.lng, c.lat, c.altitude || 0);
        viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(map3d.heading || 0),
          Cesium.Math.toRadians((map3d.tilt || 0) - 90),
          Math.max(120, map3d.range || 1200)
        ));
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }
    }
    host.hidden = true;
    $('#globe').style.visibility = '';
    log('photoreal 3D off');
    return;
  }

  googleBusy = true;
  try {
    const maps = await loadMapsJs();
    const { Map3DElement, MapMode } = await maps.importLibrary('maps3d');

    const target = cameraTarget();
    const at = Cesium.Cartographic.fromCartesian(target);
    const range = Math.max(120,
      Cesium.Cartesian3.distance(viewer.camera.position, target));
    // Cesium measures pitch from the horizon downwards and Google measures tilt
    // from straight down upwards, so the two are ninety degrees apart.
    const tilt = Math.min(89, Math.max(0,
      90 + Cesium.Math.toDegrees(viewer.camera.pitch)));
    const heading = (Cesium.Math.toDegrees(viewer.camera.heading) + 360) % 360;
    const centre = {
      lat: Cesium.Math.toDegrees(at.latitude),
      lng: Cesium.Math.toDegrees(at.longitude),
      altitude: at.height || 0,
    };

    if (!map3d) {
      map3d = new Map3DElement({
        center: centre, range, tilt, heading,
        mode: MapMode ? MapMode.HYBRID : undefined,
      });
      host.append(map3d);
      countRootRequest();
    } else {
      map3d.center = centre;
      map3d.range = range;
      map3d.tilt = tilt;
      map3d.heading = heading;
    }
    host.hidden = false;
    // Cesium keeps rendering underneath otherwise, for nobody, at full cost.
    $('#globe').style.visibility = 'hidden';
    // Redrawn whenever the view settles, because which marks are nearest the
    // middle changes the moment you fly anywhere.
    if (!map3d.__wired) {
      map3d.addEventListener('gmp-steadychange', (e) => {
        if (!e.isSteady) return;
        mirrorLayers();
      });
      map3d.__wired = true;
    }
    mirrorLayers();
    log(`photoreal 3D on · Google 3D Maps at ${centre.lat.toFixed(4)}, `
      + `${centre.lng.toFixed(4)} · ${Math.round(range)} m out`);
  } catch (err) {
    log(`photoreal 3D unavailable: ${err && err.message ? err.message : err}`, 'warn');
    $('#photoreal').checked = false;
    host.hidden = true;
    $('#globe').style.visibility = '';
  } finally {
    googleBusy = false;
  }
}

$('#photoreal').onchange = (e) => showPhotoreal(e.target.checked);

/* ------------------------------------------------------- commercial-safe */

/*
 * What the switch actually withdraws, and why each one:
 *
 *   basemap        Esri imagery and canvas, for NASA GIBS       (terms)
 *   terrain        Cesium ion Community tier is personal use    (licence)
 *   ion buildings  same tier, same licence                      (licence)
 *   photoreal 3D   Google Maps Platform has its own terms       (terms)
 *   Windy cameras  free tier is link-and-embed only             (licence)
 *   hull photos    planespotters ask for non-commercial use     (request)
 *
 * Our own Overpass building boxes stay: OSM is ODbL, which permits commercial
 * use with attribution, and the attribution is already in the footer. Wikipedia
 * type photos stay for the same reason - mostly CC BY-SA, credited on the card.
 *
 * Nothing is withdrawn quietly. Each one is named in the feed log as it goes.
 */

const SAFE_WITHDRAWN = [
  'basemap \u2192 NASA GIBS, 300 m',
  'world terrain off',
  'Cesium 3D buildings off',
  'photoreal 3D off',
  'Windy webcams hidden',
  'planespotters hull photos suppressed',
];

function safeCameraAllowed(station) {
  return !safeMode || station.source !== 'Windy';
}

function applySafeMode(announce) {
  localStorage.setItem('gcv-safe', safeMode ? '1' : '0');
  $('#safe').checked = safeMode;
  $('#safe-badge').hidden = !safeMode;
  $('#safe-note').textContent = safeMode
    ? 'Only sources with an unambiguous licence. Wide shots come from NASA at '
      + 'about 300 m; descending hands over to Sentinel-2 at 10 m, CC BY 4.0. '
      + 'Read the terms yourself before monetising \u2014 this switch is a '
      + 'shortcut, not advice.'
    : 'Off: every source is in use, including several that permit '
      + 'non-commercial use only. Fine for watching, not for a monetised video.';

  // Imagery: rebuild whatever look is current, from the other source.
  rebuildImagery();

  if (safeMode) {
    if ($('#photoreal').checked) {
      $('#photoreal').checked = false;
      showPhotoreal(false);
    }
    $('#photoreal').disabled = true;
    if (ionBuildings) ionBuildings.show = false;
    if (flatTerrain && scene.globe.depthTestAgainstTerrain) {
      viewer.terrainProvider = flatTerrain;
      scene.globe.depthTestAgainstTerrain = false;
      $('#terrain').checked = false;
    }
    $('#terrain').disabled = true;
    // TeleGeography licence their *map* CC BY-SA 4.0 and point anyone wanting the
    // *data* commercially at a form. This layer reads the data feed, so it is not
    // one of the clear-cut ones and comes off with the rest of them.
    const cableLayer = LAYERS.find((l) => l.id === 'cables');
    if (cableLayer && cableLayer.on) {
      cableLayer.on = false;
      renderLayerList();
    }
  } else {
    // Never re-enable a switch that Google has refused outright: safe mode is
    // about licences, and has no opinion on what the account is allowed.
    if ($('#photoreal-blocked').hidden) $('#photoreal').disabled = false;
    $('#terrain').disabled = false;
    if (ionBuildings) ionBuildings.show = $('#buildings').checked;
  }

  // Windy stations come and go with the switch rather than being refetched.
  for (let i = 0; i < collections.cameras.length; i++) {
    const primitive = collections.cameras.get(i);
    const station = primitive.id && primitive.id.ref;
    if (station) primitive.show = safeCameraAllowed(station);
  }

  if (announce) {
    log(safeMode
      ? `commercial-safe ON \u2014 ${SAFE_WITHDRAWN.join(' \u00b7 ')}`
      : 'commercial-safe OFF \u2014 all sources back, non-commercial ones included');
  }
}

$('#safe').onchange = (e) => {
  safeMode = e.target.checked;
  applySafeMode(true);
};

/* ------------------------------------------------------------- where am I */

/*
 * The readout gave a latitude and a longitude, which answers "where" only if you
 * already know. Standing over 63.5, -118.8 and not being sure whether that is
 * Canada is a fair complaint about a globe.
 *
 * Asked only when the camera settles, and only when it has moved far enough to
 * possibly be somewhere else - Nominatim is a donated service and this is a
 * courtesy, not a rate limit to be tested.
 */

let lastPlaceAt = null;

async function updatePlace() {
  const c = scene.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(c.latitude);
  const lon = Cesium.Math.toDegrees(c.longitude);
  if (lastPlaceAt) {
    const moved = Math.abs(lat - lastPlaceAt[0]) + Math.abs(lon - lastPlaceAt[1]);
    if (moved < 0.2) return;
  }
  lastPlaceAt = [lat, lon];
  try {
    const { place } = await getJSON(`/api/place?lat=${lat.toFixed(1)}&lon=${lon.toFixed(1)}`);
    // Over open ocean there is no name, and inventing one would be worse.
    $('#place').textContent = place || 'open water';
    // And who runs it, which turns a coordinate into a country. Wikidata keeps
    // head of state and head of government apart, which matters in a monarchy.
    const country = (place || '').split(',').pop().trim();
    if (country) {
      try {
        const who = await getJSON(`/api/headofstate?country=${encodeURIComponent(country)}`);
        const line = [who.head_of_state, who.government]
          .filter((x, i, a) => x && a.indexOf(x) === i).join(' \u00b7 ');
        $('#place').title = line ? `${country}: ${line}` : country;
      } catch (_) { $('#place').title = country; }
    }
  } catch (_) {
    $('#place').textContent = '';
  }
}

viewer.camera.moveEnd.addEventListener(updatePlace);

/* -------------------------------------------------------------- the moon */

/*
 * Cesium has drawn the moon all along, in the right place, from Simon 1994's
 * ephemeris. It is simply 400 000 km away, so at any zoom that shows a country
 * it is far outside the frame - present and unseeable, which amounts to absent.
 *
 * What was missing was a way to stand far enough back to have both in shot, and
 * the two numbers that make it worth doing: how far away it is today, and how
 * much of it is lit.
 */

/** Moon position in the frame the camera lives in, not the inertial one. */
function moonFixedPosition(when) {
  const inertial = Cesium.Simon1994PlanetaryPositions
    .computeMoonPositionInEarthInertialFrame(when);
  // ICRF needs its data loaded and quietly returns undefined until it is; the
  // pseudo-fixed matrix is the standard fallback and is close enough to point a
  // camera with.
  const toFixed = Cesium.Transforms.computeIcrfToFixedMatrix(when)
    || Cesium.Transforms.computeTemeToPseudoFixedMatrix(when);
  return Cesium.Matrix3.multiplyByVector(toFixed, inertial, new Cesium.Cartesian3());
}

const MOON_PHASES = [
  'new', 'waxing crescent', 'first quarter', 'waxing gibbous',
  'full', 'waning gibbous', 'last quarter', 'waning crescent',
];

function moonState() {
  const now = Cesium.JulianDate.now();
  const moon = Cesium.Simon1994PlanetaryPositions
    .computeMoonPositionInEarthInertialFrame(now);
  const sun = Cesium.Simon1994PlanetaryPositions
    .computeSunPositionInEarthInertialFrame(now);

  // Elongation is the sun-earth-moon angle. Opposite the sun is full, in line
  // with it is new, and the lit fraction follows from the cosine.
  const elongation = Cesium.Cartesian3.angleBetween(moon, sun);
  const lit = (1 - Math.cos(elongation)) / 2;

  // Waxing or waning cannot be read from one instant, so ask again an hour on.
  const later = Cesium.JulianDate.addHours(now, 1, new Cesium.JulianDate());
  const moonLater = Cesium.Simon1994PlanetaryPositions
    .computeMoonPositionInEarthInertialFrame(later);
  const sunLater = Cesium.Simon1994PlanetaryPositions
    .computeSunPositionInEarthInertialFrame(later);
  const litLater = (1 - Math.cos(
    Cesium.Cartesian3.angleBetween(moonLater, sunLater))) / 2;
  const waxing = litLater > lit;

  // Eight names over a cycle, chosen by lit fraction and direction.
  let phase;
  if (lit < 0.04) phase = MOON_PHASES[0];
  else if (lit > 0.96) phase = MOON_PHASES[4];
  else if (Math.abs(lit - 0.5) < 0.06) phase = waxing ? MOON_PHASES[2] : MOON_PHASES[6];
  else if (lit < 0.5) phase = waxing ? MOON_PHASES[1] : MOON_PHASES[7];
  else phase = waxing ? MOON_PHASES[3] : MOON_PHASES[5];

  return {
    km: Cesium.Cartesian3.magnitude(moon) / 1000,
    lit,
    phase,
    // Perigee is about 363 000 km and apogee about 405 000, so say which end.
    extreme: Cesium.Cartesian3.magnitude(moon) / 1000 > 400000 ? 'near apogee'
      : Cesium.Cartesian3.magnitude(moon) / 1000 < 368000 ? 'near perigee' : '',
  };
}

/**
 * Frame the earth and the moon together.
 *
 * A bounding sphere around the midpoint of the two, and Cesium works out how
 * far back that has to be - which is about 350 000 km, and is why this cannot
 * just be another Jump-to height.
 */
function viewTheMoon() {
  const now = Cesium.JulianDate.now();
  const moon = moonFixedPosition(now);
  const midpoint = Cesium.Cartesian3.multiplyByScalar(
    moon, 0.5, new Cesium.Cartesian3()
  );
  const radius = Cesium.Cartesian3.magnitude(moon) * 0.62;
  // Google's 3D view is of the Earth and has nowhere to put the moon, so
  // photoreal steps aside rather than have the button appear to do nothing.
  if (map3d && !$('#map3d').hidden) {
    $('#photoreal').checked = false;
    showPhotoreal(false);
    log('photoreal 3D off · the moon is not somewhere it can go');
  }
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(midpoint, radius), {
    duration: 4,
  });
  const m = moonState();
  log(`moon: ${Math.round(m.km).toLocaleString('en-GB')} km, ${m.phase}, `
    + `${Math.round(m.lit * 100)}% lit${m.extreme ? ' \u00b7 ' + m.extreme : ''}`);
  $('#moon-readout').textContent =
    `MOON ${Math.round(m.km / 1000)}k km \u00b7 ${m.phase} \u00b7 ${Math.round(m.lit * 100)}%`;
}

function updateMoonReadout() {
  const m = moonState();
  $('#moon-readout').textContent =
    `MOON ${Math.round(m.km / 1000)}k km \u00b7 ${m.phase} \u00b7 ${Math.round(m.lit * 100)}%`;
}

setInterval(updateMoonReadout, 600_000);

/* ------------------------------------------------------------ view angle */

/*
 * Everything arrived looking straight down, because a flyTo given only a
 * destination defaults to nadir - so every jump quietly flattened whatever angle
 * had been set by hand. Cesium's tilt was never disabled: middle-drag, or
 * ctrl with left-drag, has always worked. It was the flights undoing it.
 *
 * A map is read from directly above. A place is looked at from an angle, because
 * that is where the terrain and the buildings have shape. So the angle is now a
 * setting the flights respect, and it is remembered.
 */

let viewPitch = Number(localStorage.getItem('gcv-pitch'));
if (!Number.isFinite(viewPitch) || viewPitch > -12 || viewPitch < -90) viewPitch = -40;

/** The orientation every flight should arrive at, keeping the present heading. */
function flightOrientation() {
  return {
    heading: viewer.camera.heading,
    pitch: Cesium.Math.toRadians(viewPitch),
    roll: 0,
  };
}

/**
 * Re-aim at whatever is in the middle of the screen, from the new angle.
 *
 * Pivoting around the camera would swing the view off the subject; pivoting
 * around the ground point keeps it centred, which is what a tilt control is
 * expected to do. lookAt sets a reference frame, so it has to be released
 * afterwards or every later camera move would be relative to that spot.
 */
function applyTilt() {
  const middle = new Cesium.Cartesian2(
    scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2
  );
  const target = surfacePoint(middle);
  if (!target) return;
  const range = Cesium.Cartesian3.distance(scene.camera.positionWC, target);
  scene.camera.lookAt(
    target,
    new Cesium.HeadingPitchRange(scene.camera.heading,
      Cesium.Math.toRadians(viewPitch), range)
  );
  scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  carryCameraInto3D();
}

$('#tilt').oninput = (e) => {
  viewPitch = Number(e.target.value);
  localStorage.setItem('gcv-pitch', String(viewPitch));
  $('#tilt-out').textContent = viewPitch <= -89 ? 'straight down'
    : `${Math.abs(viewPitch)}\u00b0`;
  applyTilt();
};

/* --------------------------------------------------------------- meters */

/*
 * "How far am I from paying" deserves a straighter answer than a line of small
 * text under a switch. Two meters, what remains rather than what is spent, and
 * one sentence each on what actually consumes them - because the surprising part
 * is not the number, it is that a photoreal *session* is one request no matter
 * how far you fly, while a Street View *view* is one request each.
 *
 * Both counts are this app's own tally since counting began, which is why the
 * console is linked underneath. That link is the authority; this is the warning
 * light.
 */

const METERS = [
  {
    key: 'google_root',
    limitKey: 'free_limit',
    name: 'Photoreal 3D',
    what: 'counted once each time the 3D view is opened. Google bill this under Photorealistic 3D Maps in the Maps JavaScript API, and I have not verified what that SKU gives away free — the console below is the authority, not this bar.',
  },
  {
    key: 'streetview',
    limitKey: 'streetview_limit',
    name: 'Street View',
    what: 'one per panorama you arrive at. Turning, zooming and looking around inside one cost nothing, and somewhere with no coverage costs nothing.',
  },
];

async function renderMeters() {
  const host = $('#meters');
  if (!host) return;
  // A free allowance for something Google will not serve is not information.
  const meters = METERS.filter((m) => !(photorealRefused && m.key === 'google_root'));
  if (!googleKey) {
    host.innerHTML = '<p class="meter-what">No Google key set, so nothing here '
      + 'can be billed. SETUP has the steps.</p>';
    return;
  }
  let usage;
  try {
    usage = await getJSON('/api/usage');
  } catch (_) {
    return;
  }

  host.innerHTML = '';
  for (const meter of meters) {
    const used = usage[meter.key] || 0;
    const limit = usage[meter.limitKey] || 0;
    if (!limit) continue;
    const left = Math.max(0, limit - used);
    const share = Math.min(1, used / limit);

    const wrap = document.createElement('div');
    wrap.className = 'meter'
      + (used >= limit ? ' over' : used >= limit * 0.8 ? ' near' : '');
    wrap.innerHTML =
      `<div class="meter-head"><span>${meter.name}</span>`
      + `<span class="meter-left">${left.toLocaleString('en-GB')} free left</span></div>`
      + `<div class="meter-bar"><div class="meter-fill" style="width:${(share * 100).toFixed(1)}%"></div></div>`
      + `<div class="meter-what">${used.toLocaleString('en-GB')} of `
      + `${limit.toLocaleString('en-GB')} used in ${usage.month} \u00b7 ${meter.what}</div>`;
    host.append(wrap);
  }

  const note = document.createElement('p');
  note.className = 'meter-what';
  note.textContent = 'Resets on the 1st at midnight Pacific. Counted by this app '
    + `since ${usage.since}, so anything else using the same key is invisible here.`;
  host.append(note);
}

/* ------------------------------------------------------------- handover */

/*
 * NASA's false colour stops at zoom 9. Below that the pixels only get bigger,
 * which is no use if the point of descending was to look at buildings. So
 * crossing the ceiling hands the globe to the sharper mosaic, and climbing back
 * out returns it.
 *
 * This is the same automatic optic-switching that was just removed for being
 * disorienting, and it is defensible here for one reason: the operator caused it
 * by zooming, and the log says which ceiling was crossed. An optic that changed
 * because a *list item* was clicked had no such excuse.
 *
 * Two heights, not one, or the camera would flip back and forth across a single
 * threshold for as long as it hovered there.
 */

/*
 * Measured on a 1280-wide canvas rather than guessed. NASA's 300 m pixel is
 * displayed one-for-one at about 340 km; at 700 km it is *downsampled* to 0.5x,
 * so the first threshold threw away detail that was still there - and worse, it
 * sat above the 250 km a fire is flown to, so the infrared was handed away the
 * instant it was switched on.
 *
 * Handing over at 140 km means accepting a little over 2x enlargement first,
 * which still reads as a scar. Past that it is mush.
 */
const HANDOVER_DOWN_M = 140_000;
const HANDOVER_UP_M = 280_000;
let handedOver = false;
let handedFrom = '';   // which NASA optic to give back when climbing out

function checkHandover() {
  if (!$('#handover').checked) return;
  const height = scene.camera.positionCartographic.height;

  if (!handedOver && IMAGERY[currentStyle].gibs && height < HANDOVER_DOWN_M) {
    handedOver = true;
    handedFrom = currentStyle;
    // In safe mode the descent goes to Sentinel-2 rather than Esri: 10 m and
    // CC BY 4.0 instead of 30 cm and terms nobody can be sure of. It used to
    // refuse to descend at all, which was correct only while there was nothing
    // clear to descend to.
    selectStyle(safeMode ? 's2' : 'satellite', true);
    renderLegend();
    log(`handover: below ${HANDOVER_DOWN_M / 1000} km, NASA is enlarging past `
        + '2x \u2014 switched to the sharper mosaic. The scar is not visible here.');
    return;
  }

  if (handedOver && height > HANDOVER_UP_M) {
    handedOver = false;
    // Only take it back if nothing else was chosen in the meantime.
    if (currentStyle === 'satellite' || currentStyle === 's2') {
      selectStyle(handedFrom || 'burn', true);
      log('handover: back above the ceiling, false colour returned');
    }
  }
}

viewer.camera.moveEnd.addEventListener(checkHandover);

/* --------------------------------------------------------- imagery in time */

/*
 * GIBS is date-addressed, so stepping the day is nearly free: the same tiles
 * from a different morning. That turns a brown patch into a sequence - here is
 * the scar now, here it is five days ago, here is the day it started - which is
 * the difference between a coordinate and something worth narrating.
 *
 * Only the NASA-backed optics move in time. Esri's mosaic has no date to ask
 * for, so the slider is disabled for the styles that use it, rather than
 * silently doing nothing.
 */

/*
 * False colour needs a key or it is just an odd-looking map. Green being
 * vegetation and rust being burnt ground is not guessable, and the first
 * reaction to the layer without this was reasonably "it is all green".
 */
const IR_LEGEND = [
  ['#3fd41f', 'live vegetation'],
  ['#8a4b2a', 'burnt ground'],
  ['#e8532e', 'active fire'],
  ['#0a0f14', 'water'],
  ['#dfe6ea', 'cloud and snow'],
];

// NASA publishes this band combination to zoom level 9 and no further. Past
// that it is the same pixels enlarged, which looks like a fault unless it says
// so - and it is the price of imagery nobody has to license.
const IR_FLOOR = 'NASA caps this at 300 m/pixel \u2014 one-for-one at about '
  + '340 km, enlarged below that';

function renderLegend() {
  const box = $('#legend');
  box.innerHTML = '';

  // Handing over to the sharper mosaic used to take the key away with it and
  // say nothing, which reads as the legend breaking. The box stays; it just
  // explains where the false colour went and how to get it back.
  if (handedOver && currentStyle === 'satellite') {
    const note = document.createElement('span');
    note.className = 'floor';
    note.textContent = 'below the NASA ceiling \u2014 handed over to sharper '
      + 'imagery, so no false colour here. Climb above 280 km for the scar.';
    box.append(note);
    box.hidden = false;
    return;
  }

  if (currentStyle === 'smoke') {
    const note = document.createElement('span');
    note.className = 'floor';
    note.textContent = 'true colour, as an eye would see it \u2014 smoke is the '
      + 'grey-brown haze, and it hides the ground it drifts over. FIRE IR sees '
      + 'through it to the burn scar.';
    box.append(note);
    box.hidden = false;
    return;
  }

  if (currentStyle === 's2') {
    const note = document.createElement('span');
    note.className = 'floor';
    note.textContent = 'Sentinel-2 at 10 m, composited cloud-free over a year '
      + '\u2014 a basemap, not today. No clouds, no smoke, no ships. For what is '
      + 'happening now use SMOKE or FIRE IR.';
    box.append(note);
    box.hidden = false;
    return;
  }

  if (currentStyle !== 'burn') {
    box.hidden = true;
    return;
  }

  for (const [colour, what] of IR_LEGEND) {
    const row = document.createElement('span');
    row.innerHTML = `<i style="background:${colour}"></i>${what}`;
    box.append(row);
  }
  const floor = document.createElement('span');
  floor.className = 'floor';
  floor.textContent = IR_FLOOR;
  box.append(floor);
  box.hidden = false;
}

function styleIsDated(key) {
  return !!IMAGERY[key].gibs || !!IMAGERY[key].cdse || safeMode;
}

function rebuildImagery() {
  // removeAll destroys every layer, the label overlay included, leaving the
  // reference to it pointing at something Cesium has thrown away. So the labels
  // are rebuilt on top afterwards - otherwise changing optic silently loses the
  // names, which is the one thing that layer exists to prevent.
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.add(makeImageryLayer(currentStyle));
  labelLayer = null;
  // The overlays were removed with everything else. They go back on before the
  // labels, so the place names stay readable on top of them.
  operaLayers.clear();
  if (typeof refreshOpera === 'function') refreshOpera();
  // removeAll() took the traffic tiles with it and left trafficLayer pointing
  // at something no longer in the scene, so show = true did nothing.
  trafficLayer = null;
  if (typeof showTraffic === 'function') showTraffic(
    (LAYERS.find((l) => l.id === 'traffic') || {}).on);
  if (typeof showNames === 'function') {
    const wanted = LAYERS.find((l) => l.id === 'names');
    showNames(!!wanted && wanted.on);
  }
}

function setDayOffset(days) {
  dayOffset = days;
  const out = $('#dayback-out');
  out.textContent = days === 0 ? 'today' : `-${days} day${days === 1 ? '' : 's'}`;
  const dated = styleIsDated(currentStyle);
  $('#dayback').disabled = !dated;
  if (!dated) {
    out.textContent = 'not dated';
    return;
  }
  rebuildImagery();
  out.textContent = days === 0 ? 'today · loading'
    : `-${days} day${days === 1 ? '' : 's'} · loading`;
  // The globe reports when it has caught up, so a slow day looks like waiting
  // rather than like nothing having happened.
  const done = scene.globe.tileLoadProgressEvent.addEventListener((queued) => {
    if (queued > 0) return;
    done();
    out.textContent = days === 0 ? 'today' : `-${days} day${days === 1 ? '' : 's'}`;
  });
  log(`imagery: ${gibsDay()}${days ? ` (${days} day${days === 1 ? '' : 's'} back)` : ''}`);
}

/*
 * The label follows the drag; the imagery waits for it to stop.
 *
 * oninput fires for every pixel of travel, and each one was tearing the layer
 * down and building it again - so dragging across a week rebuilt it thirty times
 * and no single date ever had long enough to load. The screen sat unchanged,
 * which reads exactly like a slider that does nothing.
 */
$('#dayback').oninput = (e) => {
  const days = Number(e.target.value);
  $('#dayback-out').textContent = days === 0 ? 'today'
    : `-${days} day${days === 1 ? '' : 's'}`;
};

$('#dayback').onchange = (e) => setDayOffset(Number(e.target.value));

/**
 * Put the right lens on the subject. A fire seen in true colour is cloud; a
 * fire seen in short-wave infrared is a scar, which is the thing being talked
 * about. Quakes and aircraft have nothing infrared to show, so they get the
 * plain satellite view back.
 */
function opticsForEvent(kind) {
  if (!$('#autooptics').checked) return;
  // Only ever switch *to* the infrared, never away from it. Switching back on
  // every quake and aircraft meant the optic vanished the moment you looked at
  // anything else - which reads, correctly, as the colours breaking. Choosing an
  // optic is the operator's business; suggesting one for a fire is ours.
  if (kind !== 'fire' || currentStyle === 'burn') return;
  selectStyle('burn');
}

/* ---------------------------------------------------------- presentation */

/*
 * Two separate things, deliberately, because they are useful apart.
 *
 * PRESENT hides the operator's half of the screen and leaves a title and a
 * lower third. TOUR flies the briefing on a timer and writes the caption. Run
 * the tour with the panel visible while you line up a shot; run PRESENT alone
 * and fly by hand while you narrate.
 *
 * The tour reloads the briefing every few minutes, so a stream left running
 * overnight is showing tonight's fires rather than the ones it started on.
 */

const TOUR_HOLD_MS = 22_000;      // long enough to talk over a shot
const TOUR_FLIGHT_S = 6;          // slow: fast camera moves look like a game
const TOUR_REFRESH_MS = 8 * 60_000;

let touring = false;
let tourTimer = null;
let tourRefresh = null;
let tourIndex = 0;

function setStage(event) {
  const lower = $('#stage-lower');
  if (!event) {
    lower.className = '';
    $('#stage-kind').textContent = '';
    $('#stage-head').textContent = '';
    $('#stage-why').textContent = '';
    $('#stage-mark').textContent = '';
    return;
  }
  lower.className = event.kind;
  $('#stage-kind').textContent = {
    fire: 'ACTIVE FIRE \u00b7 NASA FIRMS',
    quake: 'SEISMIC \u00b7 USGS',
    military: 'STATE AIRCRAFT \u00b7 ADS-B',
    cyclone: 'TROPICAL CYCLONE \u00b7 GDACS',
    flood: 'FLOOD \u00b7 GDACS',
    volcano: 'VOLCANIC ACTIVITY \u00b7 GDACS',
    drought: 'DROUGHT \u00b7 GDACS',
    outbreak: 'DISEASE OUTBREAK \u00b7 WHO',
  }[event.kind] || event.kind.toUpperCase();
  $('#stage-head').textContent = event.place
    ? `${event.headline}  \u00b7  ${event.place}`
    : event.headline;
  const reported = reportedLine(event.reported);
  const when = whenLine(event);
  $('#stage-why').textContent = [when, event.why, reported]
    .filter(Boolean).join('  —  ');
  lower.classList.toggle('unlisted',
    !!event.reported && event.reported.state === 'none');
  // The source on screen, so the footage carries its own attribution.
  $('#stage-mark').textContent = `${event.source}\n${event.lat.toFixed(2)}, ${event.lon.toFixed(2)}`;
}

function flyToEvent(event) {
  opticsForEvent(event.kind);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(event.lon, event.lat, event.altitude),
    orientation: flightOrientation(),
    duration: TOUR_FLIGHT_S,
    complete: carryCameraInto3D,
  });
  if (event.kind === 'fire') {
    setTimeout(() => { firesAsked = ''; loadFires(); }, TOUR_FLIGHT_S * 1000 + 400);
  }
  if (event.kind === 'military') {
    setTimeout(pollFlights, TOUR_FLIGHT_S * 1000 + 400);
  }
}

function tourStep() {
  const events = briefEvents;
  if (!events.length) return;
  const event = events[tourIndex % events.length];
  tourIndex += 1;
  flyToEvent(event);
  setStage(event);
}

function setTouring(on) {
  touring = on;
  $('#tour').checked = on;
  clearInterval(tourTimer);
  clearInterval(tourRefresh);
  if (!on) {
    setStage(null);
    log('tour stopped');
    return;
  }
  // A stream left running should not be reciting this morning's news tonight.
  tourRefresh = setInterval(loadBriefing, TOUR_REFRESH_MS);
  tourStep();
  tourTimer = setInterval(tourStep, TOUR_HOLD_MS);
  log(`tour running \u00b7 ${briefEvents.length} events, ${TOUR_HOLD_MS / 1000}s each`);
}

function setPresenting(on) {
  document.body.classList.toggle('presenting', on);
  $('#stage').hidden = !on;
  $('#present').classList.toggle('active', on);
  $('#present').textContent = on ? 'PRESENTING \u00b7 P OR ESC TO EXIT'
                                : 'PRESENT \u00b7 HIDE THE PANEL';
  // Cesium sizes itself to its container, which just changed.
  requestAnimationFrame(() => viewer.resize());
}

$('#present').onclick = () => setPresenting(!document.body.classList.contains('presenting'));
$('#tour').onchange = (e) => setTouring(e.target.checked);

window.addEventListener('keydown', (e) => {
  // Not while typing a mark name.
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'p' || e.key === 'P') {
    setPresenting(!document.body.classList.contains('presenting'));
  } else if (e.key === 'Escape' && document.body.classList.contains('presenting')) {
    setPresenting(false);
  }
});

/* -------------------------------------------------------------- briefing */

/*
 * Finding the story is the hard part, not flying to it. This asks the server
 * what is happening right now and lists it: fire fronts ranked by total
 * radiative power rather than by any one hot pixel, earthquakes by magnitude,
 * military contacts by altitude. Clicking a line flies there.
 *
 * The list interleaves the kinds rather than merging them into one order,
 * because megawatts, magnitudes and feet do not compare. A single ranking would
 * be a comparison nobody made.
 *
 * Earthquakes are ranked by magnitude alone and not by how recent they are.
 * That was raised and decided rather than overlooked: the headline is regularly
 * a large quake several days old, which looks stale beside a fresh small one.
 * It stays, because the magnitude is the thing that matters about an earthquake
 * and weighting for freshness would push a M4 this morning above a M7 that
 * flattened somewhere on Tuesday. The card carries the time, so recency is one
 * glance away without the ranking pretending to know which you meant.
 */

/**
 * When it happened, both ways round.
 *
 * "M 7.7 off Indonesia" reads identically whether it struck an hour ago or last
 * Tuesday, and for anything news-shaped that is the difference between the story
 * and a history lesson. So every row carries elapsed time, which is what a
 * viewer feels, and the absolute stamp in UTC, which is what can be checked.
 *
 * Fires get the newest detection in the cluster rather than the oldest: the
 * question is whether it is still burning, not when it started.
 */
function whenLine(event) {
  const ms = event.kind === 'quake' ? event.at
    : event.newest_minutes ? event.newest_minutes * 60000
    : null;
  if (!ms) return event.kind === 'military' ? 'live now' : '';

  const stamp = new Date(ms);
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  const ago = mins < 60 ? `${mins} min ago`
    : mins < 2880 ? `${Math.round(mins / 60)} h ago`
    : `${Math.round(mins / 1440)} days ago`;
  const label = event.kind === 'fire' ? 'last seen' : '';
  return `${label ? label + ' ' : ''}${ago} \u00b7 ${stamp.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/**
 * One line saying what the alert system has on an event.
 *
 * The three states are meant to be read differently, and the wording works hard
 * to keep them apart. A match is reporting. A nearby entry may be the same fire
 * complex seen from its centroid, or may be a different fire entirely, so the
 * distance is always shown and the operator judges. A miss means nobody has
 * raised an *international* alert - which for GDACS is a threshold in hectares,
 * not a statement that the fire is undiscovered. Saying "nobody knows about
 * this" on air would be a lie, and an easy one to tell by accident.
 */
function reportedLine(reported) {
  if (!reported) return '';
  if (reported.state === 'none') return 'NO INTERNATIONAL ALERT';
  const bits = [reported.text];
  if (reported.level) bits.push(reported.level.toUpperCase());
  if (reported.severity) bits.push(reported.severity);
  if (reported.state === 'nearby') bits.push(`nearest alert, ${reported.km} km away`);
  else if (reported.km > 10) bits.push(`${reported.km} km`);
  return bits.join(' \u00b7 ');
}

const BRIEF_KINDS = {
  fire: 'FIRE', quake: 'QUAKE', military: 'MIL', cyclone: 'CYCLONE',
  flood: 'FLOOD', volcano: 'VOLCANO', drought: 'DROUGHT', outbreak: 'DISEASE',
};
let briefCount = 0;
let briefEvents = [];

async function loadBriefing() {
  const list = $('#brief-list');
  const when = $('#brief-when');
  when.textContent = 'reading…';
  let data;
  try {
    data = await getJSON('/api/briefing');
  } catch (err) {
    when.textContent = 'unavailable';
    log(`briefing unavailable (${err.message})`, 'warn');
    return;
  }

  list.innerHTML = '';
  briefEvents = data.events;
  for (const event of data.events) {
    const li = document.createElement('li');
    li.className = event.kind;
    const head = document.createElement('span');
    head.className = 'head';
    head.textContent = `${BRIEF_KINDS[event.kind] || event.kind} · ${event.headline}`;
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = event.why;
    li.append(head, why);
    if (event.place) {
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = event.place;
      li.append(where);
    }
    const when = whenLine(event);
    if (when) {
      const w = document.createElement('span');
      w.className = 'when';
      w.textContent = when;
      li.append(w);
    }
    const reported = reportedLine(event.reported);
    if (reported) {
      const rep = document.createElement('span');
      rep.className = 'reported' + (event.reported.state === 'none' ? ' unlisted' : '');
      rep.textContent = reported;
      li.append(rep);
    }
    if (event.news) {
      const news = document.createElement('a');
      news.className = 'news';
      news.href = event.news;
      news.target = '_blank';
      news.rel = 'noreferrer';
      news.textContent = 'SEARCH NEWS';
      // The row flies the camera; the link must not do both.
      news.onclick = (e) => e.stopPropagation();
      li.append(news);
    }
    li.onclick = () => {
      opticsForEvent(event.kind);
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(event.lon, event.lat, event.altitude),
        orientation: flightOrientation(),
        duration: 2.6,
        complete: carryCameraInto3D,
      });
      // The layers that would show it, on, so the jump lands on something.
      if (event.kind === 'fire') setTimeout(() => { firesAsked = ''; loadFires(); }, 2800);
      if (event.kind === 'military') setTimeout(pollFlights, 2800);
      log(`briefing: ${event.headline} · ${event.source}`);
      const reported = reportedLine(event.reported);
      if (reported) {
        log(event.reported.state === 'none'
          ? `reporting: none — ${event.reported.caveat}`
          : `reporting: ${reported}${event.reported.report ? ' · ' + event.reported.report : ''}`);
      }
    };
    list.append(li);
  }
  when.textContent = `${data.events.length} events · ${data.generated.slice(11, 16)}Z`;
  briefCount = data.events.length;
}

$('#brief-refresh').onclick = loadBriefing;

/* --------------------------------------------------------- street level */

/*
 * KartaView is the open street-level imagery set — Google's needs a paid key.
 * Coverage is wherever a volunteer has driven with a camera, so the photos are
 * loaded around wherever you are standing rather than globally.
 */

const streetShots = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
const streetIds = new Set();
const streetAsked = new Set();
let streetWanted = true;

function streetGlyph() {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(12, 1); g.lineTo(20, 20); g.lineTo(12, 15); g.lineTo(4, 20);
  g.closePath();
  g.fill();
  return c;
}
GLYPHS.street = streetGlyph();

async function loadStreetview(lat, lon) {
  if (!streetWanted) return;
  const cell = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (streetAsked.has(cell)) return;
  streetAsked.add(cell);
  try {
    const data = await getJSON(`/api/streetview?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
    let added = 0;
    for (const shot of data.shots) {
      if (streetIds.has(shot.id)) continue;
      streetIds.add(shot.id);
      streetShots.add({
        image: GLYPHS.street,
        position: Cesium.Cartesian3.fromDegrees(shot.lon, shot.lat, 2),
        scale: 0.55,
        color: Cesium.Color.fromCssColorString('#ffd166'),
        alignedAxis: Cesium.Cartesian3.ZERO,
        rotation: -Cesium.Math.toRadians(shot.heading),
        scaleByDistance: new Cesium.NearFarScalar(50, 1.2, 20_000, 0.3),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30_000),
        id: { type: 'street', ref: shot },
      });
      added++;
    }
    if (added) log(`street: +${added} photos at ${cell}`);
  } catch (err) {
    streetAsked.delete(cell);
    log(`street imagery unavailable (${err.message})`, 'warn');
  }
}

/* ------------------------------------------------------- standing viewpoint */

/*
 * Standing somewhere is a different camera model from orbiting a globe: the
 * position is pinned and the mouse turns your head, so the controls are taken
 * over while it lasts and handed back on Esc.
 */

const standing = { active: false, picking: false, heading: 0, pitch: 0, fov: 60, position: null, saved: null };

function armViewpoint() {
  standing.picking = !standing.picking;
  $('#globe').classList.toggle('picking', standing.picking);
  $('#standhere').classList.toggle('active', standing.picking);
  $('#standhere').textContent = standing.picking
    ? 'CLICK A SPOT ON THE MAP'
    : 'STAND HERE · PICK A SPOT';
}

/**
 * `cartographic` comes from surfacePoint, so its height is the surface that was
 * clicked. Terrain sampling is only the fallback for a pick that missed, and it
 * cannot see Google's mesh or a rooftop at all.
 */
async function standAt(cartographic, picked = false) {
  // The depth buffer shows terrain at the level of detail currently drawn, which
  // near the ground is coarser than the finest data: picking a hillside came out
  // some 2 m low, so the eye started half a metre underground and sank further
  // as the tile refined. Whichever surface is higher is the one to stand on —
  // and on a rooftop that is still the roof, since terrain beneath it is lower.
  const sampled = await groundHeight(cartographic);
  const ground = picked ? Math.max(cartographic.height, sampled) : sampled;
  standing.saved = {
    destination: Cesium.Cartesian3.clone(viewer.camera.positionWC),
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    fov: scene.camera.frustum.fov,
  };
  standing.active = true;
  standing.picking = false;
  standing.position = Cesium.Cartesian3.fromRadians(
    cartographic.longitude, cartographic.latitude, ground + 1.7 // eye height
  );
  standing.heading = viewer.camera.heading;
  standing.pitch = 0;
  standing.fov = Cesium.Math.toRadians(60);
  applyStanding();

  $('#globe').classList.remove('picking');
  $('#standhere').classList.remove('active');
  $('#standhere').textContent = 'STAND HERE · PICK A SPOT';
  $('#standing').hidden = false;
  const lat = Cesium.Math.toDegrees(cartographic.latitude);
  const lon = Cesium.Math.toDegrees(cartographic.longitude);
  $('#standing-where').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  scene.screenSpaceCameraController.enableInputs = false;
  log(`standing at ${lat.toFixed(4)}, ${lon.toFixed(4)} · arrows walk and turn`);
  loadStreetview(lat, lon);
  gsvLast = '';
  showStreetView();
  updateBuildings();
}

function applyStanding() {
  // The panorama follows where you are looking, in 45 degree steps.
  if (typeof showStreetView === 'function') showStreetView();
  scene.camera.frustum.fov = standing.fov;
  viewer.camera.setView({
    destination: standing.position,
    orientation: { heading: standing.heading, pitch: standing.pitch, roll: 0 },
  });
  // setView is immediate, so this is a plain call and not a callback.
  carryCameraInto3D();
  $('#standing-look').textContent =
    `HDG ${Math.round(Cesium.Math.toDegrees(standing.heading) + 360) % 360}° · ` +
    `FOV ${Math.round(Cesium.Math.toDegrees(standing.fov))}°`;
}

function leaveViewpoint() {
  if (!standing.active) return;
  standing.active = false;
  scene.camera.frustum.fov = standing.saved.fov;
  scene.screenSpaceCameraController.enableInputs = true;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(
      Cesium.Cartographic.fromCartesian(standing.position).longitude,
      Cesium.Cartographic.fromCartesian(standing.position).latitude,
      1500
    ),
    orientation: { heading: standing.heading, pitch: Cesium.Math.toRadians(-30) },
    duration: 1.6,
    complete: carryCameraInto3D,
  });
  $('#standing').hidden = true;
  // The panorama belongs to the spot you were standing on. showStreetView is the
  // single place that decides whether the panel is up, so ask it rather than
  // hiding the element here and having two answers to the same question.
  gsvLast = '';
  showStreetView();
}

// Mouse look while standing: drag turns the head, wheel is the zoom lens.
let looking = false;
let lookX = 0;
let lookY = 0;

scene.canvas.addEventListener('pointerdown', (e) => {
  if (!standing.active) return;
  looking = true;
  lookX = e.clientX;
  lookY = e.clientY;
});
scene.canvas.addEventListener('pointermove', (e) => {
  if (!standing.active || !looking) return;
  const scale = standing.fov / Cesium.Math.toRadians(60); // finer when zoomed in
  standing.heading += (e.clientX - lookX) * 0.004 * scale;
  standing.pitch = clamp(
    standing.pitch - (e.clientY - lookY) * 0.004 * scale,
    -Cesium.Math.PI_OVER_TWO * 0.95,
    Cesium.Math.PI_OVER_TWO * 0.95
  );
  lookX = e.clientX;
  lookY = e.clientY;
  applyStanding();
});
window.addEventListener('pointerup', () => { looking = false; });
scene.canvas.addEventListener('wheel', (e) => {
  if (!standing.active) return;
  e.preventDefault();
  standing.fov = clamp(
    standing.fov * (e.deltaY > 0 ? 1.12 : 1 / 1.12),
    Cesium.Math.toRadians(6),
    Cesium.Math.toRadians(90)
  );
  applyStanding();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && standing.active) leaveViewpoint();
  if (e.key === 'Escape' && ruler.on) toggleRuler();
});

function updateBuildings() {
  if (!buildingsWanted) return;
  const carto = viewer.camera.positionCartographic;
  if (carto.height > BUILDING_CEILING) return;
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return;
  const south = Math.floor(Cesium.Math.toDegrees(rect.south) / BUILDING_TILE);
  const north = Math.floor(Cesium.Math.toDegrees(rect.north) / BUILDING_TILE);
  const west = Math.floor(Cesium.Math.toDegrees(rect.west) / BUILDING_TILE);
  const east = Math.floor(Cesium.Math.toDegrees(rect.east) / BUILDING_TILE);
  // Nearest tiles first: what is under the crosshair should appear first.
  const centreY = Cesium.Math.toDegrees(carto.latitude) / BUILDING_TILE;
  const centreX = Cesium.Math.toDegrees(carto.longitude) / BUILDING_TILE;
  const wanted = [];
  for (let y = south; y <= north; y++) {
    for (let x = west; x <= east; x++) {
      if (!buildingTiles.has(`${y},${x}`)) {
        wanted.push({ y, x, d: (y - centreY) ** 2 + (x - centreX) ** 2 });
      }
    }
  }
  wanted.sort((a, b) => a.d - b.d);
  for (const tile of wanted.slice(0, 16)) loadBuildingTile(tile.y, tile.x);
}

/**
 * Where a screen point actually meets the world.
 *
 * pickEllipsoid answers with the smooth sea-level ball, which was fine while
 * the globe was a smooth sea-level ball. With terrain and photogrammetry it is
 * wrong twice over: the height comes back 0, and on a slope the point is not
 * even under the cursor — the ray keeps going until it reaches sea level, which
 * on a fjord wall lands a few hundred metres past what you clicked.
 *
 * pickPosition reads the depth buffer, so it lands on whatever is drawn there:
 * terrain, a roof, Google's mesh. It needs a rendered frame, so the older
 * methods stay as fallbacks in that order.
 */
function surfacePoint(windowPosition) {
  if (scene.pickPositionSupported) {
    const hit = scene.pickPosition(windowPosition);
    if (Cesium.defined(hit)) return hit;
  }
  if (scene.globe.show) {
    const ray = viewer.camera.getPickRay(windowPosition);
    const onTerrain = ray && scene.globe.pick(ray, scene);
    if (Cesium.defined(onTerrain)) return onTerrain;
  }
  return viewer.camera.pickEllipsoid(windowPosition, scene.globe.ellipsoid);
}

function dropToGround() {
  const centre = surfacePoint(
    new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2)
  );
  const target = centre
    ? Cesium.Cartographic.fromCartesian(centre)
    : viewer.camera.positionCartographic;

  // The pick already carries the height of the surface it hit. globe.getHeight
  // was asked for it before, and answers undefined whenever the tile under the
  // camera has not loaded yet — which, right after flying somewhere, is most of
  // the time. That put the descent 320 m above sea level, and 280 m inside the
  // hill if the hill was 600 m tall.
  const ground = centre ? target.height : 0;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(target.longitude, target.latitude,
      ground + 320),
    orientation: { heading: viewer.camera.heading, pitch: Cesium.Math.toRadians(-14), roll: 0 },
    duration: 2.5,
    complete: () => { updateBuildings(); carryCameraInto3D(); },
  });
  log(`descending to 320 m over ground at ${Math.round(ground)} m`);
}

/* ----------------------------------------------------------- HUD controls */

/*
 * Remembered, like the view angle and the safe-mode switch. Reloading used to
 * drop the optic back to OPS, which looked like the infrared layer and its key
 * had vanished of their own accord.
 */
let currentStyle = localStorage.getItem('gcv-style') || 'ops';
if (!IMAGERY[currentStyle]) currentStyle = 'ops';

/** Switch optics. Split out of the button so the tour can call it too. */
function selectStyle(key, byHandover) {
  if (key === currentStyle) return;
  // Picking an optic by hand ends the handover's claim on it. Keyed on who is
  // calling, not on a list of style names - that list broke the moment a third
  // handover target existed.
  if (!byHandover) {
    handedOver = false;
    handedFrom = '';
  }
  const spec = IMAGERY[key];
  currentStyle = key;
  showStyleWhat(key);
  // Turned on from too far out it draws nothing, and silence reads as broken.
  if (spec && spec.cdse && scene.camera.positionCartographic.height > CDSE_HINT_M) {
    log(`${spec.label.toLowerCase()}: too far out to draw · zoom in to about `
      + 'a county and it appears · held back because 10 m imagery shows '
      + 'nothing from here, and every tile spends a request', 'warn');
  }
  localStorage.setItem('gcv-style', key);
  rebuildImagery();
  $('#globe').classList.toggle('heat', !!spec.heat);
  setCrt(spec.crt);
  setScope(spec.scope);
  renderStyles();
  renderLegend();
  ringFires();
  // The slider means nothing on an undated mosaic; say so rather than lie.
  const out = $('#dayback-out');
  const dated = styleIsDated(key);
  $('#dayback').disabled = !dated;
  if (!dated) out.textContent = 'not dated';
  else out.textContent = dayOffset === 0 ? 'today' : `-${dayOffset} days`;
  log(`optics: ${spec.label}`);
}

/*
 * An optic is a claim about what you are looking at, and half of these are not
 * what they sound like: THERMAL and FLIR are treatments of ordinary daylight
 * imagery with nothing warm in them, and SENTINEL 10M is a year averaged into a
 * basemap rather than a day. Someone choosing between them cannot know that
 * from a nine-character label, so the choice explains itself once made.
 */
function showStyleWhat(key) {
  const note = $('#style-what');
  if (!note) return;
  const spec = IMAGERY[key] || {};
  note.textContent = spec.what || '';
  note.hidden = !spec.what;
}

function renderStyles() {
  const box = $('#styles');
  box.innerHTML = '';
  for (const [key, spec] of Object.entries(IMAGERY)) {
    const b = document.createElement('button');
    b.className = 'chip' + (key === currentStyle ? ' active' : '');
    b.textContent = spec.label;
    // The chip alone says SWIR or NDVI, which means nothing to anyone who does
    // not already know. The title is for a passing hover; the line under the
    // row is for whoever actually picked one.
    if (spec.what) b.title = spec.what;
    b.onclick = () => selectStyle(key);
    box.append(b);
  }
  showStyleWhat(currentStyle);
}

/* -------------------------------------------------------------------- find */

/*
 * One box for "take me there", whatever form the destination arrives in: a
 * coordinate off a kneeboard, an ICAO code, an airport name, a town.
 *
 * The server decides which of those it is and says so in the answer, and that
 * distinction is printed rather than swallowed. A coordinate was read; a name
 * was looked up in somebody else\'s gazetteer and might be the wrong Springfield.
 * Those are different kinds of answer and the difference belongs on screen.
 */

/*
 * Push wherever the Cesium camera is now into Google's 3D view.
 *
 * While photoreal is on, the globe underneath is hidden. Anything that moves the
 * Cesium camera - the search box, a Jump to preset, a mark - therefore moved a
 * camera nobody could see, and the screen sat still while the app insisted it
 * had flown somewhere. Reported as "I put in coordinates and now I cannot go to
 * globe or palm", which is exactly what that looks like from the outside.
 *
 * Anything that moves the camera calls this afterwards. When 3D is off it costs
 * one comparison and returns.
 */
function carryCameraInto3D() {
  if (!map3d || $('#map3d').hidden) return;
  const target = cameraTarget();
  const at = Cesium.Cartographic.fromCartesian(target);
  map3d.center = {
    lat: Cesium.Math.toDegrees(at.latitude),
    lng: Cesium.Math.toDegrees(at.longitude),
    altitude: at.height || 0,
  };
  map3d.range = Math.max(120,
    Cesium.Cartesian3.distance(viewer.camera.position, target));
  map3d.tilt = Math.min(89, Math.max(0,
    90 + Cesium.Math.toDegrees(viewer.camera.pitch)));
  map3d.heading = (Cesium.Math.toDegrees(viewer.camera.heading) + 360) % 360;
  mirrorLayers();
}

async function flyToQuery(text) {
  const said = $('#find-said');
  const query = (text || '').trim();
  if (!query) return;

  said.hidden = false;
  said.className = 'note';
  said.textContent = 'looking\u2026';

  let found;
  try {
    found = await getJSON('/api/search?q=' + encodeURIComponent(query));
  } catch (err) {
    said.className = 'note miss';
    said.textContent = `could not look that up (${err.message})`;
    return;
  }
  if (found.error) {
    said.className = 'note miss';
    said.textContent = `nothing found. Tried ${found.tried || 'everything'}.`;
    log(`find: nothing matched "${query}"`, 'warn');
    return;
  }

  const how = found.kind === 'coordinates'
    ? 'read as a position'
    : found.kind === 'airport' ? 'airport code or name' : 'geocoded name';
  said.innerHTML = `<b>${found.label}</b> \u00b7 ${how}`
    + (found.detail ? `<br>${found.detail}` : '')
    + (found.others ? `<br>${found.others} other match(es) not shown` : '');

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(found.lon, found.lat, found.height || 20000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
    duration: 2.2,
    // The globe is hidden while photoreal is on, so the flight has to be handed
    // over at the end or nothing visible happens at all.
    complete: carryCameraInto3D,
  });
  log(`find: ${found.label} · ${how} · `
    + `${found.lat.toFixed(4)}, ${found.lon.toFixed(4)}`);
}

$('#find').onsubmit = (e) => {
  e.preventDefault();
  flyToQuery($('#find-q').value);
};

const PLACES = [
  { name: 'GLOBE', lon: 12, lat: 30, height: 24_000_000 },
  { name: 'PALM', lon: 55.14, lat: 25.11, height: 9_000 },
  // Close enough that the radar and ground-change layers actually draw, which
  // is where they were being tested from and kept being flown to by hand.
  { name: 'STOCKHOLM', lon: 18.07, lat: 59.33, height: 40_000 },
  { name: 'GOTHENBURG', lon: 11.97, lat: 57.71, height: 40_000 },
  { name: 'GULF OF FINLAND', lon: 24.9, lat: 59.8, height: 260_000 },
  { name: 'LONDON', lon: -0.1, lat: 51.5, height: 90_000 },
  { name: 'ENGLISH CHANNEL', lon: 1.4, lat: 50.6, height: 400_000 },
  { name: 'SUEZ', lon: 32.4, lat: 30.2, height: 220_000 },
  { name: 'ATLANTIC CABLES', lon: -30, lat: 45, height: 6_000_000 },
];

function renderPlaces() {
  const box = $('#places');
  // The moon is not a place at a height; it needs the camera 350 000 km back,
  // so it gets its own chip rather than an entry in the table above.
  const moonChip = document.createElement('button');
  moonChip.className = 'chip';
  moonChip.textContent = 'MOON';
  moonChip.onclick = viewTheMoon;
  box.append(moonChip);
  for (const place of PLACES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = place.name;
    b.onclick = () => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(place.lon, place.lat, place.height),
        // GLOBE is the one view that wants to be a map, not a place.
        orientation: place.height > 5_000_000
          ? { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 }
          : flightOrientation(),
        duration: 2.2,
        // Hand the flight over to Google's view when photoreal is on, or the
        // preset moves a camera hidden behind it and the screen sits still.
        complete: carryCameraInto3D,
      });
      setTimeout(pollFlights, 2600);
    };
    box.append(b);
  }
}

$('#lighting').onchange = (e) => { scene.globe.enableLighting = e.target.checked; };
$('#grain').onchange = (e) => { $('#scanlines').classList.toggle('off', !e.target.checked); };

$('#detect').onclick = (e) => {
  detection.on = !detection.on;
  e.target.classList.toggle('active', detection.on);
  e.target.textContent = detection.on ? 'DETECTION ON' : 'DETECTION OFF';
  updateDetection();
  log(`detection ${detection.on ? 'engaged' : 'standby'}`);
};

$('#density').oninput = (e) => {
  detection.density = Number(e.target.value);
  $('#density-out').textContent = detection.density;
  updateDetection();
};

$('#ground').onclick = dropToGround;
$('#standhere').onclick = armViewpoint;
$('#streetview').onchange = (e) => {
  streetWanted = e.target.checked;
  streetShots.show = streetWanted;
  if (streetWanted) updateStreetview();
};

$('#buildings').onchange = (e) => {
  if (ionBuildings) {
    ionBuildings.show = e.target.checked && !$('#photoreal').checked;
    return;
  }
  buildingsWanted = e.target.checked;
  for (const primitive of buildingTiles.values()) {
    if (primitive) primitive.show = buildingsWanted;
  }
  if (buildingsWanted) updateBuildings();
};

// Street level needs the camera to get properly low, and without terrain there
// is nothing for it to collide with.
scene.screenSpaceCameraController.minimumZoomDistance = 1.5;
scene.screenSpaceCameraController.enableCollisionDetection = false;
scene.camera.moveEnd.addEventListener(updateBuildings);
scene.camera.moveEnd.addEventListener(loadCamerasNearby);
scene.camera.moveEnd.addEventListener(() => pollVessels());
scene.camera.moveEnd.addEventListener(updateStreetview);
scene.camera.moveEnd.addEventListener(updateImageryDate);

/*
 * The basemap is a mosaic of scenes flown years apart. Two carriers at a pier
 * may be two carriers that were there in 2025, so the age of the picture belongs
 * on screen next to the live layers rather than buried in a provider's metadata.
 */
let imageryCell = '';

async function updateImageryDate() {
  const carto = viewer.camera.positionCartographic;
  if (carto.height > 600_000) {
    $('#imagery').textContent = 'IMG ----';
    imageryCell = '';
    return;
  }
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const cell = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (cell === imageryCell) return;
  imageryCell = cell;

  try {
    const meta = await getJSON(`/api/imagery-date?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    if (imageryCell !== cell) return;
    if (!meta.date) {
      $('#imagery').textContent = 'IMG undated';
      return;
    }
    // Esri sends M/D/YYYY. Going through toISOString() would shift the date a
    // day backwards for anyone east of Greenwich, so format it by hand.
    const [m, d, y] = meta.date.split('/').map(Number);
    const when = new Date(Date.UTC(y, m - 1, d));
    const stamp = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const years = (Date.now() - when.getTime()) / 31_557_600_000;
    const res = meta.resolution_m ? ` · ${Math.round(meta.resolution_m * 100)} cm` : '';
    $('#imagery').textContent = `IMG ${stamp}${res}`;
    $('#imagery').classList.toggle('stale', years > 2);
    $('#imagery').title = `${meta.source || 'imagery'} \u00b7 ${years.toFixed(1)} years old`;
  } catch (err) {
    $('#imagery').textContent = 'IMG ----';
  }
}

function updateStreetview() {
  const carto = viewer.camera.positionCartographic;
  if (carto.height > 4000) return; // street photos only matter close in
  loadStreetview(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
}

/* -------------------------------------------------------- help and setup */



/*
 * Everything the app can do is reachable without reading anything, but sharing
 * it with someone else means explaining it once, properly — and giving them a
 * place to paste the keys rather than a text editor and a file path.
 */

const SERVICES = [
  {
    fields: ['cesium_ion'],
    name: 'Cesium ion',
    tier: 1,
    cost: 'free',
    adds: 'World terrain and worldwide 3D buildings — real hills, real skylines, and camera projections that drape over them instead of lying flat. The nearest thing to photorealistic ground without paying Google.',
    url: 'https://cesium.com/ion/signup',
    steps: [
      'Sign up at cesium.com/ion/signup. The <b>Community</b> tier is free for personal, non-commercial use — email address, no card.',
      'Open <b>Access Tokens</b> in the ion dashboard and copy the default token.',
      'Paste it below, then reload the page.',
      'Terrain and buildings come on by themselves; the <b>World terrain</b> switch under Descent turns terrain off again if you want the flat globe back.',
    ],
  },
  {
    fields: ['google_maps'],
    name: 'Google Maps Platform',
    tier: 4,
    cost: 'billed',
    adds: 'Photorealistic 3D — the measured, textured mesh of some 2500 cities, with roofs, trees and shadows instead of grey boxes. Also Street View: an actual photograph taken from the spot you are standing on, on most roads on earth.',
    url: 'https://console.cloud.google.com/google/maps-apis/start',
    steps: [
      'Open the Google Cloud console and make a project. A card is required even on the free tier; Google will not charge it without you switching off the spending cap.',
      'Under <b>APIs &amp; Services → Library</b> enable <b>Maps JavaScript API</b> for the walkable Street View panorama, and <b>Map Tiles API</b> for the 3D mesh where it is served. Do this even if you ticked <i>enable all Google Maps APIs</i> at signup — that box covers neither, and without it the switches fail.',
      'Under <b>Credentials</b> create an <b>API key</b>. Restrict it: <i>Application restrictions → Websites</i>, allow <b>both</b> <code>http://127.0.0.1:8820/*</code> and <code>http://localhost:8820/*</code> — Google counts them as different sites and the app opens itself on the first — and <i>API restrictions → Map Tiles API</i>. An unrestricted key is one leak away from someone else spending your money.',
      'Paste it below, reload, and turn on <b>Photoreal 3D</b> under Descent.',
      'Cost: the Photorealistic 3D Tiles SKU bills per <i>root tile request</i>, and one buys three hours of streaming. <b>1000 a month are free.</b> This app asks for exactly one per session, the first time you flip the switch — so ordinary use never reaches the free limit.',
      '<b>EEA billing loses the 3D half.</b> Under the EEA terms Google does not serve satellite or photorealistic 3D tiles to projects billed to an address in the European Economic Area, and returns 403. A project created on or after 8 July 2025 with EEA billing is <i>not eligible</i> for the exemption at all; one created before it keeps the exemption only until it is materially modified, and enabling another Maps Platform service counts. Google document no way back from either. What matters is the date and billing country of the <i>Cloud project</i>, not of this app.',
    ],
  },
  {
    fields: ['windy'],
    name: 'Windy',
    tier: 2,
    cost: 'free',
    adds: 'About a thousand webcams worldwide, and more wherever you look.',
    url: 'https://api.windy.com/keys',
    steps: [
      'Open api.windy.com/webcams and press <b>Get API key</b> under the free column.',
      'Sign in with a Windy account, or make one — it is free and takes a minute.',
      'Create a key for the <b>Webcams API</b>. Leave domain restrictions empty and put <code>http://localhost:8820</code> as the project.',
      'Paste the key below.',
    ],
  },
  {
    fields: ['trafikverket'],
    name: 'Trafikverket',
    tier: 1,
    cost: 'free',
    adds: 'Three layers off one key. <b>1 528 road cameras</b> at full resolution; <b>road disruption</b> across the state network - roadworks, incidents and ferry notices, with severity in Trafikverket own words; and <b>where every reporting train in Sweden is</b>, updated every thirty seconds.',
    url: 'https://data.trafikverket.se/oauth2/Account/register',
    steps: [
      'The button below opens the registration form directly. The old api.trafikinfo.trafikverket.se address answers 404 now, so ignore it if you meet it in an older guide.',
      'Confirm the address in the email they send.',
      'Under <b>Mina nycklar</b>, copy the authentication key.',
      'Paste it below, reload, and switch on <b>Swedish road disruption</b> and <b>Swedish trains</b> under Sweden. The cameras appear under Infrastructure.',
      'All of it is Sweden only, and the state road and rail network only. A municipal street closure is not in here, and neither is a train that is not reporting.',
    ],
  },
  {
    fields: ['opensky_client_id', 'opensky_client_secret'],
    name: 'OpenSky Network',
    tier: 2,
    cost: 'free',
    adds: 'The whole planet\u2019s air traffic in one call — about 13 000 aircraft — instead of stitched 250 nm circles.',
    url: 'https://opensky-network.org/',
    steps: [
      'Register at opensky-network.org and log in.',
      'Open your account page and create an <b>API client</b>.',
      'The <b>client secret is shown once</b>. Copy it there and then; if you miss it, press Reset Credential for a new pair.',
      'Paste the client id and the secret below.',
    ],
  },
  {
    fields: ['aisstream'],
    name: 'aisstream.io',
    tier: 2,
    cost: 'free',
    adds: 'Ship positions worldwide. Without it the sea is only the Baltic, which is all Digitraffic covers.',
    url: 'https://aisstream.io/',
    steps: [
      'Sign up at aisstream.io and create an API key.',
      'Paste it below.',
      'Their service has been intermittent — connected but delivering nothing for days at a stretch. The feed log says so plainly when that happens.',
    ],
  },
  {
    name: 'OpenAQ',
    tier: 3,
    cost: 'free',
    adds: 'Air quality, as PM2.5 measured at the ground. The only layer here that measures something happening to people rather than to the ground — and the one most likely to matter to somebody watching from the place being looked at.',
    url: 'https://explore.openaq.org/register?redirect=/',
    fields: ['openaq'],
    steps: [
      'Register at <b>explore.openaq.org/register</b> and create an API key. Free. The old openaq.org/developers address this used to point at is a 404 now.',
      'Paste it below, reload, and switch on <b>Air quality (PM2.5)</b> under People.',
      'The API answers 401 without a key, so the layer says it is missing one rather than drawing nothing.',
      'Colour follows the WHO 24-hour guideline of 15 micrograms per cubic metre. Reference monitors and low-cost sensors are reported together and are not equally accurate — the card says so on every reading.',
    ],
  },
  {
    name: 'Global Fishing Watch',
    tier: 3,
    cost: 'free',
    adds: 'What vessels appear to be <i>doing</i>, which the AIS layer cannot say: fishing rather than transit, encounters between two ships at sea, and transponder gaps where a vessel went dark and came back somewhere else.',
    url: 'https://globalfishingwatch.org/our-apis/',
    fields: ['gfw'],
    steps: [
      'Request an API token at globalfishingwatch.org/our-apis. Free, and granted by hand rather than instantly.',
      'Paste it below, reload, and switch on <b>Fishing &amp; AIS gaps</b> under Moving.',
      'A gap is a question, not an accusation. Transponders stop for equipment failure, poor satellite coverage and missed passes. The card says this on every gap, deliberately.',
    ],
  },
  {
    name: 'TomTom',
    tier: 2,
    cost: 'free',
    adds: 'Measured traffic flow. The simulated version this replaces was removed for a good reason: a moving dot that is not a car is worse than no dot, because it looks like information.',
    url: 'https://developer.tomtom.com/',
    fields: ['tomtom'],
    steps: [
      'Register at developer.tomtom.com. The free tier is generous.',
      'The key is not where the developer site suggests. Once signed in, go to <b>MyTomTom</b> and open <b>API &amp; SDK Keys</b> — the key is on a row there, behind the <b>&hellip;</b> menu at its right. The developer.tomtom.com/user/me/apps address answers but renders empty, which is a dead end worth not walking into.',
      'Paste it below, reload, and switch on <b>Traffic flow</b> and <b>Jams &amp; roadworks</b> under Infrastructure.',
      'Restrict the key by referrer to <code>127.0.0.1:8820</code>, the way the Google one is. The browser fetches the traffic tiles directly, so the key reaches the page and a copied one is worth much less with the rule in place.',
    ],
  },
  {
    name: 'Copernicus Data Space',
    tier: 2,
    cost: 'free',
    adds: 'Sentinel-2 <i>on a given day</i>, at 10 m. The Sentinel layer already here is the EOX cloudless mosaic - a year of passes averaged into a basemap with no clouds, no smoke, no ships and no flood in it. This is the other kind: one acquisition, with whatever was in the air still in it. A sediment plume, the edge of a burn scar, a flooded field, an algal bloom.',
    url: 'https://shapps.dataspace.copernicus.eu/dashboard/',
    fields: ['copernicus'],
    steps: [
      'Register at <b>dataspace.copernicus.eu</b>. Free, and the account is instant.',
      'Then go to <b>shapps.dataspace.copernicus.eu/dashboard/</b>. This is the part people miss: the account console you land in after registering handles logins and OAuth clients, and has nothing you need. The Sentinel Hub dashboard is a separate app at that address, and it is where the instance lives.',
      'In its left menu: <b>Dashboard</b>, <b>Configuration Utility</b>, <b>My Collections</b>, <b>Usage</b>, <b>Copernicus Browser</b>. You want <b>Configuration Utility</b>.',
      'Create a new configuration from a <b>Sentinel-2 L2A</b> template. The template arrives with about ten visualisations already in it - Natural color, SWIR, NDVI, Moisture Index, Geology and so on. Keep the ones you want and delete the rest; each one you keep becomes a style button in this app.',
      'The configuration has an <b>instance id</b>, a long value shaped like <code>0f3a91d7-2c48-4b6e-9a15-3d7c8e2f0b44</code>. Paste it below and reload. The new styles appear beside SENTINEL 10M and follow the imagery-day slider.',
      'Your quota is on the dashboard front page. A <b>Copernicus General user</b> account shows 30,000 processing units and 30,000 requests a month, neither rolling over. Requests is the one you meet first: every map tile is one request, and a screenful of globe is twenty or thirty. So this is a layer to go and look at one place with, not one to leave on while flying around.',
      'Sentinel-2 passes the same ground every five days or so, which is why the app asks for a ten-day window ending on the slider day rather than for a single date. A single date would return a few diagonal strips and nothing else. The cost of the window is that what comes back may be stitched from two passes a few days apart.',
      'It is optical, so clouds stop it. That is not a fault in the layer, it is what the satellite saw. The cloudless mosaic exists precisely because single acquisitions are so often grey.',
    ],
  },
];

// How long ago a key last worked, in words. Its own helper because whenLine
// takes an event and this takes a unix second from the server.
function keyAgo(unixSeconds) {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 60));
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

async function renderKeyRows() {
  let state = {};
  try {
    state = await getJSON('/api/keys');
  } catch (_) { /* offline: show everything as unset */ }

  const host = $('#key-rows');
  host.innerHTML = '';

  /*
   * Eleven keys in one undifferentiated column told nobody where to start.
   * Every card looked as important as every other, the order was the order they
   * happened to be written in, and the one that can actually charge you money
   * sat between two that cannot.
   *
   * So: a summary of what is needed before any of it, then the same cards in
   * tiers, numbered. The first thing it says is the true thing - nothing here
   * is required - and the last group is the only one with a bill attached.
   */
  const TIERS = [
    { n: 1, name: 'Start with these two',
      why: 'The biggest difference for the least trouble. Both free, both take '
         + 'about two minutes.' },
    { n: 2, name: 'Then whichever you want',
      why: 'Each one adds a layer or widens one you already have. All free, and '
         + 'none of them are needed by anything else.' },
    { n: 3, name: 'Narrower ones',
      why: 'Free, and each answers one specific question. Worth it if that is '
         + 'the question you have.' },
    { n: 4, name: 'The one that can cost money',
      why: 'Google bill this past a monthly free allowance. The app counts your '
         + 'usage against that allowance and shows it under Google spend, but '
         + 'their console is the authority.' },
  ];

  /*
   * Three states, not two.
   *
   * This said IN USE the moment a key was saved, which is a claim about a text
   * field rather than about the key. A key can be saved and wrong, saved and
   * expired, or saved and refused by a referrer rule, and all three read as
   * IN USE. The server now records when a call using a key actually came back
   * with something, so SAVED and WORKING can be told apart - and for the two
   * keys the browser uses rather than the server, the honest answer is that it
   * cannot tell, which is what it says.
   */
  const stateOf = (service) => {
    const parts = service.fields.map((f) => state[f] || {});
    if (!parts.every((p) => p.set)) return { code: 'unset', label: 'NOT SET' };
    if (parts.some((p) => p.client_side)) {
      return { code: 'browser', label: 'SAVED', note: 'used by the browser, so '
        + 'the server cannot vouch for it' };
    }
    const when = parts.map((p) => p.worked).filter(Boolean);
    if (when.length === parts.length) {
      return { code: 'working', label: 'WORKING',
        note: `a call using it succeeded ${keyAgo(Math.max(...when))}` };
    }
    return { code: 'saved', label: 'SAVED', note: 'nothing has used it yet this '
      + 'session — switch on a layer that needs it' };
  };

  const done = SERVICES.filter((s) => stateOf(s).code !== 'unset');
  const proven = SERVICES.filter((s) => stateOf(s).code === 'working');
  const namesFor = (tier) => SERVICES.filter((s) => s.tier === tier)
    .map((s) => s.name).join(', ');

  const summary = document.createElement('div');
  summary.className = 'key-summary';
  summary.innerHTML = `
    <h4>What do you actually need?</h4>
    <dl>
      <dt class="none">Needed</dt>
      <dd><b>Nothing.</b> Borders, place names, about four thousand public
        cameras, ships in the Baltic and aircraft worldwide all work with no
        account at all. Everything below is an addition.</dd>
      <dt>Biggest gain</dt><dd>${namesFor(1)} — free</dd>
      <dt>Adds a layer</dt><dd>${namesFor(2)} — free</dd>
      <dt>Narrower</dt><dd>${namesFor(3)} — free</dd>
      <dt class="billed">Costs money</dt><dd>${namesFor(4)} — free allowance
        first, then billed</dd>
    </dl>
    <p class="adds">${done.length} of ${SERVICES.length} saved, ${proven.length} seen working.
      Keys live in <code>keys.json</code> beside the app, take effect without a
      restart, and are never shown back to you once saved.</p>`;
  host.append(summary);

  let number = 0;
  for (const tier of TIERS) {
    const members = SERVICES.filter((s) => s.tier === tier.n);
    if (!members.length) continue;

    const head = document.createElement('div');
    head.className = 'key-tier' + (tier.n === 4 ? ' billed' : '');
    head.innerHTML = `<h4>${tier.name}</h4><p>${tier.why}</p>`;
    host.append(head);

    for (const service of members) {
      number += 1;
      const st = stateOf(service);
      const set = st.code !== 'unset';
      const row = document.createElement('div');
      row.className = 'key-row';
      row.innerHTML = `
        <h4><span class="num">${number}</span>${service.name}<span class="state ${st.code}">${st.label}</span></h4>
        ${st.note ? `<p class="state-note">${st.note}</p>` : ''}
        <p class="adds">${service.adds}</p>
        <ol>${service.steps.map((step) => `<li>${step}</li>`).join('')}</ol>
        <p class="key-go"><a class="chip" href="${service.url}" target="_blank" rel="noreferrer">GET THE KEY ↗</a></p>
        ${service.fields.map((f) => `
          <div class="key-field">
            <input type="text" data-field="${f}" placeholder="${f}${set ? ' — saved, paste to replace' : ''}">
            <button class="chip" data-save="${f}">SAVE</button>
          </div>`).join('')}
      `;
      host.append(row);
    }
  }

  // Last, not first: somebody arriving here wants to know what to get before
  // they want to be told how to handle it. But it belongs on the page, because
  // the mistake it warns about is easy and quiet.
  const safety = document.createElement('div');
  safety.className = 'key-safety';
  safety.innerHTML = `
    <h4>Handling the keys</h4>
    <ul>
      <li>Keep the account logins in a password manager. This app never sees
        them — only the API keys.</li>
      <li><b>Do not paste an API key into a chat, an email or a screenshot.</b>
        A key in a transcript is a key somebody else has, and most of them spend
        your quota rather than your money — which makes the theft quiet.</li>
      <li>An empty field leaves the saved key untouched. Paste over it only when
        you mean to replace it.</li>
      <li>Keys live in <code>keys.json</code> beside the app, in plain text, on
        this machine. That file is excluded from the repository on purpose.
        Move it with a USB stick, not through a paste box.</li>
      <li>Restrict what can be restricted. Google and TomTom both allow a
        referrer rule; set it to <code>127.0.0.1:8820</code> and a copied key is
        worth much less.</li>
    </ul>`;
  host.append(safety);

  for (const button of host.querySelectorAll('[data-save]')) {
    button.onclick = async () => {
      const field = button.dataset.save;
      const input = host.querySelector(`input[data-field="${field}"]`);
      const value = input.value.trim();
      if (!value) return;
      button.textContent = 'SAVING';
      try {
        const res = await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        if (!res.ok) throw new Error(res.status);
        input.value = '';
        log(`key saved: ${field}`);
        renderKeyRows();
      } catch (err) {
        button.textContent = 'FAILED';
        log(`could not save ${field} (${err.message})`, 'warn');
      }
    };
  }
}

/*
 * What each feed permits. Written down because handing the app to someone else
 * hands them these obligations too, and because "can I sell this" has a real
 * answer that depends on this table rather than on how the code is licensed.
 */
const SOURCE_LICENCES = [
  ['CesiumJS', 'the globe engine', 'Apache 2.0', 'free'],
  ['satellite.js', 'orbit propagation', 'MIT', 'free'],
  ['OpenStreetMap', 'buildings, roads, base map', 'ODbL — attribution, share-alike', 'free'],
  ['NASA OPERA', 'radar backscatter, disturbance, surface water', 'public domain', 'free'],
  ['The Space Devs', 'launch schedule', 'CC BY 4.0', 'free'],
  ['OpenStreetMap', 'data centres and dams', 'ODbL 1.0 — share-alike on the data', 'free'],
  ['TomTom', 'measured traffic flow', 'their terms; free tier', 'free key'],
  ['OpenAQ', 'PM2.5 measurements', 'CC BY 4.0', 'free key'],
  ['Global Fishing Watch', 'fishing, encounters, AIS gaps', 'CC BY-SA 4.0', 'free token'],
  ['Natural Earth', 'country and state borders', 'public domain', 'free'],
  ['Esri dark canvas', 'the dark chart and its labels', 'Imagery © Esri and its licensors, non-commercial', 'non-commercial'],
  ['Esri World Imagery', 'satellite imagery', 'for use with Esri products', 'non-commercial'],
  ['OpenSky Network', 'global air traffic', 'non-profit research and education only', 'non-commercial'],
  ['adsb.fi', 'air traffic fallback', 'community feed, attribution', 'free'],
  ['adsbdb', 'aircraft registry, operators', 'free API', 'free'],
  ['planespotters', 'aircraft photographs', 'no paywalled features, credit + link required', 'non-commercial'],
  ['Digitraffic', 'Baltic AIS, Finnish cameras', 'CC BY 4.0', 'free'],
  ['Trafikverket', 'Swedish road cameras, road disruption and train positions', 'open API, attribution', 'free'],
  ['SMHI', 'Swedish weather, water and fire warnings', 'CC BY 4.0, attribution required, no account', 'free'],
  ['Transport for London', 'London cameras', 'TfL Open Data Licence', 'free'],
  ['Windy', 'webcams worldwide', 'free tier is link/embed only', 'non-commercial'],
  ['aisstream.io', 'worldwide AIS', 'free tier', 'free'],
  ['KartaView', 'street-level photographs', 'CC BY-SA', 'free'],
  ['Wikimedia Commons', 'ship and type photographs', 'per file, mostly CC BY-SA', 'free'],
  ['Wikidata', 'entity graph, heads of state', 'CC0', 'free'],
  ['CelesTrak', 'orbital elements, satellite catalogue', 'free with attribution', 'free'],
  ['EOX s2cloudless', 'Sentinel-2 10 m cloudless mosaic', 'CC BY 4.0, attribution required', 'free'],
  ['Copernicus Data Space', 'Sentinel-2 on a given day at 10 m, from your own instance', 'free and open, commercial use included, attribution required: contains modified Copernicus Sentinel data', 'free'],
  ['Smithsonian GVP', 'volcanic eruptions', 'attribution required', 'free'],
  ['KiwiSDR network', 'open shortwave receivers', 'per-receiver, volunteer run', 'free'],
  ['APRS-IS', 'amateur radio positions', 'read-only, unverified login', 'free'],
  ['OpenMHZ', 'public-safety radio recordings', 'per-site terms, US only', 'free'],
  ['OurAirports', 'airport list', 'public domain', 'free'],
  ['Radio Browser', 'broadcast station streams', 'open community catalogue', 'free'],
  ['WHO', 'disease outbreak news', 'open, attribution', 'free'],
  ['GDACS / EU JRC', 'disaster alerts', 'open, attribution', 'free'],
  ['NOAA SWPC', 'space weather, Kp index', 'public domain', 'free'],
  ['NOAA NWS', 'US severe weather alerts', 'public domain', 'free'],
  ['WRI', 'global power plant database', 'CC BY 4.0', 'free'],
  ['IODA / Georgia Tech', 'internet outages', 'research terms, attribution', 'free'],
  ['GDELT Project', 'news coverage by country', 'CC BY', 'free'],
  ['Meshtastic map', 'mesh radio nodes', 'community project, poll daily', 'free'],
  ['Amtrak / amtraker', 'US train positions', 'community mirror', 'free'],
  ['Wikidata', 'heads of state', 'CC0', 'free'],
  ['Google DNS, RIPE, Shodan InternetDB', 'registry lookups', 'public registry data', 'free'],
  ['USGS', 'earthquakes', 'public domain', 'free'],
  ['NASA FIRMS', 'active fire / thermal detections', 'open data, attribution requested', 'free'],
  ['TeleGeography', 'submarine cable map', 'CC BY-SA 4.0 for the map; the data feed this uses is pointed at commercial licensing', 'ask them'],
  ['USNI News', 'fleet positions', 'facts cited, editorial not reproduced', 'free'],
  ['Google Maps Platform', 'photorealistic 3D and Street View panoramas', 'commercial terms: a monthly free allowance, then billed. Neither free-for-anything nor non-commercial - read the terms and watch the spend panel', 'paid'],
];

/*
 * What the badge on a source row is allowed to say.
 *
 * This was a binary - free, or NON-COMM - and the binary was wrong about
 * Google, whose terms permit commercial use and bill for it. That is a
 * different answer from "you may not sell this", and it is the wrong warning to
 * give somebody deciding what may go in a monetised video.
 *
 * Every value used in SOURCE_LICENCES needs an entry here. The smoke test
 * checks that, because widening this map is exactly the sort of change that
 * silently relabels seven rows nobody was looking at.
 */
const BADGE = {
  free: ['free', 'ANY USE'],
  'free key': ['free', 'ANY USE'],
  'free token': ['free', 'ANY USE'],
  'non-commercial': ['nc', 'NON-COMM'],
  paid: ['paid', 'PAID USE'],
  'ask them': ['nc', 'ASK THEM'],
};

function renderSourceRows() {
  const host = $('#source-rows');
  if (!host || host.childElementCount) return;
  for (const [name, what, licence, use] of SOURCE_LICENCES) {
    const row = document.createElement('div');
    row.className = 'source-row';
    row.innerHTML =
      `<b>${name}</b><span class="what">${what} — ${licence}</span>` +
      // Three states, not two. A binary here said NON-COMM about Google, whose
      // terms allow commercial use and charge for it - which is a different
      // thing, and the wrong warning to give somebody deciding what they may
      // put in a monetised video.
      `<span class="use ${BADGE[use] ? BADGE[use][0] : 'nc'}">`
      + `${BADGE[use] ? BADGE[use][1] : 'CHECK IT'}</span>`;
    host.append(row);
  }
}

function openGuide(tab) {
  $('#guide').hidden = false;
  for (const button of document.querySelectorAll('.guide-tab')) {
    const on = button.dataset.tab === tab;
    button.classList.toggle('active', on);
    $(`#guide-${button.dataset.tab}`).hidden = !on;
  }
  if (tab === 'keys') renderKeyRows();
  if (tab === 'sources') renderSourceRows();
}

$('#tab-help').onclick = () => openGuide('use');
$('#tab-setup').onclick = () => openGuide('keys');
$('#guide-close').onclick = () => { $('#guide').hidden = true; };
for (const button of document.querySelectorAll('.guide-tab')) {
  button.onclick = () => openGuide(button.dataset.tab);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#guide').hidden) $('#guide').hidden = true;
});

/*
 * First run used to open the whole guide after two and a half seconds, which is
 * a manual in the face of somebody who has not yet seen the thing it documents.
 *
 * A welcome page instead: what this is, three things to try, and a way out in
 * either direction. It is dismissible for good, and reachable afterwards from
 * WELCOME in the top bar - a checkbox that hides something permanently needs a
 * door back in, or it is a trap rather than a preference.
 */
function showWelcome() {
  $('#welcome-hide').checked = localStorage.getItem('gcv-welcome') === 'hidden';
  $('#welcome').hidden = false;
}

function closeWelcome() {
  localStorage.setItem('gcv-welcome',
    $('#welcome-hide').checked ? 'hidden' : 'shown');
  $('#welcome').hidden = true;
}

$('#welcome-start').onclick = closeWelcome;
$('#welcome-close').onclick = closeWelcome;
$('#welcome-tour').onclick = () => { closeWelcome(); openGuide('use'); };
$('#tab-welcome').onclick = showWelcome;

// Escape closes it, the same as the guide, and remembers the checkbox either way.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#welcome').hidden) closeWelcome();
});

if (localStorage.getItem('gcv-welcome') !== 'hidden') {
  // A beat, so the globe is drawn behind it rather than a blank screen.
  setTimeout(showWelcome, 1200);
}
localStorage.setItem('gcv.seen', '1');

/* ------------------------------------------------------------ panel folds */

/*
 * Ten layers and six tool blocks do not fit on a laptop screen, so each section
 * folds. What is open is remembered, because the sections someone actually uses
 * are personal and should not reset on every reload.
 */

const FOLD_STORE = 'gcv.folded';
// Everything but the two you actually read on arrival. The index above makes
// the rest one click away, which is better than scrolling past them.
const FOLD_DEFAULT = [
  'optics', 'detection', 'descent', 'tools', 'jump-to', 'recon', 'own',
  'marks', 'costs', 'broadcast', 'tracks',
];

function foldedSections() {
  try {
    const saved = localStorage.getItem(FOLD_STORE);
    return saved ? JSON.parse(saved) : FOLD_DEFAULT;
  } catch (_) {
    return FOLD_DEFAULT;
  }
}

function applyFolds(folded) {
  for (const h2 of document.querySelectorAll('h2[data-section]')) {
    h2.parentElement.classList.toggle('folded', folded.includes(h2.dataset.section));
  }
  localStorage.setItem(FOLD_STORE, JSON.stringify(folded));
}

for (const h2 of document.querySelectorAll('h2[data-section]')) {
  h2.onclick = () => {
    const key = h2.dataset.section;
    const folded = foldedSections();
    applyFolds(folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key]);
    renderSectionIndex();
  };
}

applyFolds(foldedSections());
renderSectionIndex();

/* --------------------------------------------------------- section index */

/*
 * The panel started with six sections and has fourteen. Unfolded it is some
 * 6 800 pixels of content in a 650 pixel window, which is how a switch somebody
 * used yesterday becomes one they cannot find today - it is not hidden, it is
 * eight hundred pixels below the edge.
 *
 * The index is built from the sections themselves rather than a list kept
 * alongside them, so adding a section cannot leave it unreachable. Clicking a
 * name unfolds that section and scrolls to it, because half the time the reason
 * you cannot see something is that its section is collapsed.
 */

function renderSectionIndex() {
  const nav = $('#section-index');
  if (!nav) return;
  const folded = foldedSections();
  nav.innerHTML = '';
  for (const h2 of document.querySelectorAll('#panel h2[data-section]')) {
    const key = h2.dataset.section;
    const button = document.createElement('button');
    button.textContent = (h2.textContent || key).replace(/\d+\/\d+$/, '').trim();
    button.className = folded.includes(key) ? 'folded' : '';
    button.title = folded.includes(key) ? 'folded \u2014 click to open' : 'go to';
    button.onclick = () => {
      applyFolds(foldedSections().filter((k) => k !== key));
      h2.scrollIntoView({ block: 'start', behavior: 'smooth' });
      renderSectionIndex();
    };
    nav.append(button);
  }
}

/** A folded section still says how much is inside it. */
function updateFoldTallies() {
  const tallies = {
    layers: `${LAYERS.filter((l) => l.on).length}/${LAYERS.length}`,
    marks: `${loadMarks().length}`,
    'jump-to': `${PLACES.length}`,
    briefing: briefCount ? `${briefCount}` : '',
  };
  for (const [key, text] of Object.entries(tallies)) {
    const h2 = document.querySelector(`h2[data-section="${key}"]`);
    if (!h2) continue;
    let tally = h2.querySelector('.tally');
    if (!tally) {
      tally = document.createElement('span');
      tally.className = 'tally';
      h2.append(tally);
    }
    tally.textContent = text;
  }
}

setInterval(updateFoldTallies, 1500);
updateFoldTallies();

/* ----------------------------------------------------------- performance */

/*
 * A switch for hardware that is not this one.
 *
 * The globe renders continuously by default: sixty times a second whether or not
 * anything has changed. On a desktop with a discrete card that is invisible. On
 * a thin laptop with integrated graphics it is a warm fan and a flat battery
 * while a stationary globe is repainted over and over for no reason - and with
 * the layers this app starts with, nothing on screen is moving at all.
 *
 * So the main saving is not lower quality, it is not drawing what has not
 * changed. Cesium already asks for a frame when the camera moves or a tile
 * arrives; what it cannot know about is our own animation, so anything that
 * moves under its own steam pumps the renderer itself, at a rate chosen here
 * rather than by the monitor.
 *
 * The rest is ordinary thrift: coarser terrain, no fog, no atmosphere, and the
 * two Cesium ion products - terrain and buildings - switched off, since those
 * are the heaviest things the app can put on screen.
 */

let thrifty = localStorage.getItem('gcv-thrifty') === '1';
let thriftyPump = null;

// Only these move on their own. Everything else changes when the camera does,
// which Cesium already notices without being told.
const MOVING_LAYERS = ['flights', 'services', 'vessels', 'satellites'];

function somethingIsMoving() {
  return MOVING_LAYERS.some((id) => (LAYERS.find((l) => l.id === id) || {}).on)
    || !!followed;
}

function pumpRenderer() {
  clearInterval(thriftyPump);
  thriftyPump = null;
  if (!thrifty) return;
  // 20 a second rather than 60: a third of the drawing for animation that is
  // still smooth to look at. Only runs while something actually moves.
  thriftyPump = setInterval(() => {
    if (somethingIsMoving()) scene.requestRender();
  }, 50);
}

function applyThrifty(announce) {
  localStorage.setItem('gcv-thrifty', thrifty ? '1' : '0');
  $('#thrifty').checked = thrifty;
  $('#thrifty-note').textContent = thrifty
    ? 'Draws only when something changes, caps animation at 20 a second, and '
      + 'drops fog, atmosphere, terrain detail and 3D buildings. Meant for '
      + 'laptops and integrated graphics. Nothing here changes what the data says.'
    : 'Off: continuous rendering at whatever rate the screen allows. Fine on a '
      + 'desktop with its own graphics card; switch this on if the globe feels '
      + 'heavy or the fan is loud.';

  if (thrifty) {
    scene.requestRenderMode = true;
    // How far the simulated clock may drift before a frame is drawn anyway.
    scene.maximumRenderTimeChange = 1.0;
    viewer.targetFrameRate = 30;
    scene.fog.enabled = false;
    scene.skyAtmosphere.show = false;
    scene.globe.showGroundAtmosphere = false;
    // Cesium's default is 2. Four asks for roughly half the terrain tiles.
    scene.globe.maximumScreenSpaceError = 4;
    if (ionBuildings) ionBuildings.show = false;
    if ($('#grain').checked) {
      $('#grain').checked = false;
      $('#scanlines').classList.add('off');
    }
  } else {
    scene.requestRenderMode = false;
    viewer.targetFrameRate = undefined;
    scene.fog.enabled = true;
    scene.skyAtmosphere.show = true;
    scene.globe.showGroundAtmosphere = true;
    scene.globe.maximumScreenSpaceError = 2;
    if (ionBuildings) ionBuildings.show = $('#buildings').checked && !$('#photoreal').checked;
  }

  pumpRenderer();
  scene.requestRender();
  if (announce) {
    log(thrifty
      ? 'performance mode ON · drawing only on change, animation capped at 20/s'
      : 'performance mode OFF · continuous rendering, full atmosphere');
  }
}

$('#thrifty').onchange = (e) => {
  thrifty = e.target.checked;
  applyThrifty(true);
};

/*
 * Offer the switch to the people who need it, rather than wait to be found.
 *
 * Someone on a thin laptop does not necessarily know that a globe can be told
 * to draw less; they know it feels heavy, and heavy things get closed. So the
 * app watches its own frame interval and says something once - after the first
 * few seconds, which are always slow while tiles arrive, and never again in the
 * same session. A hint that repeats is nagging, and nagging gets ignored.
 *
 * Measured, not guessed: this is the real gap between frames, not the cost of
 * one function inside them.
 */
const SLOW_FRAME_MS = 33;        // below roughly 30 a second
const SLOW_SAMPLE = 120;         // frames to judge on
let slowFrames = [], slowSaid = false, slowWatchFrom = 0;

scene.postRender.addEventListener(() => {
  if (slowSaid || thrifty) return;
  const now = performance.now();
  if (!slowWatchFrom) { slowWatchFrom = now; return; }
  // The first eight seconds are terrain and imagery arriving. Judging then
  // would flag every machine, including the fast ones.
  if (now - slowWatchFrom < 8000) return;

  slowFrames.push(now);
  if (slowFrames.length < SLOW_SAMPLE) return;

  const gaps = [];
  for (let i = 1; i < slowFrames.length; i++) gaps.push(slowFrames[i] - slowFrames[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];
  slowFrames = [];

  if (median > SLOW_FRAME_MS) {
    slowSaid = true;
    log(`this is drawing at about ${Math.round(1000 / median)} a second · `
      + 'Performance mode under Broadcast will lighten it', 'warn');
  }
});

/*
 * A train number on its own says nothing.
 *
 * The position layer knows where train 1127 is and nothing else about it, which
 * was reported as exactly that: I can see it, but I do not know it runs
 * Gothenburg to Copenhagen, or whether it is late. Both are published, in a
 * different object type, and asking costs one request - so it is asked when a
 * train is actually clicked rather than for all four hundred on screen.
 *
 * The card draws immediately with what the position gave, and fills in the
 * journey when it arrives. A card that waits in silence looks broken.
 */

function trainFields(ref, journey) {
  const age = Number.isFinite(ref.age_s)
    ? (ref.age_s <= 1 ? 'just now' : `${ref.age_s} s ago`)
    : 'unknown';
  const rows = [];

  if (journey === 'looking') {
    rows.push(['Journey', 'looking it up…']);
  } else if (journey && journey.needs_key) {
    rows.push(['Journey', 'needs the Trafikverket key — Setup tab']);
  } else if (journey && journey.error) {
    rows.push(['Journey', `could not look it up (${journey.error})`]);
  } else if (journey && journey.stops && !journey.stops.length) {
    rows.push(['Journey', 'not advertised. Freight and empty stock run without '
      + 'a public timetable, so Trafikverket publish no journey for this '
      + 'number.']);
  } else if (journey) {
    rows.push(['Route', journey.from && journey.to
      ? `${journey.from}  →  ${journey.to}` : 'not stated']);
    if (journey.cancelled) rows.push(['Cancelled', 'part of this journey is cancelled']);

    const seen = journey.last_seen;
    const next = journey.next;
    // Late is reported against whichever is the better answer: a station the
    // train has passed is a fact, one ahead of it is a forecast, and the card
    // says which of the two it is quoting.
    const quoted = seen || next;
    if (quoted && Number.isFinite(quoted.late)) {
      rows.push(['Running', quoted.late === 0 ? 'on time'
        : quoted.late > 0 ? `${quoted.late} min late`
        : `${-quoted.late} min early`]);
    }
    if (seen) {
      rows.push(['Last passed',
        `${seen.station} ${seen.actual} (timetabled ${seen.advertised})`]);
    }
    if (next) {
      rows.push(['Next', `${next.station} ${next.activity.toLowerCase()} `
        + `${next.advertised}${next.estimated && next.estimated !== next.advertised
          ? ` — expected ${next.estimated}` : ''}`]);
    }
    rows.push(['Stops', `${journey.passed} of ${journey.stops.length} passed`]);
  }

  rows.push(['Reported', age]);
  rows.push(['Bearing', ref.bearing !== null && ref.bearing !== undefined
    ? `${Math.round(ref.bearing)}°` : 'not given']);
  rows.push(['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`]);
  rows.push(['Note', 'the position is the train reporting itself. The timetable '
    + 'beside it is a separate feed: a station already passed carries a real '
    + 'time, one ahead of it carries an estimate. Positions older than fifteen '
    + 'minutes are dropped rather than drawn standing still.']);
  return rows;
}

async function showTrain(ref) {
  const title = ref.number ? `Train ${ref.number}` : 'Train';
  showDetail(title, 'position report · Trafikverket',
    trainFields(ref, 'looking'));
  if (!ref.number) return;

  let journey = null;
  try {
    journey = await getJSON('/api/train?number=' + encodeURIComponent(ref.number));
  } catch (err) {
    journey = { error: err.message };
  }
  // The viewer may have clicked something else while this was in flight, and
  // overwriting their new selection with an old train would be worse than
  // showing nothing.
  if ($('#detail-title').textContent !== title) return;
  showDetail(title, 'position report · Trafikverket',
    trainFields(ref, journey));
}

/* ----------------------------------------------------------------- runways */

/*
 * A dot says an airport is somewhere. It does not say which way you would land,
 * which is most of what anyone wants to know when they look at one.
 *
 * The runway is drawn as the thing it is - two thresholds and the strip between
 * them - and each end gets the line an aircraft on a straight-in would fly down.
 * That line is arithmetic from the published heading, not a procedure lifted off
 * a chart: Jeppesen's plates are licensed per pilot and are not going in here.
 * Ten miles along the runway bearing is where a straight-in would be, and the
 * card says exactly that so nobody mistakes it for an approach.
 *
 * Fetched for the view, like the OSM layer, because there are forty thousand
 * runways and a screen wants dozens.
 */

let runwayPrimitive = null;
let runwaysAt = '';

const RUNWAY_COLOUR = '#cbd5e1';
const CENTRELINE_COLOUR = '#7dffab';

async function loadRunways(force) {
  if (!layerOn('runways')) return;
  const view = viewer.camera.computeViewRectangle();
  if (!view) return;
  const box = {
    south: Cesium.Math.toDegrees(view.south),
    west: Cesium.Math.toDegrees(view.west),
    north: Cesium.Math.toDegrees(view.north),
    east: Cesium.Math.toDegrees(view.east),
  };
  const key = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(1)).join(',');
  if (key === runwaysAt && !force) return;
  runwaysAt = key;

  let data;
  try {
    data = await getJSON('/api/runways?'
      + `south=${box.south.toFixed(3)}&west=${box.west.toFixed(3)}`
      + `&north=${box.north.toFixed(3)}&east=${box.east.toFixed(3)}`);
  } catch (err) {
    log(`runways unavailable (${err.message})`, 'warn');
    return;
  }

  if (runwayPrimitive) {
    scene.primitives.remove(runwayPrimitive);
    runwayPrimitive = null;
  }
  if (data.too_wide) {
    setCount('runways', 0);
    log(`runways: ${data.note}`, 'warn');
    return;
  }

  const instances = [];
  const strip = Cesium.Color.fromCssColorString(RUNWAY_COLOUR);
  const line = Cesium.Color.fromCssColorString(CENTRELINE_COLOUR).withAlpha(0.55);

  for (const r of data.runways || []) {
    const closed = r.closed;
    instances.push(new Cesium.GeometryInstance({
      geometry: new Cesium.GroundPolylineGeometry({
        positions: Cesium.Cartesian3.fromDegreesArray(
          [r.le_lon, r.le_lat, r.he_lon, r.he_lat]),
        width: Math.max(3, Math.min(9, (r.length_ft || 3000) / 1400)),
        arcType: Cesium.ArcType.GEODESIC,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
          closed ? strip.withAlpha(0.25) : strip.withAlpha(0.9)),
      },
      id: { type: 'runway', ref: r },
    }));

    // A closed runway has no approach worth drawing down.
    if (closed) continue;
    for (const [end, point] of [['le', r.le_approach], ['he', r.he_approach]]) {
      if (!point) continue;
      const thresholdLat = end === 'le' ? r.le_lat : r.he_lat;
      const thresholdLon = end === 'le' ? r.le_lon : r.he_lon;
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.GroundPolylineGeometry({
          positions: Cesium.Cartesian3.fromDegreesArray(
            [thresholdLon, thresholdLat, point[1], point[0]]),
          width: 1.4,
          arcType: Cesium.ArcType.GEODESIC,
        }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(line) },
        // The end travels inside ref because describePicked only receives
        // type and ref, and which threshold you clicked is the whole point
        // of clicking an approach line rather than the strip itself.
        id: { type: 'runway', ref: { ...r, end } },
      }));
    }
  }

  if (instances.length) {
    runwayPrimitive = scene.primitives.add(new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: true,
    }));
    runwayPrimitive.show = layerOn('runways');
  }
  setCount('runways', (data.runways || []).length);
  log(`runways: ${(data.runways || []).length} in view · OurAirports · `
    + `centrelines are ${data.centreline_nm} NM of arithmetic, not a procedure`);
}

/* ------------------------------------------------------------------- metar */

/*
 * The weather pilots read, which is not the weather anyone else reads.
 *
 * A METAR is an observation at a field: wind, visibility, cloud, temperature,
 * and what is falling out of the sky right now. Free from NOAA for the whole
 * planet with no account, which is why this layer needs no key while the air
 * quality one does. It was nearly built against OpenAIP, which does not carry
 * weather at all.
 *
 * The colours are the ones aviation already uses, and they are kept rather than
 * translated. VFR and IFR mean something precise about whether you may fly by
 * looking out of the window, and calling them "good" and "bad" would lose it.
 */

const FLIGHT_CAT_COLOUR = {
  VFR: '#7dffab',    // clear enough to fly by eye
  MVFR: '#4fd6ff',   // marginal
  IFR: '#ff9f45',    // instruments
  LIFR: '#ff5c5c',   // low instruments, the worst of it
};

let metarAt = '';

async function loadMetar(force) {
  if (!layerOn('metar')) return;
  const view = viewer.camera.computeViewRectangle();
  if (!view) return;
  const box = {
    south: Cesium.Math.toDegrees(view.south),
    west: Cesium.Math.toDegrees(view.west),
    north: Cesium.Math.toDegrees(view.north),
    east: Cesium.Math.toDegrees(view.east),
  };
  const key = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(1)).join(',');
  if (key === metarAt && !force) return;
  metarAt = key;

  let data;
  try {
    data = await getJSON('/api/metar?'
      + `south=${box.south.toFixed(3)}&west=${box.west.toFixed(3)}`
      + `&north=${box.north.toFixed(3)}&east=${box.east.toFixed(3)}`);
  } catch (err) {
    log(`metar unavailable (${err.message})`, 'warn');
    return;
  }

  metarPoints.removeAll();
  if (data.too_wide) {
    setCount('metar', 0);
    log(`metar: ${data.note}`, 'warn');
    applyVisibility();
    return;
  }

  for (const s of data.stations || []) {
    metarPoints.add({
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
      // Weather at the field makes the mark bigger, because a field reporting
      // rain is the one you are looking for among fifty that are not.
      pixelSize: s.weather ? 9 : 6,
      color: Cesium.Color.fromCssColorString(
        FLIGHT_CAT_COLOUR[s.category] || '#8a94a6').withAlpha(0.9),
      outlineColor: Cesium.Color.fromCssColorString('#0b0e14').withAlpha(0.75),
      outlineWidth: 1,
      disableDepthTestDistance: MARK_THROUGH_M,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.4, 4e6, 0.45),
      id: { type: 'metar', ref: s },
    });
  }
  setCount('metar', (data.stations || []).length);
  log(`metar: ${(data.stations || []).length} fields reporting · NOAA · `
    + `${data.reporting_weather} with weather at the field`);
  applyVisibility();
}

/*
 * Present weather comes as the codes the message uses, and they are kept. A
 * pilot reads -RA as light rain without thinking; anyone else needs it once,
 * and having both means the card teaches the code rather than replacing it.
 */
const WX_WORDS = {
  RA: 'rain', SN: 'snow', DZ: 'drizzle', GR: 'hail', GS: 'small hail',
  BR: 'mist', FG: 'fog', HZ: 'haze', FU: 'smoke', SA: 'sand', DU: 'dust',
  TS: 'thunderstorm', SH: 'showers', FZ: 'freezing', PL: 'ice pellets',
  SQ: 'squall', VA: 'volcanic ash', UP: 'unidentified precipitation',
};

function readWeather(code) {
  if (!code) return '';
  return code.split(/\s+/).map((token) => {
    let rest = token;
    let strength = '';
    if (rest.startsWith('-')) { strength = 'light '; rest = rest.slice(1); }
    else if (rest.startsWith('+')) { strength = 'heavy '; rest = rest.slice(1); }
    else if (rest.startsWith('VC')) { strength = 'in the vicinity, '; rest = rest.slice(2); }
    const words = [];
    for (let i = 0; i + 1 < rest.length + 1; i += 2) {
      const pair = rest.slice(i, i + 2);
      if (WX_WORDS[pair]) words.push(WX_WORDS[pair]);
    }
    return words.length ? `${token} — ${strength}${words.join(' ')}` : token;
  }).join(' · ');
}

async function showMetar(s) {
  const cloud = (s.clouds || [])
    .map((c) => `${c.cover}${c.base != null ? ` at ${c.base} ft` : ''}`)
    .join(', ');
  const rows = [
    ['Field', s.name || s.icao],
    ['Category', s.category
      ? `${s.category} — ${ {VFR: 'clear enough to fly by eye',
          MVFR: 'marginal', IFR: 'instruments required',
          LIFR: 'low instrument conditions'}[s.category] || '' }`
      : 'not stated'],
    ['Weather', s.weather ? readWeather(s.weather) : 'nothing falling'],
    ['Wind', s.wind_kt != null
      ? `${s.wind_dir}° at ${s.wind_kt} kt` : 'not reported'],
    ['Visibility', s.visibility != null ? `${s.visibility} statute miles` : 'not reported'],
    ['Cloud', cloud || 'none reported'],
    ['Temperature', s.temp_c != null
      ? `${s.temp_c}°C, dewpoint ${s.dewpoint_c}°C` : 'not reported'],
    ['Pressure', s.altimeter != null ? `${Math.round(s.altimeter)} hPa` : 'not reported'],
    ['Observed', (s.observed || '').replace('T', ' ').slice(0, 16) + ' UTC'],
    ['Forecast', 'looking…'],
    ['As issued', s.raw],
    ['Note', 'an observation at that field, not a forecast for the area around '
      + 'it. The raw line is the message as issued and is the authority; '
      + 'everything above it is this app reading it for you.'],
  ];
  showDetail(s.icao || 'field', 'observation · NOAA aviation weather', rows);

  // The forecast is a second request, so it arrives after the card rather than
  // holding it back. Most fields do not have one.
  let forecast = null;
  try {
    forecast = await getJSON('/api/taf?icao=' + encodeURIComponent(s.icao));
  } catch (err) {
    forecast = { error: err.message };
  }
  if ($('#detail-title').textContent !== (s.icao || 'field')) return;
  rows[9] = ['Forecast', forecast.raw ? forecast.raw
    : forecast.error ? `could not fetch it (${forecast.error})`
    : (forecast.note || 'none issued for this field')];
  showDetail(s.icao || 'field', 'observation · NOAA aviation weather', rows);
}

/* --------------------------------------------------------- airfield detail */

/*
 * What is written on the strip of paper beside a pilot: the frequencies for the
 * field and the beacons that belong to it.
 *
 * Fetched when an airport is clicked rather than for every airport on screen,
 * because it answers a question about one field and there are eighty thousand.
 * The card draws immediately with what the airport layer already knew and fills
 * the rest in, the same way a train journey does.
 *
 * The thing this cannot give is stated on the card rather than left to be
 * discovered: there is no ILS in it. No localiser, no glideslope, no minima.
 * That is in each country's AIP under each country's terms, and inventing an
 * approach would be worse than not having one.
 */

// Where each country publishes its own charts. Linked, never copied: an AIP is
// the publisher's document and several of them say so explicitly.
const AIP_LINKS = {
  SE: ['LFV, Swedish AIP', 'https://aro.lfv.se/Editorial/View/IAIP'],
  NO: ['Avinor, Norwegian AIP', 'https://avinor.no/en/ais/aipnorway/'],
  DK: ['Naviair, Danish AIP', 'https://aim.naviair.dk/'],
  FI: ['Fintraffic, Finnish AIP', 'https://www.ais.fi/'],
  GB: ['NATS, UK AIP', 'https://nats-uk.ead-it.com/'],
  DE: ['DFS, German AIP', 'https://aip.dfs.de/basicVFR/'],
  FR: ['SIA, French AIP', 'https://www.sia.aviation-civile.gouv.fr/'],
  NL: ['LVNL, Dutch AIP', 'https://www.lvnl.nl/eaip'],
  US: ['FAA, free approach plates', 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/'],
};

function frequencyLines(list) {
  return (list || []).map((f) => {
    const mhz = Number(f.mhz);
    const shown = Number.isFinite(mhz) ? mhz.toFixed(3) : f.mhz;
    return `${f.kind.padEnd(5)} ${shown} MHz`
      + (f.means ? `  ${f.means}` : (f.what ? `  ${f.what}` : ''));
  }).join('\n');
}

function navaidLines(list) {
  return (list || []).map((n) => {
    const khz = Number(n.khz);
    // VOR and above are quoted in MHz on every chart; NDBs stay in kHz.
    const tuned = Number.isFinite(khz)
      ? (khz >= 100000 ? `${(khz / 1000).toFixed(3)} MHz` : `${khz} kHz`)
      : n.khz;
    return `${n.ident.padEnd(5)} ${n.type.padEnd(8)} ${tuned}`
      + (n.dme_channel ? `  channel ${n.dme_channel}` : '');
  }).join('\n');
}

async function showAirport(ref) {
  const title = ref.name;
  const base = () => [
    ['Codes', [ref.icao, ref.iata].filter(Boolean).join(' · ')],
    ['Where', [ref.town, ref.country].filter(Boolean).join(', ')],
    ['Elevation', ref.elev_ft ? `${ref.elev_ft} ft` : ''],
    ['Position', `${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)}`],
  ];
  const tail = () => [
    ['Tower and approach', ref.icao
      ? `https://www.liveatc.net/search/?icao=${ref.icao}`
      : 'no ICAO code, so no feed to look up'],
    ['Where it works', 'LiveATC in practice is North America. Most of Europe '
      + 'restricts rebroadcasting air traffic control, so European airports '
      + 'usually have no feed however large they are — the link will open and '
      + 'find nothing. That is the law where the airport is, not a fault here.'],
  ];

  showDetail(title, `${ref.big ? 'large' : 'medium'} airport · ${ref.icao || '?'}`,
    [...base(), ['Frequencies', 'looking…'], ...tail()]);
  if (!ref.icao) return;

  let field = null;
  try {
    field = await getJSON('/api/airfield?icao=' + encodeURIComponent(ref.icao));
  } catch (err) {
    field = { error: err.message };
  }
  if ($('#detail-title').textContent !== title) return;

  const aip = AIP_LINKS[ref.country];
  const rows = [...base()];
  if (field.error) {
    rows.push(['Frequencies', `could not fetch them (${field.error})`]);
  } else {
    rows.push(['Frequencies', field.frequencies && field.frequencies.length
      ? frequencyLines(field.frequencies)
      : 'none published for this field']);
    rows.push(['Beacons', field.navaids && field.navaids.length
      ? navaidLines(field.navaids)
      : 'none listed as belonging to this field']);
    rows.push(['No ILS here', 'this data carries NDB, VOR, VOR-DME, VORTAC, '
      + 'TACAN and DME and nothing else — no localiser, no glideslope, no '
      + 'minima. Those are in the national AIP, and an invented approach would '
      + 'be worse than none.']);
    if (aip) rows.push([aip[0], aip[1]]);
  }
  rows.push(...tail());
  rows.push(['Note', 'frequencies and beacons from OurAirports, which is '
    + 'community-maintained and public domain. It can lag a reallocation, and '
    + 'the AIP above is the authority for the country it belongs to.']);
  showDetail(title, `${ref.big ? 'large' : 'medium'} airport · ${ref.icao || '?'}`, rows);
}

/* ------------------------------------------------------------------ navaids */

let navaidAt = '';

const NAVAID_COLOUR = {
  VOR: '#4fd6ff', 'VOR-DME': '#4fd6ff', VORTAC: '#8ab4ff',
  TACAN: '#ff9f45', DME: '#7dffab', NDB: '#cbd5e1', 'NDB-DME': '#cbd5e1',
};

async function loadNavaids(force) {
  if (!layerOn('navaids')) return;
  const view = viewer.camera.computeViewRectangle();
  if (!view) return;
  const box = {
    south: Cesium.Math.toDegrees(view.south),
    west: Cesium.Math.toDegrees(view.west),
    north: Cesium.Math.toDegrees(view.north),
    east: Cesium.Math.toDegrees(view.east),
  };
  const key = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(1)).join(',');
  if (key === navaidAt && !force) return;
  navaidAt = key;

  let data;
  try {
    data = await getJSON('/api/navaids?'
      + `south=${box.south.toFixed(3)}&west=${box.west.toFixed(3)}`
      + `&north=${box.north.toFixed(3)}&east=${box.east.toFixed(3)}`);
  } catch (err) {
    log(`navaids unavailable (${err.message})`, 'warn');
    return;
  }

  navaidPoints.removeAll();
  if (data.too_wide) {
    setCount('navaids', 0);
    log(`navaids: ${data.note}`, 'warn');
    applyVisibility();
    return;
  }
  for (const n of data.navaids || []) {
    navaidPoints.add({
      position: Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 0),
      pixelSize: n.type === 'NDB' ? 5 : 7,
      color: Cesium.Color.fromCssColorString(
        NAVAID_COLOUR[n.type] || '#8a94a6').withAlpha(0.85),
      outlineColor: Cesium.Color.fromCssColorString('#0b0e14').withAlpha(0.75),
      outlineWidth: 1,
      disableDepthTestDistance: MARK_THROUGH_M,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.4, 4e6, 0.4),
      id: { type: 'navaid', ref: n },
    });
  }
  setCount('navaids', (data.navaids || []).length);
  log(`navaids: ${(data.navaids || []).length} beacons in view · OurAirports`);
  applyVisibility();
}

/* ------------------------------------------------------------------ sweden */

/*
 * Three layers off one key that was already here.
 *
 * Trafikverket's key had been doing exactly one job since it was added: road
 * cameras. The same key and the same endpoint answer for road disruption and
 * for where every train in the country is, which is most of what a Swedish
 * operator would want from this app and none of what it had. SMHI needs no key
 * at all and fills the hole the weather layer admitted to in its own note -
 * "United States only".
 *
 * All three are Swedish and only Swedish. That is stated on every card rather
 * than left for someone to discover by flying to Denmark and finding nothing.
 */

const ROAD_COLOURS = ['#8a94a6', '#ffd166', '#ff9f45', '#ff5c5c'];

// What Trafikverket calls the disruption, in the words it uses. Not translated:
// the app draws what the source says, and "Vagarbete" is what the sign says.
const ROAD_KIND_SHORT = {
  'Vägarbete': 'roadworks',
  'Trafikmeddelande': 'traffic notice',
  'Färjor': 'ferry',
};

async function loadSwedenRoad() {
  try {
    const data = await getJSON('/api/sweden-road');
    swRoad.removeAll();
    if (data.needs_key) {
      setCount('swroad', 0);
      log('sweden road: needs the Trafikverket key · Setup tab', 'warn');
      applyVisibility();
      return;
    }
    if (data.error) {
      setCount('swroad', 0);
      log(`sweden road: ${data.error}`, 'warn');
      applyVisibility();
      return;
    }
    for (const e of data.events) {
      swRoad.add({
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0),
        pixelSize: 5 + e.rank * 2.5,
        color: Cesium.Color.fromCssColorString(
          ROAD_COLOURS[e.rank] || ROAD_COLOURS[0]).withAlpha(0.85),
        outlineColor: Cesium.Color.fromCssColorString('#0b0e14').withAlpha(0.7),
        outlineWidth: 1,
        // Held off the planet by the same 50 km rule the other marks use, so a
        // disruption in Skane does not draw through the globe from Australia.
        disableDepthTestDistance: MARK_THROUGH_M,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 4e6, 0.4),
        id: { type: 'swroad', ref: e },
      });
    }
    setCount('swroad', data.events.length);
    log(`sweden road: ${data.events.length} disruptions · Trafikverket`
      + (data.undrawable
        ? ` · ${data.undrawable} are stretches of road with no single point`
        : ''));
  } catch (err) {
    log(`sweden road feed unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

async function loadSwedenRail() {
  try {
    const data = await getJSON('/api/sweden-rail');
    swRail.removeAll();
    if (data.needs_key) {
      setCount('swrail', 0);
      log('sweden rail: needs the Trafikverket key · Setup tab', 'warn');
      applyVisibility();
      return;
    }
    if (data.error) {
      setCount('swrail', 0);
      log(`sweden rail: ${data.error}`, 'warn');
      applyVisibility();
      return;
    }
    for (const t of data.trains) {
      swRail.add({
        position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, 0),
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString('#5fe3c0').withAlpha(0.9),
        outlineColor: Cesium.Color.fromCssColorString('#0b0e14').withAlpha(0.75),
        outlineWidth: 1,
        disableDepthTestDistance: MARK_THROUGH_M,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.4, 4e6, 0.5),
        id: { type: 'swrail', ref: t },
      });
    }
    setCount('swrail', data.trains.length);
    log(`sweden rail: ${data.trains.length} trains reporting · Trafikverket`
      + (data.dropped_stale
        ? ` · ${data.dropped_stale} stale positions dropped`
        : ''));
  } catch (err) {
    log(`sweden rail feed unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

// Yellow, orange and red are SMHI's own scale and mean specific things to
// anyone in Sweden, so they are kept rather than restyled. Meddelande - the
// level below yellow - is information rather than warning, and is drawn faint.
const SMHI_COLOURS = {
  MESSAGE: '#8ab4ff', YELLOW: '#ffd166', ORANGE: '#ff9f45', RED: '#ff5c5c',
};

async function loadSmhi() {
  try {
    const data = await getJSON('/api/smhi');
    if (smhiPrimitive) {
      scene.primitives.remove(smhiPrimitive);
      smhiPrimitive = null;
    }
    if (data.error) {
      setCount('smhi', 0);
      log(`smhi: ${data.error}`, 'warn');
      applyVisibility();
      return;
    }

    const instances = [];
    for (const w of data.warnings) {
      const rings = w.geometry.type === 'Polygon'
        ? [w.geometry.coordinates]
        : w.geometry.coordinates;
      const colour = Cesium.Color.fromCssColorString(
        SMHI_COLOURS[w.level_code] || SMHI_COLOURS.MESSAGE);
      for (const polygon of rings) {
        const outer = polygon[0];
        if (!outer || outer.length < 3) continue;
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(outer.flat())),
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              colour.withAlpha(w.rank >= 2 ? 0.3 : 0.18)),
          },
          id: { type: 'smhi', ref: w },
        }));
      }
    }

    if (instances.length) {
      // Draped on the ground rather than floated above it, so a warning area
      // follows the terrain and stays readable over satellite imagery.
      smhiPrimitive = scene.primitives.add(new Cesium.GroundPrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true }),
        classificationType: Cesium.ClassificationType.TERRAIN,
      }));
    }
    setCount('smhi', data.warnings.length);
    log(`smhi: ${data.warnings.length} warning areas in force · SMHI, CC BY 4.0`);
  } catch (err) {
    log(`smhi feed unavailable (${err.message})`, 'warn');
  }
  applyVisibility();
}

/* ------------------------------------------------------------ copernicus */

/*
 * Sentinel-2 on a given day, at 10 m, from the user's own Copernicus instance.
 *
 * SENTINEL 10M already in this list is EOX's cloudless mosaic: a year of passes
 * averaged into a basemap with no clouds, no smoke, no ships and no flood in it.
 * Useful, and the wrong tool for asking what happened. These are the other kind
 * - an actual acquisition, with whatever was in the air still in it.
 *
 * Which visualisations exist is not decided here. A Copernicus configuration
 * holds whatever the operator set up in their dashboard, so the server asks the
 * instance and this builds a style per answer. Guessing at names would produce
 * buttons that fetch nothing, which is worse than no button.
 */

const CDSE_WHAT = {
  TRUE_COLOR: 'One acquisition in the colours an eye would see, at 10 m. Unlike the cloudless mosaic this keeps whatever was in the air that week: cloud, smoke, a sediment plume, a flood.',
  FALSE_COLOR: 'Near infrared shown as red, so living vegetation glows and bare ground, roads and buildings go flat. The quickest way to see where something is growing and where it has stopped.',
  COLOR_INFRARED: 'Near infrared shown as red. Healthy vegetation is bright red, stressed or cut vegetation is dull, water is near black. Good for crop damage and for clear-cuts.',
  COLOR_INFRARED__URBAN_: 'Built-up ground separated from vegetation. Concrete, roofs and roads stand out against the landscape, which makes new construction and damage to it visible.',
  SWIR: 'Short-wave infrared at 10 m. It passes through smoke and haze, burnt ground reads dark, and wet ground reads differently from dry. The sharp equivalent of FIRE IR.',
  AGRICULTURE: 'Crop vigour. Fields in good condition read bright, struggling or harvested ones read dull. Field boundaries are unusually clear, which also makes it useful for seeing what land is being worked.',
  GEOLOGY: 'Rock and soil rather than what grows on them. Different minerals take different colours, so faults, bedding and bare ground structure show up that true colour flattens.',
  BATHYMETRIC: 'Shallow water. Depth in the first few metres reads as colour, so sandbanks, reefs and channels near the coast appear. It says nothing about deep water.',
  MOISTURE_INDEX: 'How much water is in the vegetation. Wet reads one way and dry another, which shows drought stress before it is visible in true colour, and shows fire risk with it.',
  VEGETATION_INDEX: 'NDVI: a single number per pixel for how much living plant matter is there. Not a picture but a measurement drawn as one, and the standard way of comparing the same field between two dates.',
  NDVI: 'NDVI: a single number per pixel for how much living plant matter is there. Not a picture but a measurement drawn as one, and the standard way of comparing the same field between two dates.',
  ATMOSPHERIC_PENETRATION: 'No visible light at all, only infrared. Haze and thin cloud largely disappear, at the cost of colours that mean nothing to the eye. For when the air is in the way.',
};

/*
 * A chip is about eighteen characters wide, and Copernicus titles are longer
 * than that: "Color Infrared (vegetation)", "Vegetation Index - NDVI". Cutting
 * at eighteen gives COLOR INFRARED (VE, which reads as a bug.
 *
 * So the parenthetical is dropped - it qualifies rather than names - and where a
 * title carries its own abbreviation after a dash, that abbreviation is the
 * better label. NDVI says more than VEGETATION INDEX in the same space. Only
 * then, and only if still too long, is it cut, and on a word boundary.
 */
const STYLE_SHORT = { ATMOSPHERIC: 'ATMOS' };

function styleLabel(title) {
  let text = String(title || '').trim();

  // "Vegetation Index - NDVI" -> NDVI, when the tail is a real abbreviation.
  const dash = text.split(/\s+[-–]\s+/);
  if (dash.length === 2 && /^[A-Z0-9]{3,8}$/.test(dash[1].trim())) {
    return dash[1].trim().toUpperCase();
  }

  text = text.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  let out = text.toUpperCase().replace(/\s+/g, ' ');
  out = out.split(' ').map((w) => STYLE_SHORT[w] || w).join(' ');
  if (out.length <= 18) return out;

  const words = out.split(' ');
  let cut = '';
  for (const w of words) {
    if ((cut + ' ' + w).trim().length > 18) break;
    cut = (cut + ' ' + w).trim();
  }
  return cut || out.slice(0, 18);
}

async function loadCopernicus() {
  let caps;
  try {
    caps = await getJSON('/api/copernicus');
  } catch (err) {
    log(`copernicus: could not ask the instance (${err.message})`, 'warn');
    return;
  }
  if (caps.needs_key) return;                 // not set up; the Setup tab says how
  if (caps.error) {
    log(`copernicus: ${caps.error}`, 'warn');
    return;
  }
  if (!caps.layers || !caps.layers.length) {
    log('copernicus: the instance is reachable but has no visualisations configured', 'warn');
    return;
  }

  // Web Mercator is the only projection the globe's tile pipeline takes. If the
  // instance offers none, say which it does offer rather than fetch blank tiles.
  // 256 specifically, not merely the first web mercator set on offer. The 512
  // variant exists and numbers its tiles differently at the same zoom, so
  // feeding it the row and column Cesium computes returns 400 - verified
  // against a live instance, where 512 refused and 256 returned the tile.
  // It costs four times the requests for the same ground, and requests are the
  // quota anyone meets first, but a working layer beats a cheap broken one.
  const sets = caps.matrixSets || [];
  const matrix = sets.find((m) => /WebMercator256|3857.*256/.test(m))
    || sets.find((m) => /WebMercator|3857/.test(m) && !/512/.test(m));
  if (!matrix) {
    log('copernicus: this instance offers no web mercator tile matrix set '
      + `(${(caps.matrixSets || []).join(', ') || 'none listed'})`, 'warn');
    return;
  }

  const base = 'https://sh.dataspace.copernicus.eu/ogc/wmts/'
    + encodeURIComponent(caps.instance);
  let added = 0;
  for (const layer of caps.layers) {
    const key = 'cdse_' + layer.id.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (IMAGERY[key]) continue;
    IMAGERY[key] = {
      label: styleLabel(layer.title),
      what: CDSE_WHAT[layer.id] || 'A visualisation from your own Copernicus configuration. What it shows is set in the Sentinel Hub dashboard, not here.',
      url: base
        + '?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile'
        + '&LAYER=' + encodeURIComponent(layer.id)
        + '&TILEMATRIXSET=' + encodeURIComponent(matrix)
        + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}'
        // Every tile came back with the Copernicus logo burned into its
        // corner, which at 256 pixels a tile is a wall of them across the
        // screen rather than an attribution. They will leave it off if
        // asked, and the credit line below carries the attribution where
        // attribution belongs.
        + '&FORMAT=image/jpeg&showLogo=false&TIME={window}',
      // Copernicus Sentinel data is free to use, commercial use included, so
      // long as the modification is declared. That makes these usable in
      // commercial-safe mode, which the sharp Esri imagery is not.
      credit: 'Contains modified Copernicus Sentinel data — '
            + 'Copernicus Data Space Ecosystem',
      max: 16,
      cdse: true,
      openLicence: true,
      tune: { brightness: 1.03, contrast: 1.08, saturation: 1.04, hue: 0.0, gamma: 1.0 },
    };
    added++;
  }
  if (!added) return;
  renderStyles();
  log(`copernicus: ${added} dated Sentinel visualisation(s) · `
    + `${SENTINEL_WINDOW_DAYS}-day window, 10 m`);
}

/* ------------------------------------------------------------------ boot */

renderLayerList();
renderStyles();
loadCopernicus();
applyThrifty(false);
renderPlaces();
applyVisibility();

// Handy for the browser console: gcv.viewer.camera.flyTo(...), gcv.flights, ...
window.gcv = { viewer, scene, flights, vessels, satellites, layers: LAYERS, collections };

scene.canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  log('GPU context lost — reload the page', 'warn');
  $('#classification').textContent = 'GPU CONTEXT LOST // RELOAD THE PAGE';
});

log('boot: local proxy online');

// The build stamp comes from the server, so a stale page cannot claim to be new.
getJSON('/api/version')
  .then((v) => {
    $('#version').textContent = `v${v.version}`;
    $('#version').title = `build ${v.built}` + (v.keys.length ? ` · keys: ${v.keys.join(', ')}` : '');
    const extra = v.keys.length ? ` · keys: ${v.keys.join(', ')}` : '';
    log(`build: v${v.version} (${v.built})${extra}`);
  })
  .catch(() => { $('#version').textContent = 'version unknown'; });

(async function start() {
  // Before any feed: a reload must not silently put a recording back on the
  // sources the operator switched away from. This runs here rather than beside
  // the switch itself because it reads currentStyle, declared further down.
  applySafeMode(false);
  // The slider's initial state was never set, so it looked usable over an
  // undated mosaic. Ask it to describe the style we actually booted with.
  // The viewer was constructed with the default optic before the stored one was
  // known, so if they differ the imagery is rebuilt once here.
  if (currentStyle !== 'ops') {
    rebuildImagery();
    $('#globe').classList.toggle('heat', !!IMAGERY[currentStyle].heat);
    setCrt(IMAGERY[currentStyle].crt);
    setScope(IMAGERY[currentStyle].scope);
    renderStyles();
  }
  setDayOffset(0);
  renderLegend();
  updateMoonReadout();
  renderMeters();
  updatePlace();
  $('#tilt').value = String(viewPitch);
  $('#tilt-out').textContent = viewPitch <= -89 ? 'straight down' : `${Math.abs(viewPitch)}°`;

  for (const layer of LAYERS) bootLayer(layer.id);

  // Not layers: these feed panel readouts that are there whatever is drawn.
  loadSpaceWeather();
  setInterval(loadSpaceWeather, 10 * 60_000);
  // The briefing is assembled on the server, so it does not wait for a layer.
  setTimeout(loadBriefing, 4000);

  setInterval(whileOn('trains', loadTrains), 2 * 60_000);
  setInterval(whileOn('news', loadNewsHeat), 15 * 60_000);
  setInterval(whileOn('netout', loadNetOutages), 10 * 60_000);
  setInterval(whileOn('weather', loadWeatherAlerts), 5 * 60_000);
  setInterval(whileOn('volcanoes', loadVolcanoes), 12 * 3600_000);
  setInterval(whileOn('radio', loadRadios), 30 * 60_000);
  setInterval(whileOn('outbreaks', loadOutbreaks), 6 * 3600_000);
  setInterval(whileOn('quakes', loadQuakes), 600_000);
// Road disruption changes on the scale of a roadworks notice; trains move.
setInterval(whileOn('swroad', loadSwedenRoad), 3 * 60_000);
setInterval(whileOn('swrail', loadSwedenRail), 30_000);
setInterval(whileOn('smhi', loadSmhi), 10 * 60_000);
  setInterval(whileOn(['flights', 'services'], pollFlights), 15_000);
  setInterval(whileOn('vessels', pollVessels), 20_000);

  scene.camera.moveEnd.addEventListener(whileOn(['flights', 'services'], pollFlights));

  setTimeout(() => $('#boot').classList.add('gone'), 1200);
})();
