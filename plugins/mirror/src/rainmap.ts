/**
 * Rain radar around home. A port of MMM-RAIN-MAP: the latest RainViewer
 * radar image (free, no key) over the OpenStreetMap map, darkened for the
 * panel, with home in the centre. The free radar only goes up to zoom 7, so
 * it's a regional view (about 450 km wide).
 *
 * By default it only takes its turn when it rains in the area
 * (`onlyWhenRaining`). Map tiles are kept on disk for good (OpenStreetMap's
 * usage policy asks not to download them again); radar tiles are fetched
 * every 10 minutes (about six of them).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineWidget, t, type Box, type Canvas, type Graphics, type RenderContext } from '@tessera/sdk';
import { clamp, hhmm, NO_PLACE, placeFields, placeFor, USER_AGENT, within } from './util.ts';

/** Size of the composed map; it's drawn cropped to the card's box. */
const OUT_W = 660, OUT_H = 400;
const ZOOM = 7;
const SCALE = 1.5;

/** World pixel (Web Mercator) of some coordinates at a zoom level. */
export function worldPx(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 256 * 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}

/** The tiles covering a `w`×`h` box of world pixels centred on (cx, cy). */
export function tilesAround(cx: number, cy: number, w: number, h: number): { x: number; y: number; dx: number; dy: number }[] {
  const x0 = cx - w / 2, y0 = cy - h / 2;
  const out = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + h) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + w) / 256); tx++) out.push({ x: tx, y: ty, dx: tx * 256 - x0, dy: ty * 256 - y0 });
  }
  return out;
}

/** Is it a real PNG? A provider that changes its terms sends notices instead. */
export const isPng = (b: Buffer): boolean => b.length > 8 && b.readUInt32BE(0) === 0x89504e47;

/** Fraction of pixels with some rain (alpha above a threshold) in RGBA data. */
export function wetFraction(rgba: Uint8ClampedArray | Uint8Array): number {
  let wet = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 32) wet++;
  return rgba.length ? wet / (rgba.length / 4) : 0;
}

