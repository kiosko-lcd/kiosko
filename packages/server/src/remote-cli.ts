/**
 * `kiosko remote`: Kiosko remote screens from the command line.
 *
 *   kiosko remote [list]                           the screens on the LAN (mDNS) and which screen uses each
 *   kiosko remote pair <uid|host> [--screen id]    pair (asks for the code the screen shows)
 *   kiosko remote ota <screen> <firmware.bin>      update its firmware
 *   kiosko remote logs <screen>                    its recent log
 *   kiosko remote unpair <screen>                  it forgets this Kiosko; the key is dropped here
 *
 * With a Kiosko running here (--port, default 7420), ota/logs/unpair go through
 * it, so its own session with the screen stands aside; otherwise they connect
 * themselves.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Pairing, REMOTE_PORT, loadConfig, normalize, otaUpdate, probe, remoteBrowser, saveConfig, screenLogs, unpairScreen, type Config, type Registry, type Screen } from '@kiosko/core';
import { remoteScreen } from './remote-api.ts';

const say = (s: string) => console.log(s);

function screenArg(cfg: Config, q: string | undefined): Screen & { device: { driver: 'remote'; uid: string; key?: string; host?: string; port?: number } } {
  const s = cfg.screens.find((x) => x.id === q || x.name === q || (x.device.driver === 'remote' && (x.device.uid === q || x.device.id === q)));
  if (!s || s.device.driver !== 'remote') throw new Error(`no remote screen "${q ?? ''}" in the config (kiosko remote list)`);
  return s as never;
}

async function where(d: { uid: string; host?: string; port?: number }): Promise<{ host: string; port: number }> {
  if (d.host) return { host: d.host, port: d.port ?? REMOTE_PORT };
  const b = remoteBrowser();
  const f = b.get(d.uid) ?? (await b.browse(2500)).find((x) => x.uid === d.uid);
  if (!f) throw new Error(`screen ${d.uid} is not on the network (no mDNS answer)`);
  return { host: f.address, port: f.port };
}

/** Through the Kiosko running here, if there is one; `null` when there is none. */
async function viaServer(port: number, path: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'x-kiosko': '1', ...(init.headers ?? {}) } });
  } catch {
    return null;
  }
}

export async function remoteCommand(args: string[], o: { configPath: string; port: number; registry: () => Promise<Registry> }): Promise<number> {
  const [sub = 'list', a, b] = args.filter((x, i, all) => !x.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--')));
  const opt = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const { config: cfg } = loadConfig(o.configPath);
  try {
    if (sub === 'list') {
      const found = await remoteBrowser().browse(2500);
      if (!found.length) say('no Kiosko remote screen answered on this network (mDNS _kiosko-screen._tcp)');
      for (const f of found) {
        const used = cfg.screens.find((s) => s.device.driver === 'remote' && s.device.uid === f.uid);
        say(`${f.id.padEnd(16)} uid ${f.uid}  ${f.model} ${f.w}×${f.h} at ${f.rot}°  fw ${f.fw}  ${f.paired ? 'paired' : 'not paired'}  ${f.address}:${f.port} (${f.hostname})${used ? `  → screen "${used.name}"` : ''}`);
      }
      for (const s of cfg.screens) if (s.device.driver === 'remote' && !found.some((f) => f.uid === (s.device as { uid: string }).uid)) say(`(screen "${s.name}": ${s.device.id ?? s.device.uid} did not answer)`);
      return 0;
    }
    if (sub === 'pair') {
      if (!a) throw new Error('usage: kiosko remote pair <uid|host> [--screen id]');
      const isUid = /^[0-9a-f]{12}$/i.test(a);
      const at = isUid ? await where({ uid: a.toLowerCase() }) : { host: a, port: Number(opt('--port-screen')) || REMOTE_PORT };
      const info = await probe(at.host, at.port);
      say(`${info.id} (${info.model}, uid ${info.uid}) at ${at.host}`);
      const p = await Pairing.start(at.host, at.port, `Kiosko on ${hostname()}`.slice(0, 40));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const code = await rl.question('Code shown on the screen: ');
      rl.close();
      const key = (await p.finish(code)).toString('hex');
      const next = structuredClone(cfg);
      const target = (opt('--screen') && next.screens.find((s) => s.id === opt('--screen'))) || next.screens.find((s) => s.device.driver === 'remote' && s.device.uid === info.uid);
      if (target) target.device = { driver: 'remote', uid: info.uid, id: info.id, key, ...(isUid ? {} : { host: at.host }) };
      else next.screens.push(remoteScreen(await o.registry(), info, key, 'en', isUid ? undefined : at.host));
      saveConfig(normalize(next), o.configPath);
      say(`paired; saved in ${o.configPath}${target ? ` (screen "${target.name}")` : ' as a new screen'}. A Kiosko running here picks it up when it restarts.`);
      return 0;
    }
    if (sub === 'ota' || sub === 'logs' || sub === 'unpair') {
      const s = screenArg(cfg, a);
      const id = encodeURIComponent(s.id);
      const image = sub === 'ota' ? readFileSync(b ?? '') : null;
      if (sub === 'ota' && !b) throw new Error('usage: kiosko remote ota <screen> <firmware.bin>');
      const r = await viaServer(o.port, `/api/screens/${id}/remote/${sub}`, sub === 'logs' ? {} : { method: 'POST', ...(image ? { body: new Uint8Array(image) } : {}) });
      if (r && r.status !== 404) {
        const j = (await r.json()) as { error?: string; text?: string };
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        say(sub === 'logs' ? (j.text ?? '') : sub === 'ota' ? 'updated: the screen restarts into it (and goes back by itself if this Kiosko cannot talk to it)' : 'unpaired');
        return 0;
      }
      const key = /^[0-9a-f]{64}$/.test(s.device.key ?? '') ? Buffer.from(s.device.key!, 'hex') : null;
      if (!key) throw new Error(`screen "${s.name}" is not paired`);
      const at = await where(s.device);
      if (sub === 'logs') say(await screenLogs(at.host, at.port, key, s.device.uid));
      else if (sub === 'ota') {
        let last = -1;
        await otaUpdate(at.host, at.port, key, s.device.uid, image!, (sent, total) => {
          const pct = Math.floor((sent * 100) / total);
          if (pct >= last + 10) process.stdout.write(`${(last = pct)}% `);
        });
        say('\nupdated: the screen restarts into it (and goes back by itself if this Kiosko cannot talk to it)');
      } else {
        await unpairScreen(at.host, at.port, key, s.device.uid);
        const next = structuredClone(cfg);
        const t = next.screens.find((x) => x.id === s.id)!;
        if (t.device.driver === 'remote') delete t.device.key;
        saveConfig(normalize(next), o.configPath);
        say('unpaired');
      }
      return 0;
    }
    say('usage: kiosko remote [list] | pair <uid|host> [--screen id] | ota <screen> <file.bin> | logs <screen> | unpair <screen>');
    return 2;
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    remoteBrowser().close();
  }
}
