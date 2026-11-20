/**
 * The catalogue of plugins: the built-in ones plus whatever the user drops in
 * the plugins folder (`<home>/plugins`), either as a folder or installed from
 * npm (`kiosko-plugin-*`). Types are addressed as `plugin/thing`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceOptionsField, sourceTiming } from './config/sources.ts';
import { declaredLanguages, fullType, incompatibility, packageMeta, pluginOf } from './plugin-meta.ts';
import { installSdkResolver } from './sdk-resolver.ts';
import { localize, toJsonSchema, type Choice, type InterludeDefinition, type PluginDefinition, type SourceDefinition, type TemplateTile, type WidgetDefinition } from '@kiosko/sdk';

export interface LoadedPlugin {
  def: PluginDefinition;
  /** `builtin`, or the folder it came from. */
  origin: string;
  enabled: boolean;
  error?: string;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

export class Registry {
  private plugins = new Map<string, LoadedPlugin>();
  /** Problems found while loading, for the editor's Plugins page. */
  readonly problems: { origin: string; message: string }[] = [];
  /**
   * Plugins found but not loaded because they don't fit this Kiosko (plugin
   * API version, operating system). Those found through their package.json
   * were refused before their code ran.
   */
  readonly refused: { id?: string; version?: string; origin: string; reason: string }[] = [];
  /** Where a plugin's code came from, to load it again (`reload`). */
  private entries = new Map<string, { entry: string; origin: string }>();
  private reloads = 0;

  private refuse(r: { id?: string | undefined; version?: string | undefined; origin: string; reason: string }): void {
    this.refused.push({ origin: r.origin, reason: r.reason, ...(r.id ? { id: r.id } : {}), ...(r.version ? { version: r.version } : {}) });
    this.problems.push({ origin: r.origin, message: `${r.id ? `"${r.id}" ` : ''}not loaded: ${r.reason}` });
  }

  add(def: PluginDefinition, origin = 'builtin'): void {
    if (!def || typeof def !== 'object' || !ID.test(def.id ?? '')) {
      this.problems.push({ origin, message: `invalid plugin id ${JSON.stringify(def?.id)}` });
      return;
    }
    const why = incompatibility(def);
    if (why) return this.refuse({ id: def.id, version: def.version, origin, reason: why });
    if (this.plugins.has(def.id)) {
      this.problems.push({ origin, message: `plugin "${def.id}" already loaded from ${this.plugins.get(def.id)!.origin}` });
      return;
    }
    this.plugins.set(def.id, { def, origin, enabled: true });
  }

  /** Forgets a plugin (removed, or about to be loaded again). Its module stays in memory: ES modules can't be unloaded. */
  remove(id: string): boolean {
    this.entries.delete(id);
    return this.plugins.delete(id);
  }

  /**
   * Imports a plugin's code again from where it came, so a rebuilt or
   * updated plugin runs without restarting Kiosko. Only its entry file is
   * read again: a plugin should be one bundled file (what `npm run build`
   * makes). Returns the problem, or null.
   */
  async reload(id: string): Promise<string | null> {
    const e = this.entries.get(id);
    if (!e) return this.plugins.has(id) ? `"${id}" is built in and can't be reloaded` : `"${id}" is not loaded`;
    const old = this.plugins.get(id)!;
    this.plugins.delete(id);
    const problems = this.problems.length;
    try {
      // Unique per reload: two within the same millisecond would get the first one's cached module.
      const def = await this.loadEntry(e.entry, e.origin, `${Date.now()}-${++this.reloads}`);
      if (def && this.plugins.has(id)) {
        this.plugins.get(id)!.enabled = old.enabled;
        return null;
      }
    } catch (err) {
      this.problems.push({ origin: e.origin, message: err instanceof Error ? err.message : String(err) });
    }
    // The new code didn't load: keep the old one running.
    this.plugins.set(id, old);
    this.entries.set(id, e);
    return this.problems.slice(problems).map((p) => p.message).join('; ') || `"${id}" did not load again`;
  }

  /** Loads one plugin folder (just installed or linked), as `loadDir` does for each. Returns the ids it added. */
  async loadOne(folder: string): Promise<string[]> {
    installSdkResolver();
    const before = new Set(this.plugins.keys());
    await this.loadFolder(folder);
    return [...this.plugins.keys()].filter((id) => !before.has(id));
  }

