/* Discoverable controls layered on the existing globe and feed loaders. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const dialog = el('command-dialog');
  const input = el('command-input');
  const presets = [
    { name: 'Aviation', icon: '↗', description: 'Follow aircraft across Europe', layers: ['names', 'flights'], lon: 12, lat: 51, height: 3300000 },
    { name: 'Oceans', icon: '≈', description: 'Explore Baltic shipping', layers: ['names', 'vessels'], lon: 22, lat: 59, height: 800000 },
    { name: 'Our planet', icon: '◎', description: 'Earthquakes & erupting volcanoes', layers: ['names', 'quakes', 'volcanoes'], lon: 125, lat: 15, height: 22000000 },
    { name: 'Sweden', icon: '⌁', description: 'SMHI warnings & rain radar', layers: ['names', 'smhi', 'radar'], lon: 16, lat: 62, height: 1600000 },
  ];
  let undo = null;
  let busy = false;
  let recognition = null;
  let listening = false;
  let speechTimer;
  let toastTimer;
  function notify(message) {
    const toast = el('experience-toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6500);
  }
  function reply(message) {
    el('command-reply').textContent = message;
    if (dialog.open && el('voice-reply').checked && !listening && 'speechSynthesis' in window) {
      speechSynthesis.cancel();
      const speech = new SpeechSynthesisUtterance(message);
      // Interface replies are English, independently of recognition language.
      speech.lang = 'en-US';
      speechSynthesis.speak(speech);
    }
  }
  function capture(name = 'Previous view') {
    const p = viewer.camera.positionCartographic;
    return { name, lon: Cesium.Math.toDegrees(p.longitude), lat: Cesium.Math.toDegrees(p.latitude),
      height: p.height, heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: viewer.camera.roll,
      layers: LAYERS.filter(l => l.on).map(l => l.id) };
  }
  function setLayers(ids) {
    const wanted = new Set(ids);
    const starting = LAYERS.filter(l => wanted.has(l.id) && !l.on);
    for (const layer of LAYERS) layer.on = wanted.has(layer.id);
    applyVisibility();
    renderLayerList();
    rememberLayers();
    for (const layer of starting) bootLayer(layer.id);
  }
  function fly(view) {
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      orientation: { heading: view.heading || 0, pitch: view.pitch ?? -Math.PI / 2, roll: view.roll || 0 },
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1.8,
      complete: carryCameraInto3D });
  }
  function restore(view) { setLayers(view.layers); fly(view); }
  function open() {
    if (!el('welcome').hidden) closeWelcome();
    if (!dialog.open) dialog.showModal();
    input.focus();
  }
  function stopSpeech() {
    clearTimeout(speechTimer);
    if (recognition) recognition.abort();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
  dialog.addEventListener('close', stopSpeech);
  el('command-open').onclick = open;
  el('command-close').onclick = () => dialog.close();
  dialog.addEventListener('click', e => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    }
  });
  // Capture before globe shortcuts so typing never moves the camera.
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); e.stopImmediatePropagation(); dialog.open ? dialog.close() : open();
    } else if (dialog.open) e.stopImmediatePropagation();
  }, true);
  el('layer-filter').oninput = renderLayerList;
  el('layers-active').onchange = renderLayerList;
  const panelButton = el('panel-toggle');
  function showPanel(show) {
    document.body.classList.toggle('panel-hidden', !show);
    panelButton.setAttribute('aria-expanded', String(show));
    el('panel').inert = !show;
  }
  panelButton.onclick = () => showPanel(document.body.classList.contains('panel-hidden'));
  if (matchMedia('(max-width: 700px)').matches) showPanel(false);
  for (const id of ['quick-presets', 'welcome-presets']) {
    for (const preset of presets) {
      const button = document.createElement('button');
      button.className = 'preset-card';
      button.innerHTML = `<span class="preset-icon" aria-hidden="true">${preset.icon}</span><span><strong>${preset.name}</strong><small>${preset.description}</small></span><span class="preset-arrow" aria-hidden="true">↗</span>`;
      button.onclick = () => {
        if (busy) return notify('Please wait for the place search to finish.');
        undo = capture();
        restore(preset);
        if (!el('welcome').hidden) closeWelcome();
        notify(`${preset.name}: ${preset.layers.length} layers enabled. Commands → Undo restores your previous view.`);
        if (matchMedia('(max-width: 700px)').matches) showPanel(false);
      };
      el(id).append(button);
    }
  }
  const suggestions = ['visa flyg i Stockholm', 'go to London', 'show earthquakes', 'sammanfatta', 'zoom out', 'help'];
  for (const text of suggestions) {
    const button = document.createElement('button');
    button.textContent = text;
    button.onclick = () => { input.value = text; input.focus(); };
    el('command-suggestions').append(button);
  }
  function summary() {
    const active = LAYERS.filter(l => l.on);
    if (!active.length) return 'No layers are active yet. Choose an exploration mode or try “visa flyg”.';
    return `${active.length} active layers. ` + active.map(l =>
      `${l.name}: ${l.noCount ? 'enabled (map overlay or click tool)' : l.count === null ? 'source unavailable' : l.count === 0 ? '0 reported so far; the feed may still be loading' : `${l.count.toLocaleString('en-US')} reported`}`
    ).join('. ') + '. Counts describe loaded feed records, not necessarily everything in the current view. See each layer’s source for coverage.';
  }
  async function execute(text) {
    const command = GCVCommands.parse(text, LAYERS);
    switch (command.type) {
      case 'empty': return 'Enter a command first.';
      case 'help': return 'Try “go to Stockholm”, “visa flyg i Stockholm”, “show ships”, “dölj flyg”, “zoom in”, “globe”, “sammanfatta” or “ångra”. Commands control this map; they do not answer general questions. Bare place names need “go to” or “gå till”.';
      case 'unknown': return 'I did not recognise that command. Use “go to” before a place, or “show” / “visa” before a layer. Try “help” for examples.';
      case 'status': return summary();
      case 'undo':
        if (!undo) return 'There is no command or preset to undo yet.';
        restore(undo); undo = null; return 'Previous camera position and layers restored.';
      case 'clear': undo = capture(); setLayers([]); return 'All layers hidden. Use Undo to restore them.';
      case 'home': undo = capture(); fly({ lon: 12, lat: 30, height: 24000000 }); return 'Returning to the globe.';
      case 'zoom': {
        undo = capture();
        fly({ ...undo, height: clamp(undo.height * (command.direction === 1 ? 0.45 : 2.2), 50, 5e7) });
        return command.direction === 1 ? 'Zooming in.' : 'Zooming out.';
      }
      case 'place': {
        const previous = capture();
        const result = await flyToQuery(command.query);
        if (result?.ok) undo = previous;
        return result?.message || 'No destination found.';
      }
      case 'layer': {
        const previous = capture();
        if (command.query) {
          const result = await flyToQuery(command.query);
          if (!result?.ok) return result?.message || 'No destination found; layers were not changed.';
        }
        undo = previous;
        const wanted = new Set(LAYERS.filter(l => l.on).map(l => l.id));
        command.on ? wanted.add(command.id) : wanted.delete(command.id);
        setLayers([...wanted]);
        const layer = LAYERS.find(l => l.id === command.id);
        return `${layer.name} ${command.on ? 'enabled' : 'hidden'}${command.query ? ` near ${command.query}` : ''}. ${command.on ? `Source: ${layer.note}` : ''}`;
      }
    }
  }
  el('command-form').onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    stopSpeech(); busy = true;
    el('command-submit').disabled = true;
    el('command-undo').disabled = true;
    el('command-reply').setAttribute('aria-busy', 'true');
    reply('Working…');
    try { reply(await execute(input.value)); }
    catch (error) { reply(`Could not complete the command: ${error.message}. Try again or use the layer panel.`); }
    finally {
      busy = false; el('command-submit').disabled = false; el('command-undo').disabled = false;
      el('command-reply').setAttribute('aria-busy', 'false');
    }
  };
  el('command-undo').onclick = async () => { if (!busy) reply(await execute('undo')); };
  // Bookmarks remain local and validate persisted data before moving the camera.
  const storeKey = 'gcv-explorer-views-v1';
  let saved = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(storeKey) || '[]');
    if (Array.isArray(parsed)) saved = parsed.filter(GCVCommands.validView).slice(0, 8);
  } catch (_) { /* recover from unavailable or malformed storage */ }
  function persist(next) {
    try { localStorage.setItem(storeKey, JSON.stringify(next)); saved = next; renderSaved(); return true; }
    catch (_) { reply('This browser could not save the view. Storage may be disabled or full.'); return false; }
  }
  function renderSaved() {
    const list = el('saved-views-list'); list.replaceChildren();
    el('saved-count').textContent = `(${saved.length}/8)`;
    if (!saved.length) { const p = document.createElement('p'); p.textContent = 'Your favourite places will appear here.'; list.append(p); }
    saved.forEach((view, index) => {
      const row = document.createElement('div'); row.className = 'saved-row';
      const go = document.createElement('button'); go.textContent = `${view.name} · ${view.layers.length} layers`;
      go.onclick = () => { if (busy) return; undo = capture(); restore(view); reply(`Opened ${view.name}.`); };
      const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove saved view ${view.name}`);
      remove.onclick = () => persist(saved.filter((_, i) => i !== index));
      row.append(go, remove); list.append(row);
    });
  }
  el('save-view-form').onsubmit = e => {
    e.preventDefault();
    const name = el('save-view-name').value.trim();
    if (!name) return;
    if (saved.length >= 8) return reply('You have 8 saved views. Remove one to make room.');
    const view = capture(name);
    if (!GCVCommands.validView(view)) return reply('Move the camera above ground before saving this view.');
    if (persist([...saved, view])) { el('save-view-name').value = ''; reply(`Saved “${name}” in this browser.`); }
  };
  el('saved-open').onclick = () => { open(); dialog.querySelector('details').open = true; el('save-view-name').focus(); };
  renderSaved();
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = el('voice-start');
  if (!SpeechRecognition || !window.isSecureContext) {
    mic.disabled = true;
    el('voice-note').textContent = 'Speech input is not available in this browser or connection. All commands work by typing. Use a browser with speech recognition on localhost or HTTPS.';
  } else {
    mic.onclick = () => {
      if (listening) { recognition?.stop(); return; }
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      recognition = new SpeechRecognition();
      recognition.lang = el('voice-language').value;
      recognition.continuous = false;
      recognition.interimResults = true;
      listening = true; mic.textContent = '■ Stop listening'; mic.setAttribute('aria-pressed', 'true');
      reply('Listening… Speak one command. You can review it before pressing Run.');
      recognition.onresult = event => {
        input.value = Array.from(event.results, result => result[0].transcript).join(' ').slice(0, 180);
        if (event.results[event.results.length - 1].isFinal) reply('Transcript ready. Edit if needed, then press Run.');
      };
      recognition.onerror = event => {
        const messages = { 'not-allowed': 'Microphone access was not allowed. Type your command or allow the microphone in browser settings.', 'no-speech': 'No speech detected. Try again or type your command.', 'audio-capture': 'No microphone is available. Check your input device or type instead.', 'network': 'The speech service could not be reached. Type your command instead.', 'language-not-supported': 'This speech service does not support the selected language. Try another language or type.' };
        if (event.error !== 'aborted') reply(messages[event.error] || `Speech input stopped (${event.error}). You can still type.`);
      };
      recognition.onend = () => {
        clearTimeout(speechTimer);
        listening = false; mic.textContent = '◉ Speak'; mic.setAttribute('aria-pressed', 'false');
        if (el('command-reply').textContent.startsWith('Listening…')) reply('Listening stopped. Type a command or press Speak to try again.');
      };
      try { recognition.start(); speechTimer = setTimeout(() => recognition?.stop(), 20000); }
      catch (_) { listening = false; mic.textContent = '◉ Speak'; mic.setAttribute('aria-pressed', 'false'); reply('Speech input could not start. Please type your command.'); }
    };
  }
  if (!('speechSynthesis' in window)) el('voice-reply').disabled = true;
  el('voice-reply').onchange = () => { if (!el('voice-reply').checked && 'speechSynthesis' in window) speechSynthesis.cancel(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
})();
