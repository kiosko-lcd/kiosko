/**
 * The editor's dictionaries, by language id, one file each. Every language
 * Kiosko speaks (packages/sdk/src/languages.ts) has one: a test checks it.
 */
import { en, type Dictionary, type Key, type PluralKey } from './en.ts';
import { es } from './es.ts';
import { de } from './de.ts';
import { zhHans } from './zh-Hans.ts';
import { zhHant } from './zh-Hant.ts';

export type { Dictionary, Key, PluralKey };
export { en };
export const DICTIONARIES: Record<string, Dictionary> = { en, es, de, 'zh-Hant': zhHant, 'zh-Hans': zhHans };