  /**
   * The plugins that came from npm, with their package and the version
   * installed: the ones that can be updated. Installed in the plugins folder
   * (read from their package.json) or brought along with Kiosko (`npm:`
   * origin). Built-in, linked and hand-copied plugins are left out.
   */
  packages(): { id: string; package: string; version: string }[] {
    const out: { id: string; package: string; version: string }[] = [];
    for (const { def, origin } of this.plugins.values()) {
      if (origin.startsWith('npm:')) {
        out.push({ id: def.id, package: origin.slice(4), version: def.version });
        continue;
      }
      if (!/[\\/]node_modules[\\/]/.test(origin)) continue;
      try {
        const pkg = JSON.parse(readFileSync(join(origin, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name) out.push({ id: def.id, package: pkg.name, version: pkg.version ?? def.version });
      } catch {
        /* no package.json: not something npm can update */
      }
    }
    return out;
  }

  /** Where a loaded plugin came from (its folder), or undefined for a built-in one. */
  originOf(id: string): string | undefined {
    return this.entries.get(id)?.origin;
  }

  setDisabled(ids: string[]): void {
    for (const p of this.plugins.values()) p.enabled = !ids.includes(p.def.id);
  }

  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  plugin(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  private find<K extends 'widgets' | 'sources' | 'interludes'>(kind: K, type: string): NonNullable<PluginDefinition[K]>[number] | undefined {
    const [pid, id] = type.split('/');
    const p = pid ? this.plugins.get(pid) : undefined;
    if (!p || !p.enabled) return undefined;
    return (p.def[kind] as { id: string }[] | undefined)?.find((x) => x.id === id) as NonNullable<PluginDefinition[K]>[number] | undefined;
  }

  widget(type: string): WidgetDefinition<any, any> | undefined {
    return this.find('widgets', type);
  }
  source(type: string): SourceDefinition<any, any> | undefined {
    return this.find('sources', type);
  }
  interlude(type: string): InterludeDefinition<any> | undefined {
    return this.find('interludes', type);
  }

  /**
   * Loads external plugins from `dir`: each subfolder whose package.json has
   * `"kiosko": { "plugin": "./entry.js" }` (or a `main`), plus packages
   * installed there with npm (`node_modules/kiosko-plugin-*`).
   */
  async loadDir(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    installSdkResolver();
    // A plain `index.js` with `import` statements must load as ESM even if
    // some package.json further up says otherwise.
    const marker = join(dir, 'package.json');
    if (!existsSync(marker)) {
      try {
        writeFileSync(marker, `${JSON.stringify({ name: 'kiosko-user-plugins', private: true, type: 'module' }, null, 2)}\n`);
      } catch {
        /* read-only: .mjs plugins still work */
      }
    }
    const candidates: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      candidates.push(join(dir, name));
    }
    const nm = join(dir, 'node_modules');
    if (existsSync(nm)) {
      for (const name of readdirSync(nm)) {
        if (name.startsWith('@')) {
          for (const sub of readdirSync(join(nm, name))) if (sub.startsWith('kiosko-plugin-')) candidates.push(join(nm, name, sub));
        } else if (name.startsWith('kiosko-plugin-')) candidates.push(join(nm, name));
      }
    }
    for (const folder of candidates) await this.loadFolder(folder);
  }

  private async loadFolder(folder: string): Promise<void> {
    try {
      if (!statSync(folder).isDirectory()) {
        if (/\.m?js$/.test(folder)) await this.loadEntry(folder, folder);
        return;
      }
      const pkgPath = join(folder, 'package.json');
      let entry = ['index.mjs', 'index.js'].map((f) => join(folder, f)).find(existsSync);
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: string; kiosko?: { plugin?: string } };
        // Checked before importing: an incompatible plugin's code never runs.
        const meta = packageMeta(pkg);
        const why = incompatibility(meta);
        if (why) return this.refuse({ id: meta.id, version: meta.version, origin: folder, reason: why });
        const rel = pkg.kiosko?.plugin ?? pkg.main;
        if (rel) entry = join(folder, rel);
      }
      if (!entry || !existsSync(entry)) {
        this.problems.push({ origin: folder, message: 'no entry point (package.json "kiosko.plugin", "main" or index.js)' });
        return;
      }
      await this.loadEntry(entry, folder);
    } catch (err) {
      this.problems.push({ origin: folder, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async loadEntry(entry: string, origin: string, version?: string): Promise<PluginDefinition | undefined> {
    // A query makes Node import the file again (ES modules are cached by URL): how `reload` gets new code.
    const url = pathToFileURL(entry).href + (version ? `?v=${version}` : '');
    const mod = (await import(url)) as { default?: PluginDefinition };
    if (!mod.default) {
      this.problems.push({ origin, message: 'the module has no default export (use `export default definePlugin({...})`)' });
      return undefined;
    }
    const before = this.plugins.size;
    this.add(mod.default, origin);
    if (this.plugins.size > before) this.entries.set(mod.default.id, { entry, origin });
    return mod.default;
  }

  /**
   * The values a source offers for an option (see `SourceDefinition.choices`),
   * from `data` (its latest), or from its demo data when it has none yet.
   * At most 1000, never throwing: a list that fails is empty, with why.
   */
  choices(source: string, list: string, data: unknown, locale: string): { choices: Choice[]; from: 'live' | 'demo' | 'none'; error?: string } {
    const def = this.source(source);
    const fn = def?.choices?.[list];
    if (!def || !fn) return { choices: [], from: 'none', error: def ? `${source} has no list "${list}"` : `no source ${source}` };
    const from = data !== undefined ? 'live' : def.demo ? 'demo' : 'none';
    if (from === 'none') return { choices: [], from };
    try {
      const value = from === 'live' ? data : def.demo!({ now: Date.now(), locale });
      const out = fn(value, { locale, t: (x) => localize(x, locale) });
      const clean = (Array.isArray(out) ? out : [])
        .filter((c): c is Choice => !!c && typeof c.value === 'string' && c.value !== '')
        .slice(0, 1000)
        .map((c) => ({ value: c.value, ...(typeof c.label === 'string' && c.label !== c.value ? { label: c.label } : {}), ...(typeof c.group === 'string' ? { group: c.group } : {}) }));
      return { choices: clean, from };
    } catch (err) {
      return { choices: [], from, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** What the editor needs to know about every widget, source and interlude (JSON-safe). */
  catalog(locale: string) {
    const L = (x: Parameters<typeof localize>[0]) => localize(x, locale);
    const has = (type: string) => !!(this.widget(type) ?? this.source(type) ?? this.interlude(type));
    return this.list().map(({ def, origin, enabled }) => ({
      id: def.id,
      name: L(def.name),
      version: def.version,
      description: L(def.description),
      author: def.author,
      homepage: def.homepage,
      repository: def.repository,
      license: def.license,
      icon: def.icon,
      sdk: def.sdk ?? null,
      platforms: def.platforms ?? null,
      /** The languages its texts come in (declared, or read from its texts). */
      languages: declaredLanguages(def),
      permissions: def.permissions ?? {},
      /** What it needs from other plugins, and whether that is here (installed and on). */
      requires: (def.requires ?? []).map((type) => ({ type, plugin: pluginOf(type), ok: has(type) })),
      /** What it uses from other plugins when they are there. */
      optional: (def.optional ?? []).map((type) => ({ type, plugin: pluginOf(type), ok: has(type) })),
      templates: (def.templates ?? []).map((tp) => {
        // Bare widget ids are the plugin's own: written out in full for the editor.
        const tiles = (list: TemplateTile[] | undefined): TemplateTile[] | undefined =>
          list?.map((tile) => ({ ...tile, widgets: tile.widgets.map((w): TemplateTile['widgets'][number] => (typeof w === 'string' ? fullType(def.id, w) : [fullType(def.id, w[0]), w[1]])) }));
        return { id: `${def.id}/${tp.id}`, name: L(tp.name), icon: tp.icon ?? 'layout-template', wide: tiles(tp.wide)!, square: tiles(tp.square), tall: tiles(tp.tall) };
      }),
      builtin: origin === 'builtin',
      origin,
      enabled,
      widgets: (def.widgets ?? []).map((w) => ({
        type: `${def.id}/${w.id}`,
        name: L(w.name),
        description: L(w.description),
        icon: w.icon,
        category: w.category ?? 'info',
        tags: w.tags ?? [],
        /** Its name and description in every language it has, so a search in any of them finds it. */
        searchText: [w.name, w.description].flatMap((x) => (x === undefined ? [] : typeof x === 'string' ? [x] : Object.values(x))).join(' '),
        size: w.size ?? {},
        chrome: w.chrome ?? 'card',
        options: w.options ? toJsonSchema(w.options) : null,
        sources: w.sources ?? [],
        hasFetch: !!w.fetch,
        intervalMs: w.intervalMs ?? null,
        // Defaults of the instance switches, or null when the widget lacks the hook behind them.
        takeOver: w.urgent ? (w.takeOver ?? true) : null,
        hideWhenEmpty: w.empty ? (w.hideWhenEmpty ?? false) : null,
      })),
      sources: (def.sources ?? []).map((s) => {
        // Its own options plus Kiosko's intervalMs and timeoutMs (polled sources).
        const field = sourceOptionsField(s);
        return { type: `${def.id}/${s.id}`, name: L(s.name), description: L(s.description), options: field ? toJsonSchema(field) : null, intervalMs: s.read ? sourceTiming(s).intervalMs : null, polled: !!s.read };
      }),
      interludes: (def.interludes ?? []).map((i) => ({ type: `${def.id}/${i.id}`, name: L(i.name), description: L(i.description), icon: i.icon, fps: i.fps, options: i.options ? toJsonSchema(i.options) : null })),
    }));
  }
}
