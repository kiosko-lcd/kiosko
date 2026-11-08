/**
 * The catalogue of plugins: the built-in ones plus whatever the user drops in
 * the plugins folder (`<home>/plugins`), either as a folder or installed from
 * npm (`tessera-plugin-*`). Types are addressed as `plugin/thing`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installSdkResolver } from './sdk-resolver.ts';
import { localize, toJsonSchema, type InterludeDefinition, type PluginDefinition, type SourceDefinition, type WidgetDefinition } from '@tessera/sdk';

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

  add(def: PluginDefinition, origin = 'builtin'): void {
    if (!def || typeof def !== 'object' || !ID.test(def.id ?? '')) {
      this.problems.push({ origin, message: `invalid plugin id ${JSON.stringify(def?.id)}` });
      return;
    }
    if (this.plugins.has(def.id)) {
      this.problems.push({ origin, message: `plugin "${def.id}" already loaded from ${this.plugins.get(def.id)!.origin}` });
      return;
    }
    this.plugins.set(def.id, { def, origin, enabled: true });
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
   * `"tessera": { "plugin": "./entry.js" }` (or a `main`), plus packages
   * installed there with npm (`node_modules/tessera-plugin-*`).
   */
  async loadDir(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    installSdkResolver();
    const candidates: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      candidates.push(join(dir, name));
    }
    const nm = join(dir, 'node_modules');
    if (existsSync(nm)) {
      for (const name of readdirSync(nm)) {
        if (name.startsWith('@')) {
          for (const sub of readdirSync(join(nm, name))) if (sub.startsWith('tessera-plugin-')) candidates.push(join(nm, name, sub));
        } else if (name.startsWith('tessera-plugin-')) candidates.push(join(nm, name));
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
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: string; tessera?: { plugin?: string } };
        const rel = pkg.tessera?.plugin ?? pkg.main;
        if (rel) entry = join(folder, rel);
      }
      if (!entry || !existsSync(entry)) {
        this.problems.push({ origin: folder, message: 'no entry point (package.json "tessera.plugin", "main" or index.js)' });
        return;
      }
      await this.loadEntry(entry, folder);
    } catch (err) {
      this.problems.push({ origin: folder, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async loadEntry(entry: string, origin: string): Promise<void> {
    const mod = (await import(pathToFileURL(entry).href)) as { default?: PluginDefinition };
    if (!mod.default) {
      this.problems.push({ origin, message: 'the module has no default export (use `export default definePlugin({...})`)' });
      return;
    }
    this.add(mod.default, origin);
  }

  /** What the editor needs to know about every widget, source and interlude (JSON-safe). */
  catalog(locale: string) {
    const L = (x: Parameters<typeof localize>[0]) => localize(x, locale);
    return this.list().map(({ def, origin, enabled }) => ({
      id: def.id,
      name: L(def.name),
      version: def.version,
      description: L(def.description),
      author: def.author,
      homepage: def.homepage,
      icon: def.icon,
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
        size: w.size ?? {},
        chrome: w.chrome ?? 'card',
        options: w.options ? toJsonSchema(w.options) : null,
        sources: w.sources ?? [],
        hasFetch: !!w.fetch,
        intervalMs: w.intervalMs ?? null,
      })),
      sources: (def.sources ?? []).map((s) => ({ type: `${def.id}/${s.id}`, name: L(s.name), description: L(s.description), options: s.options ? toJsonSchema(s.options) : null, intervalMs: s.intervalMs ?? null })),
      interludes: (def.interludes ?? []).map((i) => ({ type: `${def.id}/${i.id}`, name: L(i.name), description: L(i.description), icon: i.icon, fps: i.fps, options: i.options ? toJsonSchema(i.options) : null })),
    }));
  }
}
