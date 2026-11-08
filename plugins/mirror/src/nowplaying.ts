/**
 * What's playing. A port of MMM-NowPlayingOnSpotify without Spotify's API: it
 * asks any Linux player over D-Bus (MPRIS, with `gdbus`, which GNOME already
 * ships), be it Spotify, the browser or VLC. Cover, title, artist and a
 * progress bar. Only takes its turn while something plays.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defineWidget, t, type Graphics, type Image, type Theme } from '@tessera/sdk';
import { clamp, within } from './util.ts';

const execFileAsync = promisify(execFile);

export interface Playing {
  player: string;
  status: 'Playing' | 'Paused' | 'Stopped';
  title: string;
  artists: string[];
  album: string;
  artUrl: string;
  /** Length and position when they were read, in ms. */
  lengthMs: number;
  positionMs: number;
  at: number;
}

export interface NowPlayingData extends Playing {
  /** The decoded cover, if it could be read. */
  art?: Image;
}

/** Text value of a key in `gdbus` output (GVariant as text). */
function gstr(out: string, key: string): string {
  const m = new RegExp(`'${key.replace(/[:]/g, '\\$&')}': <(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")>`).exec(out);
  return (m?.[1] ?? m?.[2] ?? '').replace(/\\(.)/g, '$1');
}

function gnum(out: string, key: string): number {
  const m = new RegExp(`'${key}': <(?:u?int64 |uint32 |int32 )?(-?\\d+)>`).exec(out);
  return m ? Number(m[1]) : 0;
}

/** What matters of `Properties.GetAll org.mpris.MediaPlayer2.Player`. */
export function parsePlayer(out: string, player: string, at: number): Playing {
  const artists = /'xesam:artist': <\[([^\]]*)\]>/.exec(out)?.[1] ?? '';
  const status = gstr(out, 'PlaybackStatus');
  return {
    player,
    status: status === 'Playing' || status === 'Paused' ? status : 'Stopped',
    title: gstr(out, 'xesam:title'),
    artists: [...artists.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1')),
    album: gstr(out, 'xesam:album'),
    artUrl: gstr(out, 'mpris:artUrl'),
    lengthMs: Math.round(gnum(out, 'mpris:length') / 1000),
    positionMs: Math.round(gnum(out, 'Position') / 1000),
    at,
  };
}

/** The one to show: playing before paused, the preferred player first. */
export function choosePlayer(found: Playing[], prefer: string): Playing | null {
  const p = prefer.trim().toLowerCase();
  const ordered = p ? [...found.filter((x) => x.player.toLowerCase().includes(p)), ...found.filter((x) => !x.player.toLowerCase().includes(p))] : found;
  return ordered.find((x) => x.status === 'Playing' && x.title) ?? ordered.find((x) => x.status === 'Paused' && x.title) ?? null;
}

/** Elapsed time now, extrapolated from the last reading while playing. */
export function positionAt(p: Playing, now: number): number {
  return Math.min(p.lengthMs, p.positionMs + (p.status === 'Playing' ? Math.max(0, now - p.at) : 0));
}

const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

const gdbus = async (args: string[], signal: AbortSignal) => (await execFileAsync('gdbus', ['call', '--session', ...args], { timeout: 3000, signal })).stdout;

/** Covers already decoded, by URL: they change with the song, not on every poll. */
const covers = new Map<string, Image | null>();

async function readCover(url: string, load: (src: Buffer) => Promise<Image>, signal: AbortSignal): Promise<Image | undefined> {
  if (!url) return undefined;
  if (covers.has(url)) return covers.get(url) ?? undefined;
  let img: Image | null = null;
  try {
    let buf: Buffer | null = null;
    if (url.startsWith('file://')) buf = await readFile(fileURLToPath(url));
    else if (/^https?:\/\//.test(url)) {
      const res = await fetch(url, { signal: within(signal, 8000) });
      if (res.ok) buf = Buffer.from(await res.arrayBuffer());
    }
    if (buf) img = await load(buf);
  } catch {
    // No cover.
  }
  if (covers.size > 20) covers.clear();
  covers.set(url, img);
  return img ?? undefined;
}

/** A stand-in cover: a gradient square with a note, so the layout doesn't jump. */
function drawPlaceholder(g: Graphics, x: number, y: number, side: number, theme: Theme): void {
  const grad = g.createLinearGradient(x, y, x + side, y + side);
  grad.addColorStop(0, theme.colors.accent);
  grad.addColorStop(1, theme.colors.surfaceEdge);
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(x, y, side, side, Math.min(12, side / 10));
  g.fill();
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.font = `${Math.round(side * 0.5)}px "${theme.fonts.sansBold}"`;
  g.textAlign = 'center';
  g.fillText('♪', x + side / 2, y + side * 0.68);
  g.textAlign = 'left';
}

