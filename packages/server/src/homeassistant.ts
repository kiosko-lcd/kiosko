/**
 * Kiosko as a device in Home Assistant, over MQTT discovery. Each screen is a
 * device with:
 *
 * - a select, "Page": Auto (the screen's own rotation) or a page, pinned;
 * - a sensor, "Page shown": the one on the panel now;
 * - a switch, "Display": off = black until switched on again (not saved);
 * - a button per interlude: plays it now.
 *
 * So an automation can show the camera page when the doorbell rings, or turn
 * the panels off when nobody is home. Everything is announced again on every
 * (re)connection and config change; what disappeared from the config is
 * removed from Home Assistant (an empty retained config).
 */
import { hostname } from 'node:os';
import { localize, type Localized } from '@kiosko/sdk';
import { resolveLocale, type Config, type HomeAssistantLink, type Runtime, type Screen } from '@kiosko/core';
import { MqttClient, type MqttOptions, type MqttState } from './mqtt.ts';

export interface BridgeStatus {
  enabled: boolean;
  state: MqttState | 'off';
  error: string | null;
  broker?: string;
}

/** What the bridge needs of an MQTT client (a fake in the tests). */
export interface MqttLike {
  state: MqttState;
  error: string | null;
  connected: boolean;
  publish(topic: string, payload: string, retain?: boolean): void;
  subscribe(topics: string[]): void;
  close(): void;
  on(event: 'connect', fn: () => void): unknown;
  on(event: 'message', fn: (topic: string, payload: string) => void): unknown;
}

const AUTO = { en: 'Auto', es: 'Automática', 'zh-Hant': '自動', 'zh-Hans': '自动' };
const NAMES = {
  page: { en: 'Page', es: 'Página', 'zh-Hant': '頁面', 'zh-Hans': '页面' },
  shown: { en: 'Page shown', es: 'Página en pantalla', 'zh-Hant': '目前頁面', 'zh-Hans': '当前页面' },
  display: { en: 'Display', es: 'Pantalla', 'zh-Hant': '螢幕', 'zh-Hans': '屏幕' },
  interlude: { en: 'Play', es: 'Reproducir', 'zh-Hant': '播放', 'zh-Hans': '播放' },
};

/** A safe piece of a topic or an id: letters, digits, _ and -. */
export const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** Page names as options: unique (a repeated name gets " (2)"), each with its page. */
export function pageOptions(screen: Screen, auto: string): { options: string[]; byName: Map<string, string | null>; nameOf: Map<string, string> } {
  const byName = new Map<string, string | null>([[auto, null]]);
  const nameOf = new Map<string, string>();
  for (const p of screen.pages.filter((x) => x.enabled)) {
    let name = p.name.trim() || p.id;
    for (let i = 2; byName.has(name); i++) name = `${p.name} (${i})`;
    byName.set(name, p.id);
    nameOf.set(p.id, name);
  }
  return { options: [...byName.keys()], byName, nameOf };
}

export class HomeAssistantBridge {
  private client: MqttLike | null = null;
  private link: HomeAssistantLink | null = null;
  /** Discovery topics announced, to remove the ones that disappear. */
  private announced = new Set<string>();
  /** Last state published per topic: only changes go out. */
  private last = new Map<string, string>();
  private readonly onFrame = () => this.publishStates();
  private readonly onConfig = (cfg: Config) => this.apply(cfg);
  private readonly onScreen = () => this.publishStates();

  private readonly runtime: Runtime;
  private readonly version: string;
  private readonly makeClient: (o: MqttOptions) => MqttLike;

  constructor(runtime: Runtime, version: string, makeClient: (o: MqttOptions) => MqttLike = (o) => new MqttClient(o)) {
    this.runtime = runtime;
    this.version = version;
    this.makeClient = makeClient;
    runtime.on('frame', this.onFrame);
    runtime.on('config', this.onConfig);
    runtime.on('screen', this.onScreen);
    this.apply(runtime.config);
  }

  status(): BridgeStatus {
    if (!this.link?.enabled) return { enabled: false, state: 'off', error: null };
    return { enabled: true, state: this.client?.state ?? 'connecting', error: this.client?.error ?? null, broker: this.link.broker };
  }

  stop(): void {
    this.runtime.off('frame', this.onFrame);
    this.runtime.off('config', this.onConfig);
    this.runtime.off('screen', this.onScreen);
    this.disconnect();
  }

  private get base() {
    return `kiosko/${this.link!.nodeId}`;
  }

  private loc(l: Localized) {
    return localize(l, resolveLocale(this.runtime.config));
  }

  /** A new config: connect, reconnect (other broker or login) or just announce again. */
  private apply(cfg: Config) {
    const want = cfg.homeassistant?.enabled && cfg.homeassistant.broker ? cfg.homeassistant : null;
    const same = (a: HomeAssistantLink | null, b: HomeAssistantLink | null) => JSON.stringify(a) === JSON.stringify(b);
    if (!want) {
      this.disconnect();
      this.link = null;
      return;
    }
    if (this.client && same(this.link, want)) {
      this.announce();
      return;
    }
    this.disconnect();
    this.link = want;
    const base = `kiosko/${want.nodeId}`;
    const c = this.makeClient({
      url: want.broker,
      clientId: `kiosko-${want.nodeId}-${hostname().slice(0, 20)}`.slice(0, 23),
      ...(want.username ? { username: want.username } : {}),
      ...(want.password ? { password: want.password } : {}),
      keepalive: 30,
      will: { topic: `${base}/status`, payload: 'offline', retain: true },
    });
    this.client = c;
    c.on('connect', () => {
      if (this.client !== c) return;
      this.last.clear();
      c.publish(`${base}/status`, 'online', true);
      c.subscribe([`${base}/+/page/set`, `${base}/+/display/set`, `${base}/+/interlude/+/press`, `${this.link!.discoveryPrefix}/status`]);
      this.announce();
    });
    c.on('message', (topic, payload) => this.client === c && this.onMessage(topic, payload));
  }

