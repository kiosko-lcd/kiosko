/**
 * Which panels a widget fits, by its sizes: the store's "fits on" and the
 * editor's "fits your screens". A widget fits a panel when its minimum size
 * fits the biggest tile a page of that panel can have (the whole page inside
 * the grid's padding, the same grid the editor suggests for it); it is
 * ideal there when its preferred size fits too. Pure: the site, the index
 * builder and the editor share it.
 */
import { PANEL_PRESETS, type PanelPreset } from '../config/model.ts';
import { suggestGrid } from '../layout/grid.ts';
import type { PanelClassId } from './types.ts';

/**
 * The class of a picture `width` × `height` (as designed, after any turn):
 * bar ≥ 2.5:1, landscape 1.15–2.5, square 0.87–1.15 (round if the screen
 * is), portrait below.
 */
export function panelClass(width: number, height: number, shape: 'rect' | 'round' = 'rect'): PanelClassId {
  const r = width / height;
  if (r >= 2.5) return 'bar';
  if (r >= 1.15) return 'landscape';
  if (r >= 0.87) return shape === 'round' ? 'round' : 'square';
  return 'portrait';
}

/** The biggest tile on a page of this size, in px. */
export function biggestTile(width: number, height: number): { w: number; h: number } {
  const g = suggestGrid(width, height);
  return { w: width - 2 * g.padding, h: height - 2 * g.padding };
}

/** `ideal` (its preferred size fits), `fits` (its minimum does), or null. A widget without sizes fits anywhere. */
export function fitsScreen(size: { min?: { w: number; h: number } | undefined; preferred?: { w: number; h: number } | undefined }, width: number, height: number): 'ideal' | 'fits' | null {
  const room = biggestTile(width, height);
  const inside = (s: { w: number; h: number } | undefined) => !s || (s.w <= room.w && s.h <= room.h);
  if (!inside(size.min)) return null;
  return size.preferred && !inside(size.preferred) ? 'fits' : 'ideal';
}

/** A preset as it can be mounted: as sold, and a bar or landscape panel stood on its side. */
function orientations(p: PanelPreset): { w: number; h: number; cls: PanelClassId; turned: boolean }[] {
  const asSold = { w: p.width, h: p.height, cls: panelClass(p.width, p.height, p.shape), turned: false };
  if (asSold.cls !== 'bar' && asSold.cls !== 'landscape') return [asSold];
  return [asSold, { w: p.height, h: p.width, cls: panelClass(p.height, p.width), turned: true }];
}

/** Where a widget fits among the known panels: classes (any way it can be mounted), ideal classes and presets as sold. */
export function fitsPresets(size: { min?: { w: number; h: number } | undefined; preferred?: { w: number; h: number } | undefined }, presets: readonly PanelPreset[] = PANEL_PRESETS): { fits: PanelClassId[]; ideal: PanelClassId[]; presets: string[] } {
  const fits = new Set<PanelClassId>();
  const ideal = new Set<PanelClassId>();
  const ids: string[] = [];
  for (const p of presets) {
    for (const o of orientations(p)) {
      const f = fitsScreen(size, o.w, o.h);
      if (!f) continue;
      fits.add(o.cls);
      if (f === 'ideal') ideal.add(o.cls);
      if (!o.turned && !ids.includes(p.id)) ids.push(p.id);
    }
  }
  const order = (s: Set<PanelClassId>) => (['bar', 'landscape', 'square', 'round', 'portrait'] as const).filter((c) => s.has(c));
  return { fits: order(fits), ideal: order(ideal), presets: ids };
}

/** A user's screen, as the editor knows it. */
export interface ScreenSize {
  id: string;
  name: string;
  width: number;
  height: number;
  shape?: 'rect' | 'round' | undefined;
}

/**
 * Of a plugin's widgets, which fit each of these screens: the editor's
 * "fits your 2 screens" / "fits 1 of your 2". A plugin with no widgets
 * (interludes only) fits every screen.
 */
export function fitsScreens(widgets: readonly { type: string; min?: { w: number; h: number } | undefined; preferred?: { w: number; h: number } | undefined }[], screens: readonly ScreenSize[]): { screen: string; name: string; fits: string[]; ideal: string[] }[] {
  return screens.map((s) => {
    const fits: string[] = [];
    const ideal: string[] = [];
    for (const w of widgets) {
      const f = fitsScreen(w, s.width, s.height);
      if (f) fits.push(w.type);
      if (f === 'ideal') ideal.push(w.type);
    }
    return { screen: s.id, name: s.name, fits, ideal };
  });
}