export const nowplaying = defineWidget({
  id: 'nowplaying',
  name: { en: 'Now playing', es: 'Sonando' },
  description: {
    en: 'The song playing on this computer (any MPRIS player on Linux: Spotify, browser, VLC…), with cover and progress. Hidden while nothing plays.',
    es: 'La canción que suena en este ordenador (cualquier reproductor MPRIS de Linux: Spotify, navegador, VLC…), con portada y avance. Se oculta si no suena nada.',
  },
  icon: 'music',
  category: 'media',
  tags: ['magicmirror', 'spotify', 'mpris'],
  size: { min: { w: 280, h: 100 }, preferred: { w: 600, h: 220 } },
  options: t.object({
    showPaused: t.boolean({ label: { en: 'Also while paused', es: 'También en pausa' } }),
    prefer: t.string({ placeholder: 'spotify', label: { en: 'Preferred player', es: 'Reproductor preferido' }, help: { en: 'Part of its MPRIS name; empty = whichever plays.', es: 'Parte de su nombre MPRIS; vacío = el que suene.' } }),
    cover: t.boolean({ default: true, label: { en: 'Show the cover', es: 'Mostrar la portada' } }),
  }),
  // Progress is extrapolated in render; what takes a poll to show is a new
  // song or player. Each poll is several `gdbus` calls.
  intervalMs: 30_000,
  redraw: { everyMs: 5000 },
  async fetch({ now, options, canvas, signal }): Promise<NowPlayingData | null> {
    const list = await gdbus(['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames'], signal);
    const names = [...list.matchAll(/'(org\.mpris\.MediaPlayer2\.[^']+)'/g)].map((m) => m[1]!);
    const found: Playing[] = [];
    for (const name of names) {
      try {
        const out = await gdbus(['--dest', name, '--object-path', '/org/mpris/MediaPlayer2', '--method', 'org.freedesktop.DBus.Properties.GetAll', 'org.mpris.MediaPlayer2.Player'], signal);
        found.push(parsePlayer(out, name.replace('org.mpris.MediaPlayer2.', '').split('.')[0]!, now));
      } catch {
        // A player that doesn't answer doesn't hide the others.
      }
    }
    const best = choosePlayer(found, options.prefer);
    if (!best) return null;
    const art = options.cover ? await readCover(best.artUrl, (b) => canvas.loadImage(b), signal) : undefined;
    return art ? { ...best, art } : best;
  },
  visible: ({ options, data }) => Boolean(data && (data.status === 'Playing' || (options.showPaused && data.status === 'Paused'))),
  render(g, { data, now, box, theme, kit, options }) {
    if (!data) return;
    const { colors, fonts } = theme;
    // Tall tiles: cover on top, text below. Otherwise cover on the left.
    const tall = box.h >= box.w * 0.85;
    let x = box.x, w = box.w, top = box.y;
    if (options.cover) {
      const side = tall ? Math.min(box.w, box.h * 0.5) : Math.min(box.h, 300, box.w * 0.4);
      if (side >= 48) {
        const ax = tall ? box.x + (box.w - side) / 2 : box.x, ay = tall ? box.y : box.y + (box.h - side) / 2;
        if (data.art) g.drawImage(data.art, ax, ay, side, side);
        else drawPlaceholder(g, ax, ay, side, theme);
        if (tall) top = box.y + side + Math.round(side * 0.08);
        else {
          x += side + Math.round(side * 0.1);
          w = box.x + box.w - x;
        }
      }
    }
    const h = box.y + box.h - top;
    const hasBar = data.lengthMs > 0;
    const barBlock = hasBar ? clamp(h * 0.22, 26, 56) : 0;
    const titleSize = Math.round(clamp(Math.min(h * (tall ? 0.24 : 0.2), w / 7), 14, 46));
    const whoSize = Math.round(titleSize * 0.7);
    // Two lines of title when there is room, one otherwise.
    const twoLines = h - barBlock >= titleSize * 2.3 + whoSize * 1.4;
    const titleLines = kit.wrapLines(g, data.title, w, twoLines ? 2 : 1, { size: titleSize, family: fonts.sans });
    // Centred under a centred cover; left-aligned next to it.
    const align = tall ? ('center' as const) : ('left' as const);
    const tx = tall ? box.x + box.w / 2 : x;
    let y = top + titleSize * 0.95;
    for (const l of titleLines) {
      kit.drawTracked(g, l, tx, y, { size: titleSize, family: fonts.sans, color: colors.ink, align });
      y += titleSize * 1.13;
    }
    const who = [data.artists.join(', '), data.album].filter(Boolean).join(' · ');
    if (who && y + whoSize * 0.1 <= box.y + box.h - barBlock) {
      kit.drawTracked(g, kit.truncate(g, who, w, { size: whoSize, family: fonts.sans }), tx, y + whoSize * 0.1, { size: whoSize, family: fonts.sans, color: colors.inkDim, align });
    }
    if (hasBar) {
      const pos = positionAt(data, now);
      const bh = Math.max(4, Math.round(barBlock * 0.14));
      const label = `${mmss(pos)} / ${mmss(data.lengthMs)} · ${data.player}`;
      const meta = kit.fitSize(g, label, w, { size: Math.round(clamp(barBlock * 0.4, 11, 22)), family: fonts.mono }, 10);
      const by = box.y + box.h - meta * 1.5 - bh;
      g.fillStyle = colors.surfaceEdge;
      g.beginPath();
      g.roundRect(x, by, w, bh, bh / 2);
      g.fill();
      g.fillStyle = data.status === 'Playing' ? colors.info : colors.inkDim;
      g.beginPath();
      g.roundRect(x, by, Math.max(bh, (w * pos) / data.lengthMs), bh, bh / 2);
      g.fill();
      kit.drawTracked(g, kit.truncate(g, label, w, { size: meta, family: fonts.mono }), tx, box.y + box.h - meta * 0.25, { size: meta, family: fonts.mono, color: colors.inkDim, align });
    }
  },
  demo: ({ now }) => ({
    data: { player: 'spotify', status: 'Playing', title: 'Midnight Drive', artists: ['The Example Band'], album: 'Neon Roads', artUrl: '', lengthMs: 214_000, positionMs: 83_000, at: now } satisfies NowPlayingData,
  }),
});
