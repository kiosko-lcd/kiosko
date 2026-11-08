/**
 * Today and tomorrow. A port of MMM-Todoist with sources you already have
 * instead of an account on a service:
 *
 *   - a Markdown file of yours with checkboxes under `## Today` and
 *     `## Tomorrow` (or `## Hoy` / `## Mañana`); a box with a date
 *     (`@2026-10-14` or `📅 2026-10-14`) goes to the day it belongs to, and if
 *     that day is gone, to today marked as late. Ticked boxes (`- [x]`) are
 *     left out;
 *   - optionally, the GitLab issues assigned to you that are due today or
 *     tomorrow, and the overdue ones (through the `glab` CLI).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { defineWidget, t } from '@tessera/sdk';
import { clamp, dayKey, expandHome } from './util.ts';

const execFileAsync = promisify(execFile);

export interface TaskItem {
  kind: 'task' | 'issue' | 'meeting';
  text: string;
  /** `HH:MM`, for meetings. */
  time?: string;
  /** Was due before today. */
  late?: boolean;
}

export interface TasksData {
  today: TaskItem[];
  tomorrow: TaskItem[];
}

const TODAY = /^(today|hoy)\b/i;
const TOMORROW = /^(tomorrow|mañana|manana)\b/i;

/** The open checkboxes of the file, split between today and tomorrow. */
export function parseTaskFile(text: string, now: number): TasksData {
  const today = dayKey(now), tomorrow = dayKey(now + 86_400_000);
  const out: TasksData = { today: [], tomorrow: [] };
  let section: 'today' | 'tomorrow' | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) {
      const h = head[1]!.trim();
      section = TODAY.test(h) ? 'today' : TOMORROW.test(h) ? 'tomorrow' : null;
      continue;
    }
    const item = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (!item || item[1] !== ' ') continue;
    let body = item[2]!.trim();
    const date = /(?:@|📅\s*)(\d{4}-\d{2}-\d{2})/u.exec(body)?.[1];
    if (date) body = body.replace(/\s*(?:@|📅\s*)\d{4}-\d{2}-\d{2}/u, '').trim();
    if (date) {
      if (date < today) out.today.push({ kind: 'task', text: body, late: true });
      else if (date === today) out.today.push({ kind: 'task', text: body });
      else if (date === tomorrow) out.tomorrow.push({ kind: 'task', text: body });
    } else if (section) {
      out[section].push({ kind: 'task', text: body });
    }
  }
  return out;
}

/** GitLab issues (REST shape) due today, tomorrow or already overdue. */
export function issuesByDay(issues: { title: string; due_date?: string | null; references?: { short?: string } }[], now: number): TasksData {
  const today = dayKey(now), tomorrow = dayKey(now + 86_400_000);
  const out: TasksData = { today: [], tomorrow: [] };
  for (const i of issues) {
    if (!i.due_date) continue;
    const text = `${i.references?.short ?? ''} ${i.title}`.trim();
    if (i.due_date < today) out.today.push({ kind: 'issue', text, late: true });
    else if (i.due_date === today) out.today.push({ kind: 'issue', text });
    else if (i.due_date === tomorrow) out.tomorrow.push({ kind: 'issue', text });
  }
  return out;
}

/** Meetings first, by time; then what's late; then the rest. */
export function sortTasks(list: TaskItem[]): TaskItem[] {
  const rank = (t: TaskItem) => (t.kind === 'meeting' ? 0 : t.late ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.time ?? '').localeCompare(b.time ?? ''));
}

const DEMO: TasksData = {
  today: [
    { kind: 'meeting', text: 'Team stand-up', time: '11:30' },
    { kind: 'issue', text: '#214 Login button misaligned on mobile', late: true },
    { kind: 'task', text: 'Review the quarterly budget' },
    { kind: 'task', text: 'Call the dentist' },
  ],
  tomorrow: [
    { kind: 'issue', text: '#231 Update the onboarding docs' },
    { kind: 'task', text: 'Buy a birthday present' },
  ],
};

