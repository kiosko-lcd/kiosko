/**
 * What is new in Kiosko itself, for the editor's update notice: the GitHub
 * release notes of every version between the one running and the newest,
 * and where the newest release's Windows installer (and its .sha256) is.
 *
 * Read once a day with the update check, unauthenticated (GitHub allows 60
 * requests an hour per address; this is one). Where GitHub can't be reached
 * (mainland China, a proxy), the versions npm lists stand in for the notes:
 * the check never fails because of it.
 */
import { compareVersions, parseVersion, type HttpClient } from '@kiosko/sdk';

export const GITHUB_REPO = 'kiosko-lcd/kiosko';
export const GITHUB_API = 'https://api.github.com';
/** Each release's page: `https://github.com/kiosko-lcd/kiosko/releases/tag/v0.2.9`. */
export const releasePage = (version: string) => `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`;
/** The Windows installer's file name for a version, as scripts/build-windows-installer.mjs names it. */
export const windowsInstallerName = (version: string) => `Kiosko-Setup-${version}-x64.exe`;
/** Where GitHub serves a release's file (a redirect to its storage). */
export const releaseAsset = (version: string, name: string) => `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${name}`;

/** How long one release's notes may be, and how many releases are kept: the notice is a summary, the page has the rest. */
export const NOTES_MAX_CHARS = 3000;
export const NOTES_MAX_RELEASES = 10;

export interface KioskoRelease {
  version: string;
  /** The release's title ("Kiosko 0.2.9"). */
  name?: string;
  /** Its notes, in GitHub's Markdown, trimmed (`truncated`). Plain text to the editor: it is never shown as HTML. */
  body?: string;
  truncated?: boolean;
  url: string;
  /** ISO date it was published. */
  date?: string;
}

export interface KioskoNotes {
  /** Where the list came from: GitHub's releases, or (GitHub unreachable) npm's version list without notes. */
  from: 'github' | 'npm';
  /** Newest first: the versions after the one running, up to the newest. */
  releases: KioskoRelease[];
  /** Why GitHub couldn't be read, when it couldn't. */
  error?: string;
  /** The newest release's Windows installer and its checksum file, when GitHub lists them. */
  windows?: { name: string; exe: string; sha256: string };
}

interface GitHubRelease {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

/** Stable versions only, as the update check offers them. */
const stable = (v: string) => {
  const x = parseVersion(v);
  return !!x && !x[3];
};

/** `v0.2.9` → `0.2.9` (a tag that isn't a version → null). */
export const tagVersion = (tag: string | undefined) => {
  const v = (tag ?? '').replace(/^v/, '');
  return parseVersion(v) ? v : null;
};

/** Cuts notes at a line end before `max` characters, and drops the comment blocks GitHub's template leaves. */
export function trimNotes(body: string, max = NOTES_MAX_CHARS): { body: string; truncated: boolean } {
  const clean = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= max) return { body: clean, truncated: false };
  const cut = clean.lastIndexOf('\n', max);
  return { body: clean.slice(0, cut > max / 2 ? cut : max).trimEnd(), truncated: true };
}

/** The versions after `current`, up to `latest`, newest first, from npm's list. */
export function versionsBetween(all: string[], current: string, latest: string): string[] {
  return all.filter((v) => stable(v) && compareVersions(v, current) > 0 && compareVersions(v, latest) <= 0).sort((a, b) => compareVersions(b, a));
}

/**
 * The notes of the versions after `current` up to `latest`. `npmVersions`
 * (the versions npm has) are the fallback when GitHub can't be read, and
 * fill in a version GitHub has no release for. Never throws.
 */
export async function kioskoReleaseNotes(current: string, latest: string, o: { http: HttpClient; npmVersions?: string[]; api?: string; signal?: AbortSignal }): Promise<KioskoNotes> {
  const fromNpm = versionsBetween(o.npmVersions ?? [latest], current, latest).slice(0, NOTES_MAX_RELEASES).map((version) => ({ version, url: releasePage(version) }));
  let list: GitHubRelease[];
  try {
    const r = await o.http.json<GitHubRelease[]>(`${o.api ?? GITHUB_API}/repos/${GITHUB_REPO}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, ...(o.signal ? { signal: o.signal } : {}) });
    if (!Array.isArray(r.data)) throw new Error('GitHub did not answer with a list of releases');
    list = r.data;
  } catch (err) {
    return { from: 'npm', releases: fromNpm, error: err instanceof Error ? err.message : String(err) };
  }
  const byVersion = new Map<string, GitHubRelease>();
  for (const g of list) {
    const v = tagVersion(g.tag_name);
    if (v && !g.draft && !g.prerelease && stable(v)) byVersion.set(v, g);
  }
  const versions = [...new Set([...fromNpm.map((r) => r.version), ...versionsBetween([...byVersion.keys()], current, latest)])].sort((a, b) => compareVersions(b, a)).slice(0, NOTES_MAX_RELEASES);
  const releases = versions.map((version): KioskoRelease => {
    const g = byVersion.get(version);
    if (!g) return { version, url: releasePage(version) };
    const notes = g.body ? trimNotes(g.body) : null;
    // Only GitHub's own pages as the link: the notice opens it in a new tab.
    const url = g.html_url?.startsWith(`https://github.com/${GITHUB_REPO}/`) ? g.html_url : releasePage(version);
    return { version, ...(g.name ? { name: g.name } : {}), ...(notes?.body ? { body: notes.body, ...(notes.truncated ? { truncated: true } : {}) } : {}), url, ...(g.published_at ? { date: g.published_at } : {}) };
  });
  const newest = byVersion.get(latest);
  const name = windowsInstallerName(latest);
  const asset = (n: string) => newest?.assets?.find((a) => a.name === n)?.browser_download_url;
  const exe = asset(name);
  const sha = asset(`${name}.sha256`);
  const ours = (u: string | undefined) => !!u && u.startsWith(`https://github.com/${GITHUB_REPO}/releases/download/`);
  return { from: 'github', releases, ...(ours(exe) && ours(sha) ? { windows: { name, exe: exe!, sha256: sha! } } : {}) };
}
