import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin } from '@kiosko/sdk';
import { normalize, Registry, Runtime } from '@kiosko/core';
import { HomeAssistantBridge, pageOptions, slug } from './homeassistant.ts';
import { MqttClient } from './mqtt.ts';
import { startBroker } from './mqtt-broker.test-helper.ts';

process.env.KIOSKO_QUIET = '1';

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
  assert.ok(cond(), 'timed out');
};

const page = (id: string, name: string) => ({ id, name, grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [] });
function kiosko(port: number, extra: Record<string, unknown> = {}) {
  const reg = new Registry();
  reg.add(definePlugin({ id: 'i', name: 'I', version: '1', interludes: [{ id: 'show', name: { en: 'Show', es: 'Función' }, fps: 10, prepare: async () => ({ frames: 3, draw: () => undefined }) }] }));
  const cfg = normalize({
    locale: 'en',
    homeassistant: { enabled: true, broker: `mqtt://127.0.0.1:${port}`, username: 'k', password: 'p', nodeId: 'desk' },
    screens: [
      { id: 'panel1', name: 'Cats', width: 64, height: 32, device: { driver: 'virtual' }, pages: [page('home', 'Home'), page('cam', 'Camera'), page('dup', 'Home')], interludes: [{ id: 'run', type: 'i/show', enabled: false, everyMs: 3_600_000 }] },
      { id: 'news', name: 'News', width: 64, height: 32, device: { driver: 'virtual' }, pages: [page('n', 'News')] },
    ],
    ...extra,
  });
  return new Runtime(reg, cfg);
}

test('page options: Auto first, then the enabled pages; a repeated name gets a number', () => {
  const rt = kiosko(1);
  const { options, byName } = pageOptions(rt.config.screens[0]!, 'Auto');
  assert.deepEqual(options, ['Auto', 'Home', 'Camera', 'Home (2)']);
  assert.equal(byName.get('Auto'), null);
  assert.equal(byName.get('Home (2)'), 'dup');
  assert.equal(slug('Pizarra y GitLab Ñ'), 'pizarra_y_gitlab_n');
});

test('Home Assistant sees a device per screen and drives it: page, display, interludes', async () => {
  const broker = await startBroker({ users: { k: 'p' } });
  const rt = kiosko(broker.port);
  rt.start();
  const bridge = new HomeAssistantBridge(rt, '9.9.9');
  // Home Assistant's side.
  const ha = new MqttClient({ url: `mqtt://127.0.0.1:${broker.port}`, clientId: 'ha', username: 'k', password: 'p' });
  const seen = new Map<string, string>();
  ha.on('connect', () => ha.subscribe(['homeassistant/#', 'kiosko/#']));
  ha.on('message', (t: string, p: string) => seen.set(t, p));
  try {
    await until(() => bridge.status().state === 'connected' && ha.connected);
    assert.deepEqual(bridge.status(), { enabled: true, state: 'connected', error: null, broker: `mqtt://127.0.0.1:${broker.port}` });
    await until(() => seen.has('homeassistant/button/desk/panel1_run/config') && seen.has('kiosko/desk/news/display'));
    const select = JSON.parse(seen.get('homeassistant/select/desk/panel1_page/config')!);
    assert.deepEqual(select.options, ['Auto', 'Home', 'Camera', 'Home (2)']);
    assert.equal(select.command_topic, 'kiosko/desk/panel1/page/set');
    assert.equal(select.availability_topic, 'kiosko/desk/status');
    assert.deepEqual(select.device, { identifiers: ['kiosko_desk_panel1'], name: 'Kiosko Cats', manufacturer: 'Kiosko', model: '64×32', sw_version: '9.9.9' });
    assert.equal(JSON.parse(seen.get('homeassistant/button/desk/panel1_run/config')!).name, 'Play: Show');
    assert.equal(broker.retained.get('kiosko/desk/status'), 'online');
    assert.equal(seen.get('kiosko/desk/panel1/page'), 'Auto');
    // The page on the panel now (they take turns by the clock): its name.
    const names: Record<string, string> = { home: 'Home', cam: 'Camera', dup: 'Home (2)' };
    await until(() => !!rt.status().screens[0]!.page && seen.get('kiosko/desk/panel1/shown') === names[rt.status().screens[0]!.page!]);

    // Pin a page: the screen shows it, and says so.
    ha.publish('kiosko/desk/panel1/page/set', 'Camera');
    await until(() => rt.status().screens[0]!.pinned === 'cam');
    await until(() => seen.get('kiosko/desk/panel1/page') === 'Camera' && seen.get('kiosko/desk/panel1/shown') === 'Camera');
    ha.publish('kiosko/desk/panel1/page/set', 'Auto');
    await until(() => rt.status().screens[0]!.pinned === null);
    // Something that isn't an option is ignored.
    ha.publish('kiosko/desk/panel1/page/set', 'Nope');

    // Off and on again.
    ha.publish('kiosko/desk/news/display/set', 'OFF');
    await until(() => rt.status().screens[1]!.off && seen.get('kiosko/desk/news/display') === 'OFF');
    ha.publish('kiosko/desk/news/display/set', 'ON');
    await until(() => !rt.status().screens[1]!.off && seen.get('kiosko/desk/news/display') === 'ON');

    // An interlude, now.
    const frames: string[] = [];
    rt.on('frame', (f: { interlude: string | null }) => f.interlude && frames.push(f.interlude));
    ha.publish('kiosko/desk/panel1/interlude/run/press', 'PRESS');
    await until(() => frames.includes('i/show'));

    // A page removed from the config: its option goes; a screen removed: its entities go.
    rt.apply(normalize({ ...rt.config, screens: [rt.config.screens[0]!] }));
    await until(() => broker.published.some((p) => p.topic === 'homeassistant/select/desk/news_page/config' && p.payload === '' && p.retain));
    assert.equal(broker.retained.has('homeassistant/switch/desk/news_display/config'), false);

    // Switched off in the config: offline, and gone.
    rt.apply(normalize({ ...rt.config, homeassistant: { ...rt.config.homeassistant!, enabled: false } }));
    await until(() => broker.retained.get('kiosko/desk/status') === 'offline');
    assert.deepEqual(bridge.status(), { enabled: false, state: 'off', error: null });
  } finally {
    bridge.stop();
    ha.close();
    rt.stop();
    await broker.close();
  }
});

