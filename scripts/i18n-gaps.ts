/**
 * Every text of a plugin (or of Kiosko) that lacks a language: each
 * `{ en, es, … }` object in the source, wherever it is used (names,
 * options, what is painted on the panel, plural forms, errors), with its
 * file, line and English text.
 *
 *   node --conditions=source scripts/i18n-gaps.ts <folder> <language>
 *   node --conditions=source scripts/i18n-gaps.ts ../kiosko-plugin-weather/src de
 *
 * Exits 1 when something lacks it. Kiosko's own test does the same for
 * every language it speaks (packages/web/landing/languages.test.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

export interface Gap {
  file: string;
  line: number;
  en: string;
}

/** The `{ en, es, … }` texts under `dir` (tests and build output left out) that lack `lang`. */
export function i18nGaps(dir: string, lang: string): Gap[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (!['node_modules', 'dist', 'shims'].includes(f)) walk(p);
      } else if (/\.tsx?$/.test(f) && !/\.(test|d)\.tsx?$/.test(f)) files.push(p);
    }
  };
  walk(dir);
  const name = (p: import('typescript').ObjectLiteralElementLike) => (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
  const isText = (e: import('typescript').Expression) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e);
  const gaps: Gap[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: import('typescript').Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const props = n.properties.filter(ts.isPropertyAssignment);
        const keys = props.map(name);
        // A localized text: en and es, every value a string or template (not a table of tables).
        if (keys.includes('en') && keys.includes('es') && props.length === n.properties.length && props.every((p) => isText(p.initializer)) && !keys.includes(lang)) {
          const en = props.find((p) => name(p) === 'en')!.initializer.getText(sf);
          gaps.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, en: en.length > 70 ? `${en.slice(0, 67)}…` : en });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return gaps;
}

if (import.meta.main) {
  const [dir, lang] = process.argv.slice(2);
  if (!dir || !lang) {
    console.log('usage: node --conditions=source scripts/i18n-gaps.ts <folder> <language>');
    process.exit(2);
  }
  const gaps = i18nGaps(dir, lang);
  for (const g of gaps) console.log(`${relative(process.cwd(), g.file)}:${g.line}  ${g.en}`);
  console.log(gaps.length ? `\n${gaps.length} texts lack ${lang}` : `every text has ${lang}`);
  process.exit(gaps.length ? 1 : 0);
}