async function get(url: string, signal: AbortSignal): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: within(signal, 10_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** A base map tile, from the disk cache or from OpenStreetMap. */
async function baseTile(dir: string, x: number, y: number, signal: AbortSignal): Promise<Buffer | null> {
  const path = join(dir, 'tiles', 'osm', String(ZOOM), String(x), `${y}.png`);
  if (existsSync(path)) return readFile(path);
  const buf = await get(`https://tile.openstreetmap.org/${ZOOM}/${x}/${y}.png`, signal);
  if (!buf || !isPng(buf)) return null;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  return buf;
}

export interface RainData {
  /** The composed map with the radar on top. Absent in demo data. */
  img?: Canvas;
  /** Time of the radar image, ms epoch. */
  time: number;
  /** Fraction of the map with rain, 0..1. */
  rain: number;
}

/**
 * A made-up radar (dark map, a front of rain cells) for the gallery, where
 * there's no network: deterministic, so previews don't flicker.
 */
function drawSampleRadar(g: Graphics, box: Box, kit: RenderContext<unknown, unknown>['kit']): void {
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.w, box.h);
  g.clip();
  g.fillStyle = '#0B0F14';
  g.fillRect(box.x, box.y, box.w, box.h);
  const rnd = kit.rng(7);
  // Faint "roads" so it reads as a map.
  g.strokeStyle = 'rgba(122,142,172,0.16)';
  g.lineWidth = 1;
  for (let i = 0; i < 10; i++) {
    g.beginPath();
    g.moveTo(box.x + rnd() * box.w, box.y);
    g.bezierCurveTo(box.x + rnd() * box.w, box.y + box.h / 3, box.x + rnd() * box.w, box.y + (box.h * 2) / 3, box.x + rnd() * box.w, box.y + box.h);
    g.stroke();
  }
  // A band of rain crossing from south-west to north-east, made of blobs.
  const unit = Math.max(box.w, box.h);
  for (let i = 0; i < 46; i++) {
    const t = rnd();
    const cx = box.x + box.w * (0.05 + 0.75 * t) + (rnd() - 0.5) * unit * 0.12;
    const cy = box.y + box.h * (0.95 - 0.8 * t) + (rnd() - 0.5) * unit * 0.12;
    const r = unit * (0.02 + rnd() * 0.05);
    const core = rnd() < 0.18;
    g.fillStyle = kit.radial(g, cx, cy, 0, r, core
      ? [[0, 'rgba(255,200,0,0.9)'], [0.4, 'rgba(60,200,90,0.7)'], [1, 'rgba(60,200,90,0)']]
      : [[0, 'rgba(80,150,255,0.55)'], [1, 'rgba(80,150,255,0)']]);
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

export const rainmap = defineWidget({
  id: 'rainmap',
  name: { en: 'Rain radar', es: 'Radar de lluvia' },
  description: {
    en: 'Latest rain radar (RainViewer) over a dark OpenStreetMap map, home in the centre. By default only shows while it rains nearby.',
    es: 'El último radar de lluvia (RainViewer) sobre un mapa oscuro de OpenStreetMap, con casa en el centro. Por defecto sólo sale si llueve cerca.',
  },
  icon: 'cloud-rain',
  category: 'info',
  tags: ['magicmirror', 'weather', 'radar', 'map'],
  size: { min: { w: 200, h: 140 }, preferred: { w: 600, h: 440 } },
  options: t.object({
    onlyWhenRaining: t.boolean({ default: true, label: { en: 'Only while it rains nearby', es: 'Sólo si llueve cerca' } }),
    ...placeFields(),
  }),
  intervalMs: 10 * 60_000,
  async fetch({ options, location, canvas, dataDir, signal }): Promise<RainData> {
    const at = placeFor(options, location);
    if (!at) throw new Error(NO_PLACE);
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { headers: { 'User-Agent': USER_AGENT }, signal: within(signal, 10_000) });
    if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
    const maps = (await res.json()) as { host?: string; radar?: { past?: { time: number; path: string }[] } };
    const frame = maps.radar?.past?.at(-1);
    if (!maps.host || !frame) throw new Error('RainViewer returned no radar frames');
    const c = worldPx(at.latitude, at.longitude, ZOOM);
    const tiles = tilesAround(c.x, c.y, OUT_W / SCALE, OUT_H / SCALE);
    const out = canvas.createCanvas(OUT_W, OUT_H);
    const radar = canvas.createCanvas(OUT_W, OUT_H);
    const ctx = out.getContext('2d'), rctx = radar.getContext('2d');
    ctx.fillStyle = '#0B0F14';
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    const size = 256 * SCALE;
    for (const tile of tiles) {
      const [b, r] = await Promise.all([baseTile(dataDir, tile.x, tile.y, signal), get(`${maps.host}${frame.path}/256/${ZOOM}/${tile.x}/${tile.y}/2/1_1.png`, signal)]);
      if (b) ctx.drawImage(await canvas.loadImage(b), tile.dx * SCALE, tile.dy * SCALE, size, size);
      if (r && isPng(r)) rctx.drawImage(await canvas.loadImage(r), tile.dx * SCALE, tile.dy * SCALE, size, size);
    }
    // OpenStreetMap is light: grey, inverted and tinted night blue, so the radar stands out.
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#7A8EAC';
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    ctx.globalCompositeOperation = 'source-over';
    const rain = wetFraction(rctx.getImageData(0, 0, OUT_W, OUT_H).data);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(radar, 0, 0);
    ctx.globalAlpha = 1;
    return { img: out, time: frame.time * 1000, rain };
  },
  visible: ({ options, data }) => Boolean(data && (!options.onlyWhenRaining || data.rain > 0.0005)),
  render(g, { data, box, theme, kit }) {
    if (!data) return;
    const { colors, fonts } = theme;
    if (data.img) {
      // Cropped to fill the box, centred: home stays in the middle.
      const k = Math.max(box.w / OUT_W, box.h / OUT_H);
      const sw = box.w / k, sh = box.h / k;
      g.drawImage(data.img, (OUT_W - sw) / 2, (OUT_H - sh) / 2, sw, sh, box.x, box.y, box.w, box.h);
    } else {
      drawSampleRadar(g, box, kit);
    }
    const hx = box.x + box.w / 2, hy = box.y + box.h / 2;
    g.strokeStyle = colors.warn;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(hx, hy, clamp(box.h * 0.03, 5, 9), 0, Math.PI * 2);
    g.stroke();
    const s = Math.round(clamp(box.h * 0.07, 11, 24));
    const credit = Math.round(clamp(s * 0.55, 9, 13));
    const label = `radar ${hhmm(data.time)}`;
    // The map is always dark (whatever the theme): light captions on a dark band.
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(box.x, box.y + box.h - s * 1.5, box.w, s * 1.5);
    const lw = kit.drawTracked(g, label, box.x + 8, box.y + box.h - s * 0.4, { size: s, family: fonts.mono, color: '#E6EDF5' });
    const cw = box.w - lw - 24;
    if (cw > 40) kit.drawTracked(g, kit.truncate(g, '© OpenStreetMap · RainViewer', cw, { size: credit, family: fonts.sans }), box.x + box.w - 8, box.y + box.h - s * 0.4, { size: credit, family: fonts.sans, color: '#9AA7B5', align: 'right' });
  },
  demo: ({ now }) => ({ data: { time: Math.floor((now - 7 * 60_000) / 600_000) * 600_000, rain: 0.08 } satisfies RainData }),
});
