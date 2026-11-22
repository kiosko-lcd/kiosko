/**
 * A newer Kiosko: the notice in the top bar (every view; dismissed per
 * version), the card in Plugins → Updates (how this Kiosko was installed,
 * what to do, what's new, which plugin updates it unlocks) and, where Kiosko
 * can do it itself, the "Update Kiosko" dialog with its steps. After a
 * restart the editor waits for the new version to answer and reloads.
 */
import { effect, signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { parseNotes, type Inline } from '@kiosko/core/release-notes';
import { api, type KioskoUpdateInfo, type KioskoUpdateState, type KioskoUpdateStatus, type UpdateStepCode } from '../api.ts';
import { Icon } from '../icons.tsx';
import { dateTime, errorText, listOf, sentences, t, tr } from '../i18n.ts';
import { en, type Key } from '../lang/index.ts';
import { app, kioskoStatus, notify, online, serverVersion } from '../store.ts';

const DISMISSED = 'kiosko.updateDismissed';
const AWAITING = 'kiosko.updatingTo';
const JUST = 'kiosko.justUpdated';

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};
const session = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** The version whose notice was closed: it comes back for the next one. */
const dismissed = signal<string | null>(store.get(DISMISSED));
/** Waiting for Kiosko to come back as this version (after the button restarted it). */
export const awaiting = signal<{ version: string; since: number } | null>(null);
/** It hasn't come back in time. */
const stalled = signal(false);

/** A newer Kiosko the check found (never in the browser demo). */
export function kioskoNews(): KioskoUpdateInfo | null {
  if (KIOSKO_DEMO) return null;
  return app.value?.updates?.kiosko ?? null;
}

/** What the Plugins badge counts for Kiosko: 1 when there is a newer one. */
export const kioskoCount = () => (kioskoNews() ? 1 : 0);

const status = (): KioskoUpdateStatus | null => kioskoStatus.value ?? app.value?.kioskoUpdate?.status ?? null;
const busy = (s = status()) => !!s && (s.state === 'working' || s.state === 'restarting');

// ---------- after a restart ----------

let polling: ReturnType<typeof setInterval> | null = null;
function startAwaiting(version: string, since = Date.now()): void {
  if (awaiting.value?.version === version) return;
  awaiting.value = { version, since };
  session.set(AWAITING, JSON.stringify(awaiting.value));
  stalled.value = false;
  if (polling) clearInterval(polling);
  polling = setInterval(() => void checkBack(), 2000);
}
function stopAwaiting(): void {
  awaiting.value = null;
  session.set(AWAITING, null);
  if (polling) clearInterval(polling);
  polling = null;
}

/** Who answers now: the new version → reload (its editor may have changed too); the old one with a failure → show it. */
async function checkBack(): Promise<void> {
  const a = awaiting.value;
  if (!a) return;
  const limit = status()?.restart === 'installer' ? 240_000 : 120_000;
  if (Date.now() - a.since > limit) stalled.value = true;
  try {
    const v = await api.version();
    if (v.version === a.version) {
      session.set(JUST, a.version);
      stopAwaiting();
      location.reload();
      return;
    }
    // The old one answers: did the restart fail? Its status says.
    const st = await api.kioskoUpdate();
    if (st.status.state === 'failed' || st.status.state === 'idle') {
      kioskoStatus.value = st.status;
      stopAwaiting();
    }
  } catch {
    /* not up yet */
  }
}

/** Once, after the editor boots: the toast of a finished update, and the watch for restarts. */
export function watchKioskoUpdates(): void {
  if (KIOSKO_DEMO) return;
  const just = session.get(JUST);
  if (just) {
    session.set(JUST, null);
    if (app.value?.version === just) notify(t('kupd.justUpdated', { v: just }), 'ok');
  }
  try {
    const a = JSON.parse(session.get(AWAITING) ?? 'null') as { version: string; since: number } | null;
    if (a?.version && app.value?.version !== a.version) startAwaiting(a.version, a.since);
    else session.set(AWAITING, null);
  } catch {
    session.set(AWAITING, null);
  }
  effect(() => {
    const s = kioskoStatus.value;
    if (s?.state === 'restarting' && s.target) startAwaiting(s.target);
  });
  effect(() => {
    // A (re)connection: if waiting, ask at once.
    if (online.value && serverVersion.value && awaiting.value) void checkBack();
  });
}

// ---------- the top bar ----------