  private disconnect() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    if (c.connected && this.link) c.publish(`${this.base}/status`, 'offline', true);
    c.close();
    this.announced.clear();
    this.last.clear();
  }

  /** Every entity's discovery config, and its state. */
  private announce() {
    const c = this.client;
    if (!c?.connected || !this.link) return;
    const cfg = this.runtime.config;
    const prefix = this.link.discoveryPrefix;
    const node = this.link.nodeId;
    const now = new Set<string>();
    const put = (component: string, objectId: string, body: Record<string, unknown>) => {
      const topic = `${prefix}/${component}/${node}/${objectId}/config`;
      now.add(topic);
      c.publish(topic, JSON.stringify(body), true);
    };
    const availability = { availability_topic: `${this.base}/status` };
    for (const screen of cfg.screens) {
      const sid = slug(screen.id);
      const device = {
        identifiers: [`kiosko_${node}_${sid}`],
        name: `Kiosko ${screen.name}`,
        manufacturer: 'Kiosko',
        model: `${screen.width}×${screen.height}`,
        sw_version: this.version,
      };
      const id = (what: string) => `kiosko_${node}_${sid}_${what}`;
      const { options } = pageOptions(screen, this.loc(AUTO));
      put('select', `${sid}_page`, {
        name: this.loc(NAMES.page), unique_id: id('page'), icon: 'mdi:book-open-page-variant',
        command_topic: `${this.base}/${sid}/page/set`, state_topic: `${this.base}/${sid}/page`, options, device, ...availability,
      });
      put('sensor', `${sid}_shown`, {
        name: this.loc(NAMES.shown), unique_id: id('shown'), icon: 'mdi:monitor-eye',
        state_topic: `${this.base}/${sid}/shown`, device, ...availability,
      });
      put('switch', `${sid}_display`, {
        name: this.loc(NAMES.display), unique_id: id('display'), icon: 'mdi:monitor',
        command_topic: `${this.base}/${sid}/display/set`, state_topic: `${this.base}/${sid}/display`, payload_on: 'ON', payload_off: 'OFF', device, ...availability,
      });
      for (const slot of screen.interludes) {
        const def = this.runtime.registry.interlude(slot.type);
        const name = def ? this.loc(def.name) || slot.type : slot.type;
        put('button', `${sid}_${slug(slot.id)}`, {
          name: `${this.loc(NAMES.interlude)}: ${name}`, unique_id: id(slug(slot.id)), icon: 'mdi:play-circle-outline',
          command_topic: `${this.base}/${sid}/interlude/${slot.id}/press`, payload_press: 'PRESS', device, ...availability,
        });
      }
    }
    // Gone from the config: gone from Home Assistant.
    for (const topic of this.announced) if (!now.has(topic)) c.publish(topic, '', true);
    this.announced = now;
    this.last.clear();
    this.publishStates();
  }

  /** Each screen's page (chosen and shown) and display, when they change. */
  private publishStates() {
    const c = this.client;
    if (!c?.connected || !this.link) return;
    const status = this.runtime.status();
    for (const screen of this.runtime.config.screens) {
      const sid = slug(screen.id);
      const st = status.screens.find((x) => x.id === screen.id);
      const { nameOf } = pageOptions(screen, this.loc(AUTO));
      const states: [string, string][] = [
        [`${this.base}/${sid}/page`, st?.pinned ? nameOf.get(st.pinned) ?? this.loc(AUTO) : this.loc(AUTO)],
        [`${this.base}/${sid}/shown`, st?.off ? '—' : st?.page ? nameOf.get(st.page) ?? st.page : '—'],
        [`${this.base}/${sid}/display`, st?.off ? 'OFF' : 'ON'],
      ];
      for (const [topic, value] of states) {
        if (this.last.get(topic) === value) continue;
        this.last.set(topic, value);
        c.publish(topic, value, true);
      }
    }
  }

  private onMessage(topic: string, payload: string) {
    if (!this.link) return;
    // Home Assistant restarted: it forgets non-retained state, so announce again.
    if (topic === `${this.link.discoveryPrefix}/status`) {
      if (payload === 'online') this.announce();
      return;
    }
    const m = new RegExp(`^${this.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/(page/set|display/set|interlude/([^/]+)/press)$`).exec(topic);
    if (!m) return;
    const screen = this.runtime.config.screens.find((s) => slug(s.id) === m[1]);
    if (!screen) return;
    if (m[2] === 'page/set') {
      const { byName } = pageOptions(screen, this.loc(AUTO));
      if (!byName.has(payload)) return;
      this.runtime.pin(screen.id, byName.get(payload) ?? null);
    } else if (m[2] === 'display/set') {
      if (payload !== 'ON' && payload !== 'OFF') return;
      this.runtime.setOff(screen.id, payload === 'OFF');
    } else if (m[3]) {
      if (screen.interludes.some((s) => s.id === m[3])) this.runtime.playInterlude(screen.id, m[3]);
    }
    this.publishStates();
  }
}
