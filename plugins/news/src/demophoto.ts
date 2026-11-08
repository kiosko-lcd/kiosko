/**
 * Procedural "press photos" for the demo: the gallery and the editor must
 * show the real look (a full-bleed photo under the scrim) without network.
 * Three scenes, painted with gradients and silhouettes, deterministic.
 */
import type { Box, Graphics } from '@tessera/sdk';

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sky(g: Graphics, b: Box, horizon: number, stops: [number, string][]): void {
  const grad = g.createLinearGradient(0, b.y, 0, b.y + horizon);
  for (const [o, c] of stops) grad.addColorStop(o, c);
  g.fillStyle = grad;
  g.fillRect(b.x, b.y, b.w, horizon);
}

function glow(g: Graphics, x: number, y: number, r: number, color: string): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function ridge(g: Graphics, b: Box, base: number, amp: number, color: string, r: () => number): void {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(b.x, b.y + b.h);
  const steps = 14;
  for (let i = 0; i <= steps; i++) g.lineTo(b.x + (b.w * i) / steps, base - amp * (0.4 + 0.6 * Math.sin(i * 0.9 + r() * 2)) * (0.6 + r() * 0.5));
  g.lineTo(b.x + b.w, b.y + b.h);
  g.closePath();
  g.fill();
}

/** A harbour at dusk: low sun, sea, cranes on the pier. */
function harbour(g: Graphics, b: Box): void {
  const r = rng(7);
  const hz = b.h * 0.62;
  sky(g, b, hz, [[0, '#1E2B4D'], [0.45, '#6E5A8A'], [0.85, '#F2A25C'], [1, '#FFD08A']]);
  const sx = b.x + b.w * 0.66, sy = b.y + hz * 0.92;
  glow(g, sx, sy, Math.max(b.w, b.h) * 0.28, 'rgba(255,214,150,0.75)');
  g.fillStyle = '#FFE9B8';
  g.beginPath();
  g.arc(sx, sy, b.h * 0.05, 0, Math.PI * 2);
  g.fill();
  ridge(g, b, b.y + hz, b.h * 0.06, 'rgba(60,48,84,0.9)', r);
  const sea = g.createLinearGradient(0, b.y + hz, 0, b.y + b.h);
  sea.addColorStop(0, '#4E4266');
  sea.addColorStop(1, '#121828');
  g.fillStyle = sea;
  g.fillRect(b.x, b.y + hz, b.w, b.h - hz);
  // The sun's reflection, broken by the waves.
  for (let i = 0; i < 26; i++) {
    const y = b.y + hz + (b.h - hz) * (i / 26) ** 1.3;
    const w = b.w * (0.02 + r() * 0.08) * (1 + i / 20);
    g.fillStyle = `rgba(255,200,130,${0.55 * (1 - i / 30)})`;
    g.fillRect(sx - w / 2 + (r() - 0.5) * b.w * 0.04, y, w, Math.max(1, b.h * 0.006));
  }
  // Pier, containers and two cranes in silhouette.
  const pier = b.y + hz + b.h * 0.05;
  g.fillStyle = '#0D1018';
  g.fillRect(b.x + b.w * 0.55, pier, b.w * 0.45, b.h * 0.05);
  const palette = ['#2A1F2E', '#1C2433', '#33202A'];
  for (let i = 0; i < 9; i++) {
    const cw = b.w * 0.035;
    const x = b.x + b.w * 0.58 + i * cw * 1.05;
    const stack = 1 + Math.floor(r() * 3);
    for (let s = 0; s < stack; s++) {
      g.fillStyle = palette[(i + s) % palette.length]!;
      g.fillRect(x, pier - (s + 1) * b.h * 0.035, cw, b.h * 0.033);
    }
  }
  for (const [fx, hk] of [[0.8, 0.42], [0.92, 0.36]] as const) {
    const x = b.x + b.w * fx, top = b.y + b.h * (0.62 - hk);
    g.fillStyle = '#0B0D14';
    g.fillRect(x - b.w * 0.004, top, b.w * 0.008, pier - top);
    g.fillRect(x - b.w * 0.09, top, b.w * 0.13, b.h * 0.012);
    g.fillRect(x - b.w * 0.07, top + b.h * 0.012, b.w * 0.003, b.h * 0.08);
  }
}