/** "Kiosko 0.2.9 is out", in the top bar of every view, until closed for that version. */
export function KioskoNotice() {
  const k = kioskoNews();
  const s = status();
  if (KIOSKO_DEMO) return null;
  if (busy(s) || awaiting.value) {
    return (
      <a class="kiosko-notice working" href="#/plugins/updates">
        <Icon name="loader" size={14} class="spin" /> <span>{tr('kupd.noticeUpdating')}</span>
      </a>
    );
  }
  if (!k || dismissed.value === k.latest) return null;
  return (
    <span class="kiosko-notice">
      <a href="#/plugins/updates" title={t('updates.kiosko', { latest: k.latest, current: k.current })}>
        <Icon name="sparkles" size={14} /> <span>{t('kupd.notice', { v: k.latest })}</span>
      </a>
      <button class="kiosko-notice-x" title={tr('kupd.dismiss')} aria-label={tr('kupd.dismiss')} onClick={() => {
        dismissed.value = k.latest;
        store.set(DISMISSED, k.latest);
      }}>
        <Icon name="x" size={13} />
      </button>
    </span>
  );
}

// ---------- release notes ----------

function Parts({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p) => (p.t === 'code' ? <code>{p.text}</code> : p.t === 'b' ? <b>{p.text}</b> : p.t === 'a' ? <a href={p.href} target="_blank" rel="noreferrer noopener">{p.text}</a> : p.text))}
    </>
  );
}

/** One release's notes, drawn from blocks (release-notes-md.ts): text only, never HTML. */
function NotesBody({ body }: { body: string }) {
  const blocks = parseNotes(body);
  const out: preact.JSX.Element[] = [];
  let items: preact.JSX.Element[] = [];
  const flush = () => {
    if (items.length) out.push(<ul>{items}</ul>);
    items = [];
  };
  for (const b of blocks) {
    if (b.t === 'li') items.push(<li><Parts parts={b.parts} /></li>);
    else {
      flush();
      out.push(b.t === 'h' ? <h5><Parts parts={b.parts} /></h5> : <p><Parts parts={b.parts} /></p>);
    }
  }
  flush();
  return <div class="release-notes-body">{out}</div>;
}

function WhatsNew({ k }: { k: KioskoUpdateInfo }) {
  const n = k.notes;
  type Release = NonNullable<KioskoUpdateInfo['notes']>['releases'][number];
  const releases: Release[] = n?.releases ?? k.versions.map((version) => ({ version, url: `https://github.com/kiosko-lcd/kiosko/releases/tag/v${version}` }));
  if (!releases.length) return null;
  return (
    <details class="release-notes" open>
      <summary>{tr('kupd.whatsNew')}</summary>
      {n?.from !== 'github' && <p class="muted small">{t('kupd.noNotes', { list: listOf(releases.map((r) => r.version)) })}</p>}
      {releases.map((r) => (
        <section class="release">
          <h4>
            <a href={r.url} target="_blank" rel="noreferrer noopener">{r.name ?? `Kiosko ${r.version}`}</a>
            {r.date && <span class="muted small"> · {dateTime(Date.parse(r.date))}</span>}
          </h4>
          {r.body && <NotesBody body={r.body} />}
          {r.truncated && <p class="small"><a href={r.url} target="_blank" rel="noreferrer noopener">{tr('kupd.more')}</a></p>}
        </section>
      ))}
    </details>
  );
}

// ---------- the card ----------

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="kupd-command">
      <code class="mono">{text}</code>
      <button class="btn ghost small" onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}>
        <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? tr('common.copied') : tr('common.copy')}
      </button>
    </div>
  );
}

/** How it was installed, and as what it runs, in one line. */
function installLine(u: KioskoUpdateState): string {
  const kind = t(`kupd.kind.${u.install.kind}` as Key, { dir: u.install.dir });
  return u.install.service ? sentences(kind, tr(`kupd.service.${u.install.service}` as Key)) : kind;
}

/** What to do by hand, per install kind. */
function Instructions({ u }: { u: KioskoUpdateState }) {
  const i = u.instructions;
  if (!i) return null;
  if (i.kind === 'windows-installer') {
    return (
      <div class="kupd-how">
        <p>{t('kupd.how.windows-installer', { v: i.version })}</p>
        <p class="kupd-links">
          {i.download && <a class="btn small" href={i.download} rel="noreferrer noopener"><Icon name="download" size={13} /> {tr('kupd.download')}</a>}
          <a class="btn ghost small" href={i.url} target="_blank" rel="noreferrer noopener"><Icon name="external-link" size={13} /> {tr('kupd.release')}</a>
        </p>
      </div>
    );
  }
  return (
    <div class="kupd-how">
      <p>{tr(i.stopFirst ? 'kupd.how.npmStop' : (`kupd.how.${i.kind}` as Key))}</p>
      {i.command && <Command text={i.command} />}
      <p class="small"><a href={i.url} target="_blank" rel="noreferrer noopener">{tr('kupd.release')}</a></p>
    </div>
  );
}

