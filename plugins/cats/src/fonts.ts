/**
 * Families the scene writes with. They are the ones the runtime always
 * registers (DejaVu, bundled), not the theme's: the room is an illustration
 * and keeps its look whatever theme the panel uses.
 */
import { FONT_FAMILIES } from '@tessera/sdk';

/** Condensed bold: sign boards, cards. */
export const COND = FONT_FAMILIES.sansBold;
/** Condensed regular, for very large figures. */
export const COND_REGULAR = FONT_FAMILIES.sans;
export const MONO = FONT_FAMILIES.mono;
export const MONO_BOLD = FONT_FAMILIES.monoBold;