export const tasks = defineWidget({
  id: 'tasks',
  name: { en: 'Today and tomorrow', es: 'Hoy y mañana' },
  description: {
    en: 'Your to-dos for today and tomorrow, from a Markdown checklist and, optionally, your GitLab issues.',
    es: 'Lo que tienes para hoy y mañana, de una lista de casillas en Markdown y, si quieres, de tus issues de GitLab.',
  },
  icon: 'list-checks',
  category: 'productivity',
  tags: ['magicmirror', 'todo'],
  size: { min: { w: 240, h: 140 }, preferred: { w: 400, h: 440 } },
  options: t.object({
    file: t.string({
      default: '~/tasks.md',
      format: 'path',
      label: { en: 'Checklist file', es: 'Fichero de tareas' },
      help: {
        en: 'Markdown with "- [ ] …" boxes under "## Today" and "## Tomorrow"; "@2026-10-14" dates a box.',
        es: 'Markdown con casillas «- [ ] …» bajo «## Hoy» y «## Mañana»; «@2026-10-14» le pone fecha.',
      },
    }),
    gitlab: t.boolean({ label: { en: 'Add my GitLab issues with a due date', es: 'Añadir mis issues de GitLab con fecha' } }),
    bin: t.string({ default: 'glab', format: 'path', advanced: true, label: { en: 'glab command', es: 'Comando glab' }, help: { en: 'The GitLab CLI, already logged in.', es: 'El CLI de GitLab, con la sesión iniciada.' } }),
  }),
  intervalMs: 10 * 60_000,
  async fetch({ options, now, log, signal }): Promise<TasksData> {
    const data: TasksData = { today: [], tomorrow: [] };
    const add = (d: TasksData) => {
      data.today.push(...d.today);
      data.tomorrow.push(...d.tomorrow);
    };
    if (options.file) {
      try {
        add(parseTaskFile(await readFile(expandHome(options.file), 'utf8'), now));
      } catch {
        // No file, no tasks of your own.
      }
    }
    if (options.gitlab) {
      try {
        const { stdout } = await execFileAsync(options.bin || 'glab', ['api', 'issues?scope=assigned_to_me&state=opened&due_date=next_month_and_previous_two_weeks&per_page=100'], { timeout: 20_000, maxBuffer: 8_000_000, signal });
        add(issuesByDay(JSON.parse(stdout), now));
      } catch (err) {
        log(`no GitLab issues: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
    return { today: sortTasks(data.today), tomorrow: sortTasks(data.tomorrow) };
  },
  render(g, { data, box, theme, kit, t: tr }) {
    if (!data) return;
    const { colors, fonts } = theme;
    // Wide and short tiles get today and tomorrow side by side; otherwise
    // today on top and tomorrow below, full width (in two narrow columns the
    // texts were left with a dozen letters).
    const columns = box.w >= 520 && box.w >= box.h * 2.4;
    // Rows as tall as the lists allow, within readable limits.
    const nT = Math.max(1, data.today.length), nM = Math.max(1, data.tomorrow.length);
    const fit = columns ? box.h / (Math.max(nT, nM) + 0.86) : box.h / (nT + nM + 1.87);
    const rowH = clamp(fit, 20, Math.min(40, box.w / 9));
    const size = Math.round(rowH * 0.76);
    const small = Math.round(rowH * 0.62);
    const headH = Math.round(rowH * 0.86);
    const label = (title: string, x: number, top: number) =>
      kit.drawTracked(g, title, x, top + headH * 0.72, { size: small, family: fonts.sans, color: colors.inkDim, smallCaps: true, tracking: 1 });
    /** Paints a list in `rows` rows from `top`; returns where it ended. */
    const section = (title: string, items: TaskItem[], x: number, w: number, top: number, rows: number) => {
      label(title, x, top);
      const at = (i: number) => top + headH + i * rowH + rowH * 0.72;
      if (!items.length) {
        kit.drawTracked(g, tr({ en: 'Nothing', es: 'Nada' }), x, at(0), { size, family: fonts.sans, color: colors.inkFaint });
        return top + headH + rowH;
      }
      // When something doesn't fit, the last row says how many are left;
      // with a single row, that count goes at its end instead.
      const shown = items.length <= rows ? items : items.slice(0, Math.max(1, rows - 1));
      const hidden = items.length - shown.length;
      const tail = hidden && shown.length >= rows ? `+${hidden}` : '';
      const tailW = tail ? kit.measureTracked(g, tail, { size: small, family: fonts.sans }) + small * 0.5 : 0;
      shown.forEach((it, i) => {
        const base = at(i);
        let tx = x;
        if (it.kind === 'meeting' && it.time) {
          tx += kit.drawTracked(g, it.time, x, base, { size: small, family: fonts.mono, color: colors.info }) + small * 0.5;
        } else {
          tx += kit.drawTracked(g, it.kind === 'issue' ? '◆' : '•', x, base, { size: small, family: fonts.sans, color: it.late ? colors.alert : colors.inkDim }) + small * 0.5;
        }
        const o = { size, family: fonts.sans, color: it.late ? colors.alert : colors.ink };
        const last = i === shown.length - 1;
        kit.drawTracked(g, kit.truncate(g, it.text, x + w - tx - (last ? tailW : 0), o), tx, base, o);
        if (last && tail) kit.drawTracked(g, tail, x + w, base, { size: small, family: fonts.sans, color: colors.inkDim, align: 'right' });
      });
      let used = shown.length;
      if (hidden && !tail) {
        kit.drawTracked(g, `+${items.length - shown.length} ${tr({ en: 'more', es: 'más' })}`, x, at(used), { size: small, family: fonts.sans, color: colors.inkDim });
        used++;
      }
      return top + headH + used * rowH;
    };
    const today = tr({ en: 'Today', es: 'Hoy' }), tomorrow = tr({ en: 'Tomorrow', es: 'Mañana' });
    if (columns) {
      const gap = rowH;
      const cw = (box.w - gap) / 2;
      const rows = Math.max(1, Math.floor((box.h - headH) / rowH + 0.1));
      section(today, data.today, box.x, cw, box.y, rows);
      section(tomorrow, data.tomorrow, box.x + cw + gap, cw, box.y, rows);
      return;
    }
    const total = Math.floor((box.h - 2 * headH) / rowH + 0.1);
    if (total < 3) {
      // Too short for both lists: today, and tomorrow as a one-line count.
      const rows = Math.max(1, Math.floor((box.h - headH) / rowH + 0.1) - (data.tomorrow.length ? 1 : 0));
      const end = section(today, data.today, box.x, box.w, box.y, rows);
      if (data.tomorrow.length) {
        const s = `${tomorrow}: ${data.tomorrow.length}`;
        kit.drawTracked(g, kit.truncate(g, s, box.w, { size: small, family: fonts.sans }), box.x, end + rowH * 0.72, { size: small, family: fonts.sans, color: colors.inkDim });
      }
      return;
    }
    // Today takes the room it needs, leaving tomorrow two rows (one when tight).
    const keep = Math.min(total >= 6 ? 2 : 1, data.tomorrow.length || 1);
    const todayRows = Math.max(1, Math.min(data.today.length || 1, total - keep));
    const next = section(today, data.today, box.x, box.w, box.y, todayRows);
    const left = Math.floor((box.y + box.h - next - rowH * 0.15 - headH) / rowH + 0.1);
    if (left >= 1) section(tomorrow, data.tomorrow, box.x, box.w, next + rowH * 0.15, left);
  },
  demo: () => ({ data: DEMO }),
});