/** Plugin updates that wait for this Kiosko ("needs a newer Kiosko"). */
function Unlocks({ k }: { k: KioskoUpdateInfo }) {
  const a = app.value!;
  const list = (a.updates?.plugins ?? []).filter((p) => p.unlockedBy && p.unlockedBy === k.latest);
  if (!list.length) return null;
  const nameOf = (id: string) => a.catalog.find((p) => p.id === id)?.name ?? id;
  return (
    <p class="kupd-unlocks">
      <Icon name="lock-open" size={14} /> {t('kupd.unlocks', { list: listOf(list.map((p) => `${nameOf(p.id)} ${p.latest}`)) })}
    </p>
  );
}

/** Kiosko itself in Plugins → Updates. */
export function KioskoCard() {
  const k = kioskoNews();
  const u = app.value?.kioskoUpdate;
  const [open, setOpen] = useState(false);
  const s = status();
  if (!k || !u) return null;
  const going = s && s.state !== 'idle' && s.target === k.latest;
  return (
    <section class="card kupd-card">
      <div class="card-head">
        <h3>
          <Icon name="sparkles" size={16} /> {t('updates.kiosko', { latest: k.latest, current: k.current })}
        </h3>
        <div class="tb-spacer" />
        {u.canUpdate && (
          <button class="btn small primary" disabled={busy(s)} onClick={() => setOpen(true)}>
            <Icon name={busy(s) ? 'loader' : 'circle-arrow-up'} size={13} /> {t('kupd.button', { v: k.latest })}
          </button>
        )}
      </div>
      <p class="muted small">{installLine(u)}</p>
      {!u.canUpdate && u.blocker && u.blocker !== 'demo' && <p class="small">{tr(`kupd.why.${u.blocker}` as Key)}</p>}
      <Instructions u={u} />
      <Unlocks k={k} />
      {going && !open && <Progress s={s} u={u} />}
      <WhatsNew k={k} />
      {open && <UpdateDialog k={k} u={u} onClose={() => setOpen(false)} />}
    </section>
  );
}

// ---------- the dialog ----------

const STEP_KEYS: Record<UpdateStepCode, Key> = {
  prefix: 'kupd.step.prefix',
  install: 'kupd.step.install',
  verify: 'kupd.step.verify',
  selfCheck: 'kupd.step.selfCheck',
  rollback: 'kupd.step.rollback',
  restart: 'kupd.step.restart',
  download: 'kupd.step.download',
  hash: 'kupd.step.hash',
  launch: 'kupd.step.launch',
};

/** Where to look when the new Kiosko doesn't come back. */
function whereToLook(s: KioskoUpdateStatus, u: KioskoUpdateState): string {
  if (s.restart === 'systemd') return 'journalctl --user -u kiosko';
  if (s.restart === 'launchd') return '~/Library/Logs/kiosko.log';
  if (s.restart === 'installer') return '%APPDATA%\\Kiosko\\kiosko.log, %TEMP%\\kiosko-update-*\\install.log';
  return s.logFile ?? u.install.dir;
}

