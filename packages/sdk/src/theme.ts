/**
 * Themes are design tokens, not CSS: every widget paints with `ctx.theme`, so
 * switching the theme restyles the whole panel without touching a plugin.
 *
 * The default (`midnight`) is the art direction of the original aimonitor:
 * the normal state is darkness, and colour is spent only on what claims you.
 */
export interface ThemeColors {
  /** Panel background. Kept near black: it's the backlight that wears out. */
  bg: string;
  /** Card background and its 1 px edge. */
  surface: string;
  surfaceEdge: string;
  /** Text: primary, secondary and hints. */
  ink: string;
  inkDim: string;
  inkFaint: string;
  /** Brand/selection colour. */
  accent: string;
  /** Semaphore shared by every widget: needs you now / soon / informative / fine. */
  alert: string;
  warn: string;
  info: string;
  ok: string;
}

export interface ThemeFonts {
  /** Condensed sans: titles, numbers. */
  sans: string;
  sansBold: string;
  mono: string;
  monoBold: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
  fonts: ThemeFonts;
  /** Card corner radius in px. */
  radius: number;
  /** Card title size in px (scaled for small panels by the compositor). */
  titleSize: number;
}

/** Font families registered by the runtime (see core/fonts.ts). */
export const FONT_FAMILIES: ThemeFonts = {
  sans: 'KioskoSans',
  sansBold: 'KioskoSansBold',
  mono: 'KioskoMono',
  monoBold: 'KioskoMonoBold',
};

const base = { fonts: FONT_FAMILIES, radius: 12, titleSize: 30 };

export const THEMES: Theme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    ...base,
    colors: { bg: '#05080D', surface: '#0D131A', surfaceEdge: '#1C2631', ink: '#D3DFEA', inkDim: '#627180', inkFaint: '#384450', accent: '#4DA3FF', alert: '#F5453D', warn: '#FFB020', info: '#4DA3FF', ok: '#3FCB7E' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    ...base,
    radius: 6,
    colors: { bg: '#111214', surface: '#1A1C1F', surfaceEdge: '#2A2D31', ink: '#ECEDEE', inkDim: '#8B9096', inkFaint: '#4A4F55', accent: '#E8E8E8', alert: '#FF5F57', warn: '#FEBC2E', info: '#64B5F6', ok: '#28C840' },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    ...base,
    radius: 16,
    colors: { bg: '#0B0A1A', surface: '#15132B', surfaceEdge: '#2A2550', ink: '#EDE9FF', inkDim: '#8D86B8', inkFaint: '#4A4475', accent: '#9F7AEA', alert: '#FF4D8D', warn: '#FFC857', info: '#4CC9F0', ok: '#43E5A0' },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    ...base,
    radius: 2,
    fonts: { ...FONT_FAMILIES, sans: FONT_FAMILIES.mono, sansBold: FONT_FAMILIES.monoBold },
    colors: { bg: '#020602', surface: '#061006', surfaceEdge: '#0F2A0F', ink: '#7CFF7C', inkDim: '#2F9E3A', inkFaint: '#165C1E', accent: '#7CFF7C', alert: '#FF5A3C', warn: '#FFD23C', info: '#5CE1E6', ok: '#7CFF7C' },
  },
  {
    id: 'paper',
    name: 'Paper',
    ...base,
    radius: 10,
    colors: { bg: '#F2EFE8', surface: '#FFFFFF', surfaceEdge: '#DDD8CC', ink: '#1F2328', inkDim: '#6B6F76', inkFaint: '#B4B0A6', accent: '#2F6FEB', alert: '#D92D20', warn: '#C27803', info: '#2F6FEB', ok: '#1E8E3E' },
  },
];

export const DEFAULT_THEME = THEMES[0]!;

export function themeById(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}
