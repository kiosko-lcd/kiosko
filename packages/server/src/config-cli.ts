/**
 * `kiosko config …`: the config file from a terminal, for people and for the
 * AI assistants that write configs for them.
 *
 *   kiosko config schema [--out file] [--config path]
 *       JSON Schema of config.json with the plugins installed here. The
 *       published one (official plugins) lives at CONFIG_SCHEMA_ID.
 *   kiosko config validate <file|-> [--json]
 *       Errors (exit 1) and warnings with JSON paths, worded so they can be
 *       pasted back to the AI that wrote the file.
 *   kiosko config import <file|-> [--apply] [--preview dir | --no-preview] [--port n] [--host h]
 *       Dry run unless --apply: validation, what changes, a PNG per page,
 *       every value that runs programs, contacts hosts or reads paths, and
 *       what happens to secrets. --apply backs up the current config and
 *       applies the new one through the running Kiosko (editor and panels
 *       update at once) or, if none serves this config, writes the file.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CONFIG_SCHEMA_ID, configSchema, loadConfig, planImport, saveConfig, summarizeDiff, validateConfig, type Config, type ImportPlan, type JsonIssue, type Registry, type RiskItem } from '@kiosko/core';
import type { Risk } from '@kiosko/sdk';
import { renderPreviews } from './preview.ts';

export interface ConfigCliContext {
  registry: () => Promise<Registry>;
  /** The config in use (`--config` or the default path). */
  configPath: string;
}

const USAGE = `kiosko config schema [--out file] [--config path]
kiosko config validate <file|-> [--json]
kiosko config import <file|-> [--apply] [--preview dir | --no-preview] [--port n] [--host h] [--config path]`;

const VALUED = new Set(['--out', '--config', '--preview', '--port', '--host']);

function parse(argv: string[]): { sub: string | undefined; file: string | undefined; flags: Set<string>; opts: Map<string, string> } {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUED.has(a)) opts.set(a, argv[++i] ?? '');
    else if (a.startsWith('--')) flags.add(a);
    else rest.push(a);
  }
  return { sub: rest[0], file: rest[1], flags, opts };
}

/* ---------- Output ---------- */

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const red = paint('31');
const yellow = paint('33');
const green = paint('32');
const dim = paint('2');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function issueLine(i: JsonIssue): string {
  const ctx = i.context && !i.message.includes(i.context) && !i.path.includes(i.context) ? ` (${i.context})` : '';
  return `${i.path}${ctx}: ${i.message}`;
}

/* ---------- Reading a config file ---------- */

