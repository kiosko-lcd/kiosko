/** The band at the top with the alerts active now: what, since when, and «Seen» / «Snooze». */
import { useState } from 'preact/hooks';
import type { AlertInfo } from '../api.ts';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { clock, errorText, t, tr } from '../i18n.ts';
import { alerts, notify } from '../store.ts';

/** How many rows before "and N more". */
const ROWS = 3;

/** An icon of the editor for the alert: its own (a Lucide name), else by level. */
const iconOf = (a: AlertInfo) => (a.icon && /^[a-z0-9-]+$/.test(a.icon) ? a.icon : a.level === 'info' ? 'info' : a.level === 'critical' ? 'octagon-alert' : 'triangle-alert');

export function AlertBand() {
  const [busy, setBusy] = useState<string | null>(null);
  const shown = alerts.value.filter((a) => !a.snoozedUntil);
  if (!shown.length) return null;
  const act = async (a: AlertInfo, what: 'ack' | 'snooze') => {
    setBusy(a.id);
    try {
      const r = what === 'ack' ? await api.ackAlert(a.id) : await api.snoozeAlert(a.id, 10);
      alerts.value = r.alerts;
      if (what === 'snooze') notify(tr('alerts.snoozed'), 'ok');
    } catch (err) {
      notify(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section class={`alert-band ${shown[0]!.level}`} role="alert" aria-label={tr('alerts.band')}>
      {shown.slice(0, ROWS).map((a) => (
        <div class={`alert-row ${a.level}`} key={a.id}>
          <span class="alert-icon">
            {a.icon && !/^[a-z0-9-]+$/.test(a.icon) ? <b>{a.icon}</b> : <Icon name={iconOf(a)} size={20} />}
          </span>
          <div class="alert-what">
            <strong>{a.title}</strong>
            <span class="muted small">
              {a.origin === 'test' ? `${tr('alerts.test')} · ` : ''}
              {tr(`level.${a.level}`)} · {t('alerts.since', { time: clock(a.since) })}
              {a.source ? ` · ${a.source}` : ''}
              {a.text ? ` · ${a.text}` : ''}
            </span>
            {a.detail && <span class="alert-detail small">{a.detail}</span>}
          </div>
          {a.dismissible ? (
            <div class="alert-actions">
              <button class="btn ghost small" disabled={busy === a.id} onClick={() => act(a, 'snooze')}>
                <Icon name="alarm-clock" size={14} /> {tr('alerts.snooze')}
              </button>
              <button class="btn small alert-seen" disabled={busy === a.id} onClick={() => act(a, 'ack')}>
                <Icon name="check" size={14} /> {tr('alerts.seen')}
              </button>
            </div>
          ) : <span class="muted small">{tr('alerts.stays')}</span>}
        </div>
      ))}
      {shown.length > ROWS && <div class="muted small alert-more">{t('alerts.more', { n: shown.length - ROWS })}</div>}
    </section>
  );
}
