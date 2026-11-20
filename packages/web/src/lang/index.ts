/**
 * The editor's dictionaries, by language id, one file each. Every language
 * Kiosko speaks (packages/sdk/src/languages.ts) has one: a test checks it.
 */
import { en, type Key } from './en.ts';
import { es } from './es.ts';
import { zhHans } from './zh-Hans.ts';
import { zhHant } from './zh-Hant.ts';

export type { Key };
export { en };
export const DICTIONARIES: Record<string, Record<Key, string>> = { en, es, 'zh-Hant': zhHant, 'zh-Hans': zhHans };