test('Home Assistant restarting: everything is announced again', async () => {
  const broker = await startBroker();
  const rt = kiosko(broker.port, { homeassistant: { enabled: true, broker: '', nodeId: 'desk' } });
  rt.apply(normalize({ ...rt.config, homeassistant: { enabled: true, broker: `mqtt://127.0.0.1:${broker.port}`, nodeId: 'desk' } }));
  const bridge = new HomeAssistantBridge(rt, '1');
  const ha = new MqttClient({ url: `mqtt://127.0.0.1:${broker.port}`, clientId: 'ha' });
  try {
    await until(() => bridge.status().state === 'connected' && ha.connected);
    await until(() => broker.published.some((p) => p.topic.endsWith('panel1_page/config')));
    const before = broker.published.filter((p) => p.topic.endsWith('panel1_page/config')).length;
    ha.publish('homeassistant/status', 'online');
    await until(() => broker.published.filter((p) => p.topic.endsWith('panel1_page/config')).length > before);
  } finally {
    bridge.stop();
    ha.close();
    await broker.close();
  }
});

test('Home Assistant sees Kiosko\'s alerts: the highest in a sensor, and one button acknowledges them all', async () => {
  const broker = await startBroker({ users: { k: 'p' } });
  const rt = kiosko(broker.port);
  rt.start();
  const bridge = new HomeAssistantBridge(rt, '9.9.9');
  const ha = new MqttClient({ url: `mqtt://127.0.0.1:${broker.port}`, clientId: 'ha', username: 'k', password: 'p' });
  const seen = new Map<string, string>();
  ha.on('connect', () => ha.subscribe(['homeassistant/#', 'kiosko/#']));
  ha.on('message', (t: string, p: string) => seen.set(t, p));
  try {
    await until(() => seen.has('homeassistant/button/desk/alerts_ack/config') && seen.get('kiosko/desk/alerts/top') === '—');
    const button = JSON.parse(seen.get('homeassistant/button/desk/alerts_ack/config')!);
    assert.equal(button.name, 'Acknowledge alerts');
    assert.equal(button.command_topic, 'kiosko/desk/alerts/ack/press');
    assert.deepEqual(button.device.identifiers, ['kiosko_desk']);
    const sensor = JSON.parse(seen.get('homeassistant/sensor/desk/alert/config')!);
    assert.equal(sensor.json_attributes_topic, 'kiosko/desk/alerts/attributes');
    assert.deepEqual(JSON.parse(seen.get('kiosko/desk/alerts/attributes')!), { level: 'none', count: 0 });

    rt.postAlert({ id: 'leak', level: 'warn', title: 'Water leak', text: 'Bathroom' });
    rt.postAlert({ id: 'smoke', level: 'critical', title: 'Smoke', dismissible: false });
    await until(() => seen.get('kiosko/desk/alerts/top') === 'Smoke');
    assert.deepEqual({ ...JSON.parse(seen.get('kiosko/desk/alerts/attributes')!), since: 0 }, { level: 'critical', text: '', id: 'smoke', count: 2, since: 0 });

    // The button: every alert that can be is seen; the one that can't stays.
    ha.publish('kiosko/desk/alerts/ack/press', 'PRESS');
    await until(() => rt.listAlerts().length === 1);
    assert.equal(rt.listAlerts()[0]!.id, 'smoke');
    rt.removeAlert('smoke');
    await until(() => seen.get('kiosko/desk/alerts/top') === '—');
  } finally {
    bridge.stop();
    ha.close();
    rt.stop();
    await broker.close();
  }
});