/** The steps so far, the outcome, and what to do if it failed. */
function Progress({ s, u }: { s: KioskoUpdateStatus; u: KioskoUpdateState }) {
  const err = s.error;
  const hint = (code: string) => tr(`kupd.err.${code}` in en ? (`kupd.err.${code}` as Key) : 'kupd.err.failed');
  return (
    <div class="kupd-progress" aria-live="polite">
      <ol class="kupd-steps">
        {s.steps.map((st) => (
          <li class={st.ok === null ? 'run' : st.ok ? 'ok' : 'bad'}>
            <Icon name={st.ok === null ? 'loader' : st.ok ? 'circle-check' : 'circle-x'} size={14} class={st.ok === null ? 'spin' : ''} />
            <span>{tr(STEP_KEYS[st.code])}</span>
            {st.detail && <small class="mono muted">{st.detail}</small>}
          </li>
        ))}
      </ol>
      {s.warnings.length > 0 && <p class="banner warn small">{t('kupd.warnings', { list: listOf(s.warnings) })}</p>}
      {s.state === 'restarting' && !stalled.value && (
        <p class="small"><Icon name="loader" size={13} class="spin" /> {tr(s.restart === 'installer' ? 'kupd.restartingInstaller' : 'kupd.restarting')}</p>
      )}
      {s.state === 'restarting' && stalled.value && <div class="banner error small">{t('kupd.stalled', { where: whereToLook(s, u) })}</div>}
      {s.state === 'done' && s.restart === 'manual' && <div class="banner info small">{t('kupd.doneManual', { v: s.target ?? '' })}</div>}
      {s.state === 'failed' && err && (
        <div class="banner error small">
          <p><b>{tr('kupd.failed')}</b></p>
          <p>{s.rolledBack ? sentences(hint(err.code), t('kupd.rolledBack', { v: s.from })) : hint(err.code)}</p>
          {(err.code === 'rollbackFailed' || err.code === 'prefixMismatch' || err.code === 'installFailed') && u.instructions?.command && <Command text={err.code === 'rollbackFailed' ? `npm install -g kiosko@${s.from}` : u.instructions.command} />}
          <details class="small">
            <summary>{tr('kupd.details')}</summary>
            <p class="mono">{err.detail}</p>
          </details>
        </div>
      )}
    </div>
  );
}

function UpdateDialog({ k, u, onClose }: { k: KioskoUpdateInfo; u: KioskoUpdateState; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [asked, setAsked] = useState(false);
  const s = status();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const mine = s && s.target === k.latest && s.state !== 'idle' ? s : null;
  const windows = u.install.kind === 'windows-installer';
  const go = async () => {
    setAsked(true);
    try {
      const r = await api.startKioskoUpdate(k.latest);
      kioskoStatus.value = r.status;
    } catch (err) {
      setAsked(false);
      notify(errorText(err), 'error');
    }
  };
  const run = async () => {
    try {
      const r = await api.confirmKioskoUpdate(k.latest);
      kioskoStatus.value = r.status;
    } catch (err) {
      notify(errorText(err), 'error');
    }
  };
  const cancel = async () => {
    if (mine?.state === 'ready') {
      const r = await api.cancelKioskoUpdate().catch(() => null);
      if (r) kioskoStatus.value = r.status;
    }
    ref.current?.close();
  };
  const command = u.instructions?.command ?? `npm install -g kiosko@${k.latest}`;
  return (
    <dialog ref={ref} class="store-dialog kupd-dialog" onClose={onClose} onCancel={(e) => busy(mine ?? undefined) && e.preventDefault()}>
      <h3>{t('kupd.confirmTitle', { v: k.latest })}</h3>
      {!mine && !asked && (
        <>
          <p>{windows ? t('kupd.confirmWin', { v: k.latest }) : tr('kupd.confirmNpm')}</p>
          {!windows && <Command text={command} />}
          <p class="small">{sentences(t(`kupd.restart.${u.restart}` as Key, { log: `${app.value?.paths.home ?? ''}/kiosko.log` }), tr('kupd.blank'))}</p>
        </>
      )}
      {mine && <Progress s={mine} u={u} />}
      {mine?.state === 'ready' && (
        <div class="banner info small">
          <p>{t('kupd.verified', { hash: mine.sha256 ?? '' })}</p>
          <p>{sentences(tr(u.install.perUser ? 'kupd.silent' : 'kupd.wizard'), tr('kupd.restart.installer'))}</p>
        </div>
      )}
      <div class="dialog-actions">
        {(!mine || mine.state === 'ready' || mine.state === 'failed' || mine.state === 'done') && (
          <button class="btn ghost" onClick={cancel}>{tr(mine && mine.state !== 'ready' ? 'common.close' : 'common.cancel')}</button>
        )}
        {!mine && (
          <button class="btn primary" disabled={asked} onClick={go}>
            <Icon name={asked ? 'loader' : windows ? 'download' : 'circle-arrow-up'} size={14} /> {tr(windows ? 'kupd.startWin' : 'kupd.start')}
          </button>
        )}
        {mine?.state === 'ready' && (
          <button class="btn primary" onClick={run}>
            <Icon name="play" size={14} /> {tr('kupd.run')}
          </button>
        )}
        {mine?.state === 'failed' && (
          <a class="btn" href={u.instructions?.url ?? '#'} target="_blank" rel="noreferrer noopener"><Icon name="external-link" size={13} /> {tr('kupd.release')}</a>
        )}
      </div>
    </dialog>
  );
}
