const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const commands = require('../web/commands.js');
const app = fs.readFileSync(require.resolve('../web/app.js'), 'utf8');
const layerSource = app.slice(app.indexOf('const LAYERS = ['), app.indexOf('\n];', app.indexOf('const LAYERS = [')) + 3);
const layers = vm.runInNewContext(layerSource + '\nLAYERS');

test('Swedish accents, punctuation and spoken spacing', () => {
  assert.deepEqual(commands.parse('  VISA   FLYG i Göteborg! ', layers), { type: 'layer', id: 'flights', on: true, query: 'goteborg' });
  assert.deepEqual(commands.parse('Dölj flyg.', layers), { type: 'layer', id: 'flights', on: false });
  assert.deepEqual(commands.parse('Ångra', layers), { type: 'undo' });
});
test('every actual layer is addressable by exact name', () => {
  for (const layer of layers) assert.equal(commands.parse(`show ${layer.name}`, layers).id, layer.id, layer.name);
});
test('exact aliases take priority over embedded location words', () => {
  assert.deepEqual(commands.parse('visa tåg i Sverige', layers), { type: 'layer', id: 'swrail', on: true });
  assert.deepEqual(commands.parse('show ships near Helsinki', layers), { type: 'layer', id: 'vessels', on: true, query: 'helsinki' });
});
test('unknown or conversational input does not silently become a location request', () => {
  for (const text of ['what is happening in the world', 'show secret bases', 'Stockholm', '<script>alert(1)</script>', 'hide aircraft in Stockholm']) {
    assert.equal(commands.parse(text, layers).type, 'unknown');
  }
  assert.deepEqual(commands.parse('go to 59.33, 18.07', layers), { type: 'place', query: '59.33, 18.07' });
});
test('basic commands and empty input', () => {
  for (const [text, type] of [['sammanfatta', 'status'], ['globe', 'home'], ['stäng av alla', 'clear'], ['hjälp', 'help'], ['', 'empty']]) assert.equal(commands.parse(text, layers).type, type);
  assert.deepEqual(commands.parse('zooma ut', layers), { type: 'zoom', direction: -1 });
});
test('persisted camera views reject corrupt or unsafe coordinates', () => {
  const valid = { name: 'Stockholm', lon: 18, lat: 59, height: 40000, heading: 0, pitch: -1.5, roll: 0, layers: ['flights'] };
  assert.ok(commands.validView(valid));
  for (const patch of [{ lon: 181 }, { lat: -91 }, { height: -1 }, { height: 1e10 }, { pitch: null }, { layers: 'flights' }, { name: 'x'.repeat(61) }]) assert.ok(!commands.validView({ ...valid, ...patch }));
});