/** A city at night: skyline with lit windows under a hazy sky. */
function city(g: Graphics, b: Box): void {
  const r = rng(11);
  sky(g, b, b.h, [[0, '#0A1024'], [0.7, '#24345E'], [1, '#5B4E73']]);
  glow(g, b.x + b.w * 0.5, b.y + b.h, b.w * 0.5, 'rgba(255,170,110,0.35)');
  for (const [depth, color] of [[0.5, '#1A2140'], [0.68, '#0F1428']] as const) {
    let x = b.x;
    while (x < b.x + b.w) {
      const w = b.w * (0.03 + r() * 0.05);
      const h = b.h * (depth - 0.12 + r() * 0.42);
      const top = b.y + b.h - h;
      g.fillStyle = color;
      g.fillRect(x, top, w, h);
      const cell = Math.max(3, b.h * 0.018);
      for (let wy = top + cell; wy < b.y + b.h - cell; wy += cell * 1.8) {
        for (let wx = x + cell * 0.6; wx < x + w - cell; wx += cell * 1.6) {
          if (r() < 0.22) {
            g.fillStyle = r() < 0.8 ? 'rgba(255,214,140,0.7)' : 'rgba(170,210,255,0.6)';
            g.fillRect(wx, wy, cell * 0.8, cell);
          }
        }
      }
      x += w + b.w * 0.004;
    }
  }
}

/** Morning fields with wind turbines. */
function field(g: Graphics, b: Box): void {
  const r = rng(5);
  const hz = b.h * 0.58;
  sky(g, b, hz + 2, [[0, '#6FA9D8'], [0.7, '#BBD8EA'], [1, '#F1EBDD']]);
  glow(g, b.x + b.w * 0.22, b.y + hz * 0.35, b.h * 0.5, 'rgba(255,248,225,0.8)');
  ridge(g, b, b.y + hz, b.h * 0.08, '#8EA6A0', r);
  ridge(g, b, b.y + hz + b.h * 0.08, b.h * 0.07, '#6E8F5A', r);
  ridge(g, b, b.y + hz + b.h * 0.2, b.h * 0.06, '#4F7340', r);
  const front = g.createLinearGradient(0, b.y + hz + b.h * 0.25, 0, b.y + b.h);
  front.addColorStop(0, '#5E7E3C');
  front.addColorStop(1, '#2F4423');
  g.fillStyle = front;
  g.fillRect(b.x, b.y + hz + b.h * 0.27, b.w, b.h);
  for (const [fx, s] of [[0.48, 1], [0.6, 0.75], [0.7, 0.6], [0.83, 0.85]] as const) {
    const x = b.x + b.w * fx, base = b.y + hz + b.h * 0.06, hgt = b.h * 0.42 * s;
    const hubY = base - hgt;
    g.fillStyle = '#F4F6F6';
    g.fillRect(x - b.h * 0.004 * s, hubY, b.h * 0.008 * s, hgt);
    for (let k = 0; k < 3; k++) {
      const a = k * ((2 * Math.PI) / 3) + fx * 7;
      g.save();
      g.translate(x, hubY);
      g.rotate(a);
      g.fillRect(-b.h * 0.004 * s, 0, b.h * 0.008 * s, b.h * 0.2 * s);
      g.restore();
    }
  }
}

const SCENES: Record<string, (g: Graphics, b: Box) => void> = { harbour, city, field };

/** Paints the demo scene `name` over `b`; an unknown name gets the harbour. */
export function paintDemoPhoto(g: Graphics, name: string, b: Box): void {
  g.save();
  g.beginPath();
  g.rect(b.x, b.y, b.w, b.h);
  g.clip();
  (SCENES[name] ?? harbour)(g, b);
  g.restore();
}
