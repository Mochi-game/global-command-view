/* Deterministic commands: no model, keys, or invented answers. Shared with tests. */
(function (root) {
  'use strict';
  const normalize = text => String(text || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').trim().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  const aliases = {
    flights: ['flights', 'aircraft', 'planes', 'air traffic', 'flyg', 'flygplan', 'flygtrafik'],
    vessels: ['ships', 'vessels', 'boats', 'fartyg', 'batar'],
    cameras: ['cameras', 'public cameras', 'kameror'],
    quakes: ['earthquakes', 'quakes', 'jordbavningar'],
    fires: ['fires', 'wildfires', 'brander'],
    satellites: ['satellites', 'satelliter'],
    radar: ['rain', 'rain radar', 'regn', 'regnradar'],
    forecast: ['weather', 'forecast', 'vader', 'vaderprognos'],
    names: ['names', 'borders', 'names & borders', 'ortnamn', 'granser'],
    swrail: ['swedish trains', 'tag', 'tag i sverige'],
    smhi: ['smhi', 'smhi warnings', 'vadervarningar'],
    broadcast: ['radio', 'radio stations', 'radiostationer'],
    cables: ['cables', 'submarine cables', 'undervattenskablar'],
  };
  function resolveLayer(text, layers) {
    const q = normalize(text);
    return layers.find(l => [l.id, l.name, ...(aliases[l.id] || [])].some(n => normalize(n) === q));
  }
  function parse(text, layers) {
    const q = normalize(text);
    if (!q) return { type: 'empty' };
    if (/^(help|hjalp|what can you do|vad kan du gora)$/.test(q)) return { type: 'help' };
    if (/^(status|briefing|summary|sammanfatta|sammanfattning|lagesbild)$/.test(q)) return { type: 'status' };
    if (/^(globe|world|home|glob|globen|varlden|visa hela varlden)$/.test(q)) return { type: 'home' };
    if (/^(hide all|clear map|dolj alla|stang av alla)$/.test(q)) return { type: 'clear' };
    if (/^(undo|angra)$/.test(q)) return { type: 'undo' };
    if (/^(zoom in|zooma in)$/.test(q)) return { type: 'zoom', direction: 1 };
    if (/^(zoom out|zooma ut)$/.test(q)) return { type: 'zoom', direction: -1 };
    const go = q.match(/^(?:go to|fly to|find|goto|visa platsen|flyg till|ga till|sok)\s+(.+)$/);
    if (go) return { type: 'place', query: go[1] };
    const change = q.match(/^(show|enable|turn on|visa|aktivera|sla pa|hide|disable|turn off|dolj|stang av)\s+(.+)$/);
    if (change) {
      const on = !/^(hide|disable|turn off|dolj|stang av)$/.test(change[1]);
      const exact = resolveLayer(change[2], layers);
      if (exact) return { type: 'layer', id: exact.id, on };
      const at = change[2].match(/^(.+?)\s+(?:in|near|over|i|vid|nara)\s+(.+)$/);
      const layer = at && resolveLayer(at[1], layers);
      if (layer && on) return { type: 'layer', id: layer.id, on, query: at[2] };
      return { type: 'unknown' };
    }
    const layer = resolveLayer(q, layers);
    if (layer) return { type: 'layer', id: layer.id, on: true };
    // Bare place names are deliberately explicit to avoid sending arbitrary chat to a geocoder.
    return { type: 'unknown' };
  }
  function validView(view) {
    return view && typeof view.name === 'string' && view.name.length <= 60
      && Array.isArray(view.layers) && view.layers.every(id => typeof id === 'string')
      && ['lon', 'lat', 'height', 'heading', 'pitch', 'roll'].every(k => Number.isFinite(view[k]))
      && Math.abs(view.lon) <= 180 && Math.abs(view.lat) <= 90 && view.height >= 50 && view.height <= 5e7;
  }
  const api = { normalize, aliases, resolveLayer, parse, validView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCVCommands = api;
})(typeof window === 'undefined' ? globalThis : window);
