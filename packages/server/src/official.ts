/**
 * The official plugins: kept with Kiosko, each in its own repository
 * (`kiosko-plugin-<id>`) and published to npm. Imports nothing, so the build
 * scripts read the same list.
 *
 * - **Bundled** ones are installed with Kiosko (the npm package's
 *   optionalDependencies, the Windows installer) and are part of the browser
 *   demo.
 * - **Optional** ones are only offered on the Plugins page, for whoever wants
 *   them: never installed by default. For plugins that are heavy, niche, or
 *   under another licence (`doom` is GPL and runs its engine in a process of
 *   its own; `video` needs ffmpeg; `fractals` spends CPU while it plays;
 *   `gaming`, `logs` and `hazards` are for some setups only).
 */
export const BUNDLED_PLUGIN_IDS = ['agents', 'cats', 'system', 'vitals', 'usage', 'weather', 'calendar', 'news', 'mirror', 'gitlab', 'github', 'calls', 'timesheet', 'llm', 'gpu', 'homeassistant'] as const;

export const OPTIONAL_PLUGIN_IDS = ['doom', 'video', 'fractals', 'gaming', 'logs', 'hazards'] as const;

export interface OfficialPlugin {
  id: string;
  npm: string;
  /** Installed with Kiosko; `false`: offered on the Plugins page only. */
  bundled: boolean;
}

/** Bundled first, in this order, then the optional ones. */
export const OFFICIAL_PLUGINS: OfficialPlugin[] = [
  ...BUNDLED_PLUGIN_IDS.map((id) => ({ id, npm: `kiosko-plugin-${id}`, bundled: true })),
  ...OPTIONAL_PLUGIN_IDS.map((id) => ({ id, npm: `kiosko-plugin-${id}`, bundled: false })),
];

export const BUNDLED_PLUGINS = OFFICIAL_PLUGINS.filter((o) => o.bundled);