/** A config file as an AI may hand it over: with a BOM, or inside a ```json block. `-` reads stdin. */
export function readConfigText(text: string): { value?: unknown; error?: string; notes: string[] } {
  const notes: string[] = [];
  let t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fence = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/.exec(t);
  if (fence) {
    t = fence[1]!;
    notes.push('the file is wrapped in a ``` code block: read what is inside it');
  }
  if (!t.trim()) return { error: 'the file is empty', notes };
  try {
    return { value: JSON.parse(t), notes };
  } catch (err) {
    return { error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}. Write plain JSON, with no comments or trailing commas`, notes };
  }
}

function readInput(file: string): { value?: unknown; error?: string; notes: string[]; name: string } {
  const name = file === '-' ? '(stdin)' : file;
  if (file !== '-' && !existsSync(file)) return { error: `not found: ${file}`, notes: [], name };
  return { ...readConfigText(readFileSync(file === '-' ? 0 : file, 'utf8')), name };
}

const pluginDefs = (r: Registry) => r.list().map((p) => p.def);

/* ---------- The running Kiosko ---------- */

interface Running {
  base: string;
  rev: number;
  config: Config;
  servedPath: string;
  /** It serves the config we are about to replace. */
  same: boolean;
}

/** The Kiosko listening where `cfg.server` (or --host/--port) says, if any, and which config it serves. */
async function findRunning(cfg: Config, configPath: string, o: { host?: string; port?: string }): Promise<Running | null> {
  const host0 = o.host || cfg.server.host || '127.0.0.1';
  const host = host0 === '0.0.0.0' || host0 === '::' ? '127.0.0.1' : host0;
  const port = Number(o.port || cfg.server.port);
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  try {
    const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const s = (await r.json()) as { rev?: unknown; config?: Config; paths?: { config?: string } };
    if (typeof s.rev !== 'number' || !s.config) return null;
    const servedPath = s.paths?.config ?? '';
    return { base, rev: s.rev, config: s.config, servedPath, same: !!servedPath && resolve(servedPath) === resolve(configPath) };
  } catch {
    return null;
  }
}

/** Local time, `20261109-143005`, for backup and preview names. */
const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/* ---------- Commands ---------- */

async function schemaCommand(ctx: ConfigCliContext, opts: Map<string, string>): Promise<number> {
  const reg = await ctx.registry();
  const plugins = pluginDefs(reg);
  const schema = configSchema(plugins);
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  const out = opts.get('--out');
  if (!out) {
    process.stdout.write(text);
    return 0;
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, text);
  const count = (k: 'widgets' | 'sources' | 'interludes') => plugins.reduce((n, p) => n + (p[k]?.length ?? 0), 0);
  console.error(`${out}: schema of config.json with ${plural(count('widgets'), 'widget')}, ${plural(count('sources'), 'source')} and ${plural(count('interludes'), 'interlude')} from ${plural(plugins.length, 'plugin')}`);
  const rel = relative(dirname(resolve(ctx.configPath)), resolve(out));
  console.error(`The published schema (official plugins) is ${CONFIG_SCHEMA_ID}. With plugins of your own, point the config at this file instead:\n  "$schema": ${JSON.stringify(isAbsolute(rel) || rel.startsWith('..') ? resolve(out) : rel)}`);
  return 0;
}

async function validateCommand(ctx: ConfigCliContext, file: string | undefined, flags: Set<string>): Promise<number> {
  if (!file) {
    console.error(`usage: ${USAGE.split('\n')[1]}`);
    return 2;
  }
  const json = flags.has('--json');
  const input = readInput(file);
  if (input.error) {
    const e: JsonIssue = { path: '(file)', pointer: '', message: input.error };
    if (json) console.log(JSON.stringify({ ok: false, file: input.name, schema: CONFIG_SCHEMA_ID, errors: [e], warnings: [], notes: input.notes }, null, 2));
    else console.log(`${input.name}: ${red(input.error)}`);
    return 1;
  }
  const reg = await ctx.registry();
  const report = validateConfig(input.value, pluginDefs(reg));
  const ok = report.errors.length === 0;
  if (json) {
    console.log(JSON.stringify({ ok, file: input.name, schema: CONFIG_SCHEMA_ID, errors: report.errors, warnings: report.warnings, notes: input.notes }, null, 2));
    return ok ? 0 : 1;
  }
  for (const n of input.notes) console.log(dim(`note: ${n}`));
  if (ok && !report.warnings.length) {
    console.log(`${input.name}: ${green('valid')}`);
    return 0;
  }
  console.log(`${input.name}: ${ok ? green('valid') : red(plural(report.errors.length, 'error'))}${report.warnings.length ? `, ${yellow(plural(report.warnings.length, 'warning'))}` : ''}`);
  if (report.errors.length) console.log(`\n${bold('Errors')} (Kiosko would misread these):\n${report.errors.map((i) => `  ${issueLine(i)}`).join('\n')}`);
  if (report.warnings.length) console.log(`\n${bold('Warnings')} (harmless, but worth a look):\n${report.warnings.map((i) => `  ${issueLine(i)}`).join('\n')}`);
  console.log(dim(`\nPaths are JSON paths into the file. If an AI wrote it, paste these lines back to it with the schema ${CONFIG_SCHEMA_ID}.`));
  return ok ? 0 : 1;
}

const RISK_TITLE: Record<Risk, string> = { exec: 'Runs programs (exec)', network: 'Contacts hosts (network)', path: 'Reads paths (path)' };

function printRisks(risks: RiskItem[]): void {
  const fresh = risks.filter((r) => r.isNew).length;
  console.log(`\n${bold('Values to review')}${risks.length ? ` (${fresh ? yellow(`${fresh} new`) : 'none new'}; NEW = not in your current config)` : ''}`);
  if (!risks.length) {
    console.log('  none: no value runs a program, contacts a host or reads a path');
    return;
  }
  for (const kind of ['exec', 'network', 'path'] as const) {
    const list = risks.filter((r) => r.risk === kind);
    console.log(`  ${RISK_TITLE[kind]}${list.length ? '' : ': none'}`);
    for (const r of list) {
      const ctx = r.context && !r.path.includes(r.context) ? ` (${r.context})` : '';
      const value = r.secret ? r.shown : JSON.stringify(r.value);
      console.log(`    ${r.isNew ? yellow('NEW ') : '    '} ${r.path}${ctx} = ${r.isNew ? bold(value) : value}${r.isDefault ? dim(' (the default)') : ''}`);
    }
  }
}

function printSecrets(s: ImportPlan['secrets']): void {
  if (!s.kept.length && !s.toFill.length && !s.provided.length) return;
  const line = (i: { path: string; title?: string; note?: string }) => `    ${i.path}${i.title ? ` (${i.title})` : ''}${i.note ? `: ${i.note}` : ''}`;
  console.log(`\n${bold('Secrets')}`);
  if (s.kept.length) console.log(`  kept from your current config:\n${s.kept.map(line).join('\n')}`);
  if (s.toFill.length) console.log(`  ${yellow('to fill in the editor')} (left empty):\n${s.toFill.map(line).join('\n')}`);
  if (s.provided.length) console.log(`  set by the file itself (saved as written; check you meant to share them):\n${s.provided.map(line).join('\n')}`);
}

async function importCommand(ctx: ConfigCliContext, file: string | undefined, flags: Set<string>, opts: Map<string, string>): Promise<number> {
  if (!file) {
    console.error(`usage: ${USAGE.split('\n')[2]}`);
    return 2;
  }
  const apply = flags.has('--apply');
  const input = readInput(file);
  if (input.error) {
    console.log(`${input.name}: ${red(input.error)}`);
    return 1;
  }
  const path = ctx.configPath;
  const onDisk = loadConfig(path);
  if (onDisk.error) {
    console.log(red(`the current config ${path} is not valid JSON (${onDisk.error}): fix it or move it away first`));
    return 1;
  }
  const running = await findRunning(onDisk.config, path, { host: opts.get('--host'), port: opts.get('--port') });
  const current = running?.same ? running.config : onDisk.config;
  const reg = await ctx.registry();
  const plan = planImport(input.value, current, pluginDefs(reg));

  console.log(`${bold(`Importing ${input.name}`)} into ${path}${apply ? '' : dim(' (dry run)')}`);
  console.log(dim(`current config: ${running?.same ? `the one the running Kiosko at ${running.base} uses` : onDisk.exists ? 'the file' : 'none yet (a new one)'}`));
  for (const n of input.notes) console.log(dim(`note: ${n}`));

  const { errors, warnings } = plan.report;
  if (errors.length) {
    console.log(`\n${red(plural(errors.length, 'error'))}${warnings.length ? `, ${yellow(plural(warnings.length, 'warning'))}` : ''}: fix these first (if an AI wrote the file, paste them back to it)`);
    for (const i of errors) console.log(`  ${issueLine(i)}`);
    for (const i of warnings) console.log(`  ${dim('warning')} ${issueLine(i)}`);
    console.log(dim('\nNothing was written.'));
    return 1;
  }
  const c = plan.config;
  const pages = c.screens.reduce((n, s) => n + s.pages.length, 0);
  const tiles = c.screens.reduce((n, s) => n + s.pages.reduce((m, p) => m + p.tiles.length, 0), 0);
  console.log(`\n${green('valid')}: ${plural(c.screens.length, 'screen')}, ${plural(pages, 'page')}, ${plural(tiles, 'tile')}${warnings.length ? `; ${yellow(plural(warnings.length, 'warning'))}` : ''}`);
  for (const i of warnings) console.log(`  ${dim('warning')} ${issueLine(i)}`);

  console.log(`\n${bold('Changes')}: ${summarizeDiff(plan.diff)}`);
  for (const l of plan.diff) {
    const op = l.op === '+' ? green('+') : l.op === '-' ? red('-') : yellow('~');
    console.log(`${'  '.repeat(l.depth + 1)}${op} ${l.text}`);
  }
  if (plan.carried.length) console.log(dim(`  kept from your current config (the file leaves them out): ${plan.carried.join(', ')}`));

  if (!flags.has('--no-preview')) {
    const dir = opts.get('--preview') || join(tmpdir(), `kiosko-import-${stamp()}`);
    try {
      const files = renderPreviews(reg, c, dir);
      console.log(`\n${bold('Preview')} ${dim('(sample data: nothing was read, run or fetched)')}`);
      if (!files.length) console.log('  no pages to paint');
      for (const f of files) console.log(`  ${f.file}  ${dim(`${f.screen} › ${f.page}, ${f.size}`)}${f.problems.length ? `  ${yellow(f.problems.join('; '))}` : ''}`);
    } catch (err) {
      console.log(`\n${bold('Preview')}: ${yellow(`could not paint (${err instanceof Error ? err.message : String(err)})`)}`);
    }
  }

  printRisks(plan.risks);
  printSecrets(plan.secrets);

  if (!apply) {
    console.log(`\n${dim('Dry run: nothing was written.')} Run again with --apply to back up the current config and use this one.`);
    return 0;
  }

  const backup = `${path}.bak-${stamp()}`;
  if (existsSync(path)) {
    copyFileSync(path, backup);
    try {
      chmodSync(backup, 0o600);
    } catch {
      /* Windows */
    }
  }
  const saved = existsSync(backup) ? `; the previous one is in ${backup}` : '';
  if (running?.same) {
    const r = await fetch(`${running.base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-kiosko': '1', 'x-kiosko-client': 'cli-import' },
      body: JSON.stringify({ config: c, baseRev: running.rev }),
      signal: AbortSignal.timeout(15_000),
    }).catch((err: unknown) => err as Error);
    if (r instanceof Error || !r.ok) {
      const why = r instanceof Error ? r.message : r.status === 409 ? 'the configuration changed in the editor meanwhile' : `HTTP ${r.status}`;
      console.log(red(`\nNot applied: ${why}. Run the import again${saved}.`));
      return 1;
    }
    console.log(`\n${green('Applied')} through the running Kiosko at ${running.base}: the editor and the panels update now${saved}.`);
  } else {
    saveConfig(c, path);
    console.log(`\n${green('Written')} ${path}${saved}.`);
    if (running) console.log(dim(`The Kiosko at ${running.base} uses another config (${running.servedPath}); it was not touched.`));
    else console.log(dim('No running Kiosko answered for this config: it will use the new one when it starts.'));
  }
  if (plan.secrets.toFill.length) console.log(`Fill in ${plural(plan.secrets.toFill.length, 'secret')} in the editor (Settings → Data sources, or the widget's options).`);
  if (JSON.stringify(current.server) !== JSON.stringify(c.server)) console.log(yellow(`The editor moves to ${c.server.host}:${c.server.port} after a restart.`));
  return 0;
}

/** Runs `kiosko config <sub> …`; returns the exit code. */
export async function configCommand(argv: string[], ctx: ConfigCliContext): Promise<number> {
  const { sub, file, flags, opts } = parse(argv);
  const c: ConfigCliContext = opts.get('--config') ? { ...ctx, configPath: opts.get('--config')! } : ctx;
  switch (sub) {
    case 'schema':
      return schemaCommand(c, opts);
    case 'validate':
    case 'check':
      return validateCommand(c, file, flags);
    case 'import':
      return importCommand(c, file, flags, opts);
    default:
      console.log(USAGE);
      return sub ? 2 : 0;
  }
}
