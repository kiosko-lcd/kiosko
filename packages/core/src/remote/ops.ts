/**
 * One-off jobs on a paired remote screen, each on a session of its own: a
 * firmware update (checked end to end by SHA-256, and kept by the screen only
 * if this Kiosko can talk to it afterwards), its recent log, unpairing.
 */
import { createHash } from 'node:crypto';
import { ScreenError, T, nextSealed, openSession, sendSealed } from './link.ts';

const CHUNK = 16 * 1024;

async function session(host: string, port: number, key: Buffer, uid: string) {
  const s = await openSession(host, port, key, uid);
  const st = await nextSealed(s.wire, s.session);
  if (st.type !== T.STATE) throw new Error('the screen did not say its state');
  return s;
}

export async function otaUpdate(host: string, port: number, key: Buffer, uid: string, image: Buffer, progress?: (sent: number, total: number) => void): Promise<void> {
  // An ESP-IDF app image starts with 0xE9: anything else is surely not a firmware.
  if (image[0] !== 0xe9) throw new ScreenError('notFirmware', 'not an ESP32 firmware image (.bin)');
  const { wire, session: s } = await session(host, port, key, uid);
  try {
    sendSealed(wire, s, T.OTA_BEGIN, { size: image.length, sha256: createHash('sha256').update(image).digest('hex') });
    const next = async () => {
      for (;;) {
        const m = await nextSealed(wire, s, 30_000);
        if (m.type === T.OTA_ACK) return (m.json() as { off: number }).off;
        if (m.type === T.OTA_DONE) {
          const j = m.json() as { ok?: boolean; err?: string };
          if (!j.ok) throw new ScreenError('otaFailed', `the screen refused the update: ${j.err ?? 'error'}`);
          return -1;
        }
        // STATE, PING...: keep waiting.
        if (m.type === T.PING) sendSealed(wire, s, T.PONG, {});
      }
    };
    let off = await next();
    while (off >= 0 && off < image.length) {
      sendSealed(wire, s, T.OTA_DATA, image.subarray(off, off + CHUNK));
      const got = await next();
      if (got !== Math.min(image.length, off + CHUNK)) throw new ScreenError('otaFailed', `the screen lost the update at ${off}`);
      off = got;
      progress?.(off, image.length);
    }
    sendSealed(wire, s, T.OTA_END, {});
    if ((await next()) !== -1) throw new ScreenError('otaFailed', 'the screen did not confirm the update');
  } finally {
    wire.close();
  }
}

export async function screenLogs(host: string, port: number, key: Buffer, uid: string): Promise<string> {
  const { wire, session: s } = await session(host, port, key, uid);
  try {
    sendSealed(wire, s, T.LOGS, {});
    for (;;) {
      const m = await nextSealed(wire, s);
      if (m.type === T.LOGS) return String((m.json() as { text?: string }).text ?? '');
    }
  } finally {
    wire.close();
  }
}

/** Tells the screen to forget its key (it then takes a new pairing). */
export async function unpairScreen(host: string, port: number, key: Buffer, uid: string): Promise<void> {
  const { wire, session: s } = await session(host, port, key, uid);
  try {
    sendSealed(wire, s, T.UNPAIR, {});
    for (;;) {
      const m = await nextSealed(wire, s).catch(() => null);
      if (!m || m.type === T.UNPAIR) return;
    }
  } finally {
    wire.close();
  }
}
