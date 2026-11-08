/**
 * Props drawn live over a resting cat: the tie when a meeting is near, party
 * hats on Friday afternoon, devil horns on Halloween, cobwebs on abandoned
 * branches, the rubber duck that stayed as a mascot, and the meeting door.
 * (The aimonitor gesture props are not ported: the widget paints the resting
 * scene.)
 *
 * Coordinates: (x, y) is the cat's origin on the floor and `s` its scale.
 */
import { COND } from './fonts.ts';
import { type X, ellipse, linear } from './paint.ts';

/** A tie, for the cats with a meeting coming up. */
export function tie(c: X, x: number, y: number, s: number, color = '#C8303F'): void {
  // (x, y): just below the collar of a cat facing you.
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x - 7 * s, y);
  c.lineTo(x + 7 * s, y);
  c.lineTo(x + 4 * s, y + 10 * s);
  c.lineTo(x - 4 * s, y + 10 * s);
  c.closePath();
  c.fill();
  c.beginPath();
  c.moveTo(x - 4 * s, y + 10 * s);
  c.lineTo(x + 4 * s, y + 10 * s);
  c.lineTo(x + 10 * s, y + 62 * s);
  c.lineTo(x, y + 74 * s);
  c.lineTo(x - 10 * s, y + 62 * s);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.3)';
  c.lineWidth = 2 * s;
  for (const k of [24, 42]) {
    c.beginPath();
    c.moveTo(x - 7 * s, y + k * s);
    c.lineTo(x + 7 * s, y + (k + 8) * s);
    c.stroke();
  }
}

/** The meeting door, with its sign: `title` on top (MEETING) and `label` (in 5m) below. */
export function meetingDoor(c: X, x: number, top: number, bottom: number, title: string, label: string): void {
  const w = 108;
  c.fillStyle = '#4A3420';
  c.fillRect(x - w / 2 - 8, top - 8, w + 16, bottom - top + 8);
  c.fillStyle = linear(c, x - w / 2, 0, x + w / 2, 0, [[0, '#8C6440'], [1, '#6E4A2B']]);
  c.fillRect(x - w / 2, top, w, bottom - top);
  c.strokeStyle = 'rgba(0,0,0,0.25)';
  c.lineWidth = 2;
  c.strokeRect(x - w / 2 + 12, top + 14, w - 24, (bottom - top) * 0.4);
  c.strokeRect(x - w / 2 + 12, top + 24 + (bottom - top) * 0.4, w - 24, (bottom - top) * 0.45);
  c.fillStyle = '#E8C45A';
  ellipse(c, x + w / 2 - 16, (top + bottom) / 2 + 10, 5, 5);
  c.fill();
  c.fillStyle = '#F6EEDC';
  c.fillRect(x - 46, top + 26, 92, 30);
  c.fillStyle = '#C62A22';
  c.font = `bold 13px ${COND}`;
  c.textAlign = 'center';
  c.fillText(title, x, top + 39);
  c.fillStyle = '#2A1A10';
  c.fillText(label, x, top + 53);
  c.textAlign = 'left';
}

/** Party hat (Friday afternoon). */
export function partyHat(c: X, x: number, y: number, s: number, color: string, tilt = -0.15): void {
  // (x, y): top of the head, between the ears.
  c.save();
  c.translate(x, y);
  c.rotate(tilt);
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(-22 * s, 0);
  c.lineTo(22 * s, 0);
  c.lineTo(0, -64 * s);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 4 * s;
  for (const k of [0.3, 0.6]) {
    c.beginPath();
    c.moveTo(-22 * s * (1 - k), -64 * s * k);
    c.lineTo(22 * s * (1 - k), -64 * s * k + 6 * s);
    c.stroke();
  }
  c.fillStyle = '#FFE14D';
  ellipse(c, 0, -66 * s, 8 * s, 8 * s);
  c.fill();
  c.restore();
}


/** Devil horns (Halloween, Tuesday the 13th). */
export function devilHorns(c: X, x: number, y: number, s: number): void {
  for (const k of [-1, 1]) {
    c.save();
    c.translate(x + k * 30 * s, y + 14 * s);
    c.scale(k * s, s);
    c.beginPath();
    c.moveTo(-12, 4);
    c.quadraticCurveTo(-8, -26, 18, -44);
    c.quadraticCurveTo(6, -20, 12, 4);
    c.closePath();
    c.fillStyle = linear(c, -12, 4, 18, -44, [[0, '#8E0F16'], [0.6, '#D7262E'], [1, '#FF6A5A']]);
    c.fill();
    c.strokeStyle = 'rgba(60,0,0,0.6)';
    c.lineWidth = 1.5;
    c.stroke();
    c.restore();
  }
}


/** Cobwebs on a cat whose branch has had no commits for a month. */
export function cobweb(c: X, x: number, y: number, s: number): void {
  c.save();
  c.strokeStyle = 'rgba(235,240,250,0.6)';
  c.lineWidth = 1.3;
  for (const [cx, cy, k] of [[-90, -250, 1], [100, -140, -1]] as const) {
    const ox = x + cx * s, oy = y + cy * s;
    for (let i = 0; i < 6; i++) {
      const a = (k > 0 ? 0 : Math.PI / 2) + (i / 5) * (Math.PI / 2);
      c.beginPath();
      c.moveTo(ox, oy);
      c.lineTo(ox + Math.cos(a) * 70 * s * k, oy + Math.sin(a) * 70 * s);
      c.stroke();
    }
    for (const r of [22, 42, 62]) {
      c.beginPath();
      for (let i = 0; i <= 5; i++) {
        const a = (k > 0 ? 0 : Math.PI / 2) + (i / 5) * (Math.PI / 2);
        const px = ox + Math.cos(a) * r * s * k, py = oy + Math.sin(a) * r * s;
        if (i) c.quadraticCurveTo(ox + Math.cos(a - 0.15) * r * 0.85 * s * k, oy + Math.sin(a - 0.15) * r * 0.85 * s, px, py);
        else c.moveTo(px, py);
      }
      c.stroke();
    }
  }
  c.restore();
}


/** The rubber duck that stays on the desk once the session talked to it. */
export function deskDuck(c: X, x: number, y: number, s: number): void {
  duck(c, x, y, s);
}

function duck(c: X, x: number, y: number, s: number): void {
  c.save();
  c.fillStyle = '#FFD53D';
  ellipse(c, x, y - 22 * s, 34 * s, 22 * s);
  c.fill();
  ellipse(c, x - 18 * s, y - 52 * s, 18 * s, 17 * s);
  c.fill();
  c.fillStyle = '#FF8A2A';
  ellipse(c, x - 36 * s, y - 48 * s, 11 * s, 5 * s);
  c.fill();
  c.fillStyle = '#1A1A22';
  ellipse(c, x - 22 * s, y - 56 * s, 3 * s + 0.5, 3 * s + 0.5);
  c.fill();
  c.fillStyle = '#F0B820';
  ellipse(c, x + 8 * s, y - 26 * s, 16 * s, 9 * s, -0.4);
  c.fill();
  c.restore();
}
