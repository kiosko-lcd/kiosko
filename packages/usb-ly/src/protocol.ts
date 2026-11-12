/**
 * The wire protocol of the LY family of Thermalright USB LCD panels
 * (Trofeo Vision 9.16 and siblings), VID 0x0416:
 *
 *   PID 0x5408 "LY"   chunk header byte 8 = 1, chunk count padded to a multiple of 4
 *   PID 0x5409 "LY1"  chunk header byte 8 = 2, no padding
 *
 * Handshake: write 2048 bytes (a 16-byte header and zeros), read 512; the
 * reply starts `03 FF` and has byte 8 = 1. PM and SUB, two bytes that say
 * which model it is, come from bytes 20 and 22.
 *
 * Frame: the JPEG goes in 512-byte chunks (a 16-byte header and 496 bytes of
 * data), written to the bulk OUT endpoint in 4096-byte USB transfers, then a
 * 512-byte ACK is read whose **byte 8 says whether the panel kept the frame**
 * (1) or dropped it (2). A dropped frame is silent otherwise: the write
 * succeeds and the screen keeps the previous picture.
 *
 * All of it is read from the USBLCDNEW protocol as implemented by
 * thermalright-trcc-linux (`trcc/adapters/device/ly_lcd.py`, 9.12); the
 * golden vectors in the tests are produced by that implementation.
 */

export const VENDOR_ID = 0x0416;
export const PID_LY = 0x5408;
export const PID_LY1 = 0x5409;
export const PRODUCT_IDS: readonly number[] = [PID_LY, PID_LY1];

/** Bulk OUT and IN endpoints, used when the device's descriptors don't say otherwise. */
export const EP_OUT = 0x01;
export const EP_IN = 0x81;

export const CHUNK_SIZE = 512;
export const CHUNK_HEADER_SIZE = 16;
export const CHUNK_DATA_SIZE = 496;
export const USB_WRITE_SIZE = 4096;
export const REPLY_SIZE = 512;

export const HANDSHAKE_TIMEOUT_MS = 1000;
export const WRITE_TIMEOUT_MS = 5000;
export const ACK_TIMEOUT_MS = 1000;

/**
 * The largest JPEG the firmware keeps, measured on a Trofeo Vision: 1032
 * chunks of 496 bytes. One byte more and the panel drops the frame with a
 * normal-looking ACK (byte 8 = 2). trcc's own ceiling, 512 KiB, is above it.
 */
export const MAX_FRAME_BYTES = 511_871;

export type Variant = 'ly' | 'ly1';

export function variantOf(pid: number): Variant {
  return pid === PID_LY1 ? 'ly1' : 'ly';
}

/** The bytes the host sends to say hello. */
export function handshakeRequest(): Buffer {
  const b = Buffer.alloc(2048);
  b[0] = 0x02;
  b[1] = 0xff;
  b[8] = 0x01;
  return b;
}

export interface Handshake {
  /** The model byte (`64 + resp[20]` on LY; `49 + resp[20]` on LY1). */
  pm: number;
  /** The sub-model byte (`resp[22] + 1` on LY; `resp[22]` on LY1). */
  sub: number;
  /** The first bytes of the reply, for reports. */
  raw: Buffer;
}

export class UnrecognisedReply extends Error {
  override name = 'UnrecognisedReply';
}

export function parseHandshake(resp: Buffer, pid: number): Handshake {
  if (resp.length < 37 || resp[0] !== 3 || resp[1] !== 0xff || resp[8] !== 1) {
    const at = (i: number) => (resp.length > i ? String(resp[i]) : 'N/A');
    throw new UnrecognisedReply(`handshake validation failed (length ${resp.length}, [0]=${at(0)}, [1]=${at(1)}, [8]=${at(8)})`);
  }
  const raw = resp.subarray(0, Math.min(resp.length, 64));
  if (variantOf(pid) === 'ly') {
    // trcc clamps 0..3 to 1.
    const r = resp[20]! <= 3 ? 1 : resp[20]!;
    return { pm: 64 + r, sub: (resp[22] ?? 0) + 1, raw };
  }
  return { pm: 49 + resp[20]!, sub: resp[22] ?? 0, raw };
}

/** Resolution and mount angle the firmware asks for, for the models trcc knows. */
export interface PanelModel {
  width: number;
  height: number;
  /** Degrees the picture must be turned before encoding (0, 90, 180). Kiosko's `rotate`. */
  rotate: number;
}

/**
 * From trcc 9.12 `bulk_profile(pm, sub)` + `wire_angle`. Only the models it
 * knows; anything else is `undefined` and the caller uses its own config.
 */
const ANGLES_1920 = [180, 180, 0, 0, 0, 180, 180, 180, 180];
const MODELS: Record<number, { width: number; height: number; angles: number[] }> = {
  64: { width: 1600, height: 720, angles: [180, 180, 180, 0, 180, 180, 180, 180, 180] },
  65: { width: 1920, height: 462, angles: ANGLES_1920 },
  66: { width: 1920, height: 462, angles: ANGLES_1920 },
  68: { width: 1280, height: 480, angles: [0, 0, 90, 0, 0, 0, 0, 0, 0] },
  69: { width: 1920, height: 440, angles: ANGLES_1920 },
};

export function modelFor(pm: number, sub: number): PanelModel | undefined {
  const m = MODELS[pm] ?? (pm >= 67 && pm <= 80 ? { width: 480, height: 480, angles: Array<number>(9).fill(0) } : undefined);
  const rotate = m?.angles[sub];
  return m && rotate !== undefined ? { width: m.width, height: m.height, rotate } : undefined;
}

/** The exact bytes that go on the bus for a JPEG: chunk headers included, padded. */
export function prepareFrame(payload: Buffer, pid: number): Buffer {
  const total = payload.length;
  const n = Math.floor(total / CHUNK_DATA_SIZE) + 1;
  const lastLen = total % CHUNK_DATA_SIZE;
  const cmd = variantOf(pid) === 'ly' ? 1 : 2;
  const padTo = variantOf(pid) === 'ly' ? 4 : 1;
  const padded = Math.ceil(n / padTo) * padTo;
  const out = Buffer.alloc(padded * CHUNK_SIZE);
  for (let i = 0; i < n; i++) {
    const o = i * CHUNK_SIZE;
    const len = i === n - 1 ? lastLen : CHUNK_DATA_SIZE;
    out[o] = 0x01;
    out[o + 1] = 0xff;
    out.writeUInt32LE(total, o + 2);
    out.writeUInt16LE(len, o + 6);
    out[o + 8] = cmd;
    out.writeUInt16LE(n, o + 9);
    out.writeUInt16LE(i, o + 11);
    payload.copy(out, o + CHUNK_HEADER_SIZE, i * CHUNK_DATA_SIZE, i * CHUNK_DATA_SIZE + len);
  }
  return out;
}

/** The USB transfers a prepared frame is written in: 4096 bytes, and a shorter last one. */
export function frameWrites(frame: Buffer, pid: number): Buffer[] {
  const out: Buffer[] = [];
  for (let pos = 0; pos < frame.length; pos += USB_WRITE_SIZE) {
    const remaining = frame.length - pos;
    const size = remaining >= USB_WRITE_SIZE ? USB_WRITE_SIZE : variantOf(pid) === 'ly' ? Math.min(2048, remaining) : remaining;
    out.push(frame.subarray(pos, pos + size));
  }
  return out;
}

/** Did the panel keep the frame? A short or odd ACK is taken as good (it may be another firmware). */
export function isAccepted(ack: Buffer): boolean {
  return ack.length < 9 || ack[8] === 1;
}
