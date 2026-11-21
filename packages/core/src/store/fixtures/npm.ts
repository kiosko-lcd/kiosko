/** Test helper: npm packuments and manifests of made-up plugins. */
import core from '@kiosko/plugin-core';
import { pluginManifest, type PluginManifest } from '../../plugin-meta.ts';
import type { Packument } from '../build.ts';

const I = (n: number) => `sha512-${Buffer.alloc(64, n).toString('base64')}`;

/** A package with these versions (oldest first), each published a day after the one before. */
export function packument(name: string, versions: string[], o: { latest?: string; deprecated?: Record<string, string>; pkg?: Record<string, unknown>; attest?: string[] } = {}): Packument {
  const time: Record<string, string> = { created: '2026-10-01T00:00:00.000Z' };
  const vs: Record<string, Record<string, any>> = {};
  versions.forEach((v, i) => {
    time[v] = new Date(Date.UTC(2026, 9, 1 + i)).toISOString();
    vs[v] = {
      name,
      version: v,
      license: 'MIT',
      repository: { type: 'git', url: `git+https://github.com/ana/${name}.git` },
      bugs: { url: `https://github.com/ana/${name}/issues` },
      kiosko: { sdk: '^0.2.0' },
      ...(o.pkg ?? {}),
      dist: { integrity: I(i + 1), tarball: `https://registry.npmjs.org/${name}/-/${name}-${v}.tgz`, ...(o.attest?.includes(v) ? { attestations: { url: 'x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } : {}) },
      ...(o.deprecated?.[v] ? { deprecated: o.deprecated[v] } : {}),
    };
  });
  return { name, 'dist-tags': { latest: o.latest ?? versions.filter((v) => !v.includes('-')).at(-1)! }, versions: vs, time, maintainers: [{ name: 'ana' }] };
}

/** The manifest of a made-up plugin, as `kiosko plugins manifest` writes it. */
export function manifest(id: string, version: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  const base = pluginManifest(core, { pkg: { name: `kiosko-plugin-${id}` } });
  return JSON.parse(JSON.stringify({ ...base, id, package: `kiosko-plugin-${id}`, version, name: { en: id[0]!.toUpperCase() + id.slice(1), es: `${id} (es)` }, widgets: base.widgets.slice(0, 2).map((w) => ({ ...w, type: `${id}/${w.type.split('/')[1]}` })), sources: [], interludes: [], templates: [], ...extra }));
}
