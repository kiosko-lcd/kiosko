/**
 * Painting pages to PNG files outside the daemon: `kiosko render` and the
 * previews of `kiosko config import`. With demo data (the default) nothing is
 * read, run or fetched: widgets paint their sample data.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Runtime, type Config, type Page, type Registry, type Screen } from '@kiosko/core';

/** Paints `page` of `screen` into `out` (PNG). Returns the problems of its tiles. */
export function writePreview(rt: Runtime, screen: Screen, page: Page, out: string, o: { demo?: boolean } = {}): string[] {
  const r = rt.preview(screen, page, { demo: o.demo ?? true });
  // (`mkdir` of a drive root such as C:\\ fails with EPERM on Windows even when it exists.)
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, r.canvas.toBuffer('image/png'));
  return r.tiles.filter((t) => t.error).map((t) => `tile ${t.id}: ${t.error}`);
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';

export interface PreviewFile {
  screen: string;
  page: string;
  file: string;
  size: string;
  problems: string[];
}

/**
 * One PNG per page of every screen of `cfg`, into `dir`, with demo data.
 * Background images are left out: one may be a URL, and a preview contacts
 * nothing.
 */
export function renderPreviews(registry: Registry, cfg: Config, dir: string): PreviewFile[] {
  const safe: Config = {
    ...cfg,
    screens: cfg.screens.map((s) => ({ ...s, pages: s.pages.map((p) => ({ ...p, background: p.background?.color ? { color: p.background.color } : {} })) })),
  };
  const rt = new Runtime(registry, safe);
  const out: PreviewFile[] = [];
  try {
    safe.screens.forEach((s, si) =>
      s.pages.forEach((p, pi) => {
        const file = join(dir, `${si + 1}-${slug(s.name || s.id)}--${pi + 1}-${slug(p.name || p.id)}.png`);
        const problems = writePreview(rt, s, p, file);
        out.push({ screen: s.name || s.id, page: p.name || p.id, file, size: `${s.width}×${s.height}`, problems });
      }),
    );
  } finally {
    rt.stop();
  }
  return out;
}
