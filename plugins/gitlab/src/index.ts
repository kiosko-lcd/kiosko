/**
 * GitLab at a glance: the pipelines of your open merge requests (broken
 * first, in red) and the merge requests waiting for your review. Both read
 * one shared source, configured once in Settings → Sources.
 */
import { defineSource, definePlugin, defineWidget, t } from '@tessera/sdk';
import { age, demoMergeRequests, pipelineLook, readMergeRequests, shortRef, type MyMergeRequests } from './gitlab.ts';

export * from './gitlab.ts';

const SOURCE = 'gitlab/merge-requests';

export const mergeRequests = defineSource({
  id: 'merge-requests',
  name: { en: 'GitLab merge requests', es: 'Merge requests de GitLab' },
  description: {
    en: 'Your open merge requests and the ones you are asked to review, through glab or a token.',
    es: 'Tus merge requests abiertas y las que te piden revisar, con glab o con un token.',
  },
  options: t.object({
    host: t.string({ placeholder: 'gitlab.com', label: { en: 'GitLab host', es: 'Servidor de GitLab' }, help: { en: 'Empty = glab\'s default host (gitlab.com with a token).', es: 'Vacío = el servidor por defecto de glab (gitlab.com con token).' } }),
    token: t.string({ secret: true, label: { en: 'Access token', es: 'Token de acceso' }, help: { en: 'A personal access token with read_api. Empty = use the glab CLI and its login.', es: 'Un token personal con read_api. Vacío = usar el CLI glab y su sesión.' } }),
    bin: t.string({ default: 'glab', format: 'path', advanced: true, label: { en: 'glab command', es: 'Comando glab' } }),
  }),
  intervalMs: 3 * 60_000,
  read: ({ options, signal }) => readMergeRequests(options, signal),
  demo: ({ now }) => demoMergeRequests(now),
});

const aliasesField = () =>
  t.map({
    advanced: true,
    label: { en: 'Short project names', es: 'Nombres cortos de proyecto' },
    help: { en: 'Project (as in its path) → what to show, e.g. web-frontend → web.', es: 'Proyecto (como en su ruta) → lo que se muestra, p. ej. web-frontend → web.' },
    keyLabel: { en: 'Project', es: 'Proyecto' },
    valueLabel: { en: 'Show as', es: 'Mostrar como' },
  });

const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as MyMergeRequests | undefined;

export const pipelines = defineWidget({
  id: 'pipelines',
  name: { en: 'My pipelines', es: 'Mis pipelines' },
  description: {
    en: 'The pipeline of each of your open merge requests: broken first, then running and queued, passing last.',
    es: 'El pipeline de cada una de tus merge requests abiertas: lo roto primero, luego lo que corre y espera, lo que pasa al final.',
  },
  icon: 'git-pull-request',
  category: 'dev',
  tags: ['gitlab', 'ci'],
  size: { min: { w: 280, h: 100 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    includeDrafts: t.boolean({ label: { en: 'Include drafts', es: 'Incluir borradores' } }),
    aliases: aliasesField(),
  }),
  render(g, { options, sources, box, theme, kit, t: tr }) {
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const list = data.authored
      .filter((m) => options.includeDrafts || !m.draft)
      .map((m) => ({ m, look: pipelineLook(m.pipeline, colors) }))
      .sort((a, b) => a.look.rank - b.look.rank || b.m.updatedAt.localeCompare(a.m.updatedAt));
    if (!list.length) {
      const s = Math.round(Math.min(32, box.h * 0.3));
      kit.drawTracked(g, kit.truncate(g, tr({ en: 'No open merge requests', es: 'Ninguna MR abierta' }), box.w, { size: s, family: fonts.sans }), box.x, box.y + s * 1.1, { size: s, family: fonts.sans, color: colors.inkDim });
      return;
    }
    const more = (n: number, x: number, y: number, size: number) =>
      kit.drawTracked(g, `+${n} ${tr({ en: 'more', es: 'más' })}`, x, y, { size, family: fonts.sans, color: colors.inkDim });
    // Tall tiles: two lines per merge request (title; reference and status).
    if (box.h >= box.w * 0.7 && box.h / list.length >= 50) {
      const rowH = Math.min(80, box.h / list.length, box.w / 5);
      const ts = Math.round(rowH * 0.4), ms = Math.round(rowH * 0.3);
      const rows = Math.max(1, Math.floor(box.h / rowH + 0.1));
      const shown = list.length <= rows ? list : list.slice(0, rows - 1);
      const dot = ts * 0.28;
      const tx = box.x + dot * 3.4;
      shown.forEach(({ m, look }, i) => {
        const top = box.y + i * rowH;
        g.fillStyle = look.color;
        g.beginPath();
        g.arc(box.x + dot * 1.1, top + ts * 0.66, dot, 0, Math.PI * 2);
        g.fill();
        const o = { size: ts, family: fonts.sans, color: look.rank === 0 ? colors.ink : colors.inkDim };
        kit.drawTracked(g, kit.truncate(g, m.title, box.x + box.w - tx, o), tx, top + ts, o);
        const lw = kit.drawTracked(g, tr(look.label), tx, top + ts + ms * 1.45, { size: ms, family: fonts.sans, color: look.color });
        const ref = { size: ms, family: fonts.mono, color: colors.inkDim };
        kit.drawTracked(g, kit.truncate(g, shortRef(m.reference, options.aliases), box.x + box.w - tx - lw - ms, ref), tx + lw + ms * 0.8, top + ts + ms * 1.45, ref);
      });
      if (shown.length < list.length) more(list.length - shown.length, tx, box.y + shown.length * rowH + ts, ms);
      return;
    }
    const rowH = Math.max(22, Math.min(46, box.h / Math.max(3, list.length), box.w / 10));
    const rows = Math.max(1, Math.floor(box.h / rowH + 0.1));
    const shown = list.length <= rows ? list : list.slice(0, rows - 1);
    const ref = { size: Math.round(rowH * 0.56), family: fonts.mono };
    const lab = { size: Math.round(rowH * 0.56), family: fonts.sans };
    const refs = shown.map(({ m }) => shortRef(m.reference, options.aliases));
    const refW = Math.max(...refs.map((r) => kit.measureTracked(g, r, ref)));
    const labW = Math.max(...shown.map(({ look }) => kit.measureTracked(g, tr(look.label), lab)));
    const dot = rowH * 0.2;
    const x0 = box.x + dot * 3.4;
    // References only when they leave the titles at least half the width.
    const withRef = box.x + box.w - x0 - refW - labW - rowH * 0.8 >= box.w * 0.5;
    shown.forEach(({ m, look }, i) => {
      const base = box.y + i * rowH + rowH * 0.72;
      g.fillStyle = look.color;
      g.beginPath();
      g.arc(box.x + dot * 1.1, base - rowH * 0.22, dot, 0, Math.PI * 2);
      g.fill();
      if (withRef) kit.drawTracked(g, refs[i]!, x0, base, { ...ref, color: colors.inkDim });
      const lw = kit.drawTracked(g, tr(look.label), box.x + box.w, base, { ...lab, color: look.color, align: 'right' });
      const tx = withRef ? x0 + refW + rowH * 0.4 : x0;
      const o = { size: Math.round(rowH * 0.7), family: fonts.sans, color: look.rank === 0 ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, m.title, box.x + box.w - lw - rowH * 0.4 - tx, o), tx, base, o);
    });
    if (shown.length < list.length) more(list.length - shown.length, x0, box.y + shown.length * rowH + rowH * 0.72, lab.size);
  },
  demo: ({ now }) => ({ sources: { [SOURCE]: demoMergeRequests(now) } }),
});

export const reviews = defineWidget({
  id: 'reviews',
  name: { en: 'Reviews for me', es: 'Te toca revisar' },
  description: {
    en: 'Merge requests waiting for your review: whose, how long they have waited and how their pipeline is doing. The ones you approved sink, dimmed.',
    es: 'Las merge requests que te toca revisar: de quién son, cuánto llevan esperando y cómo va su pipeline. Las que ya aprobaste bajan, atenuadas.',
  },
  icon: 'git-branch',
  category: 'dev',
  tags: ['gitlab', 'code review'],
  size: { min: { w: 280, h: 100 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    includeDrafts: t.boolean({ label: { en: 'Include drafts', es: 'Incluir borradores' } }),
    hideApproved: t.boolean({ label: { en: 'Hide the ones I approved', es: 'Ocultar las que ya aprobé' } }),
    aliases: aliasesField(),
  }),
  redraw: 'minute',
  visible: ({ options, sources }) => {
    const data = dataOf(sources);
    return Boolean(data?.toReview.some((m) => (options.includeDrafts || !m.draft) && !(options.hideApproved && m.approvedBy.includes(data.me))));
  },
  render(g, { options, sources, now, box, theme, kit, t: tr, locale }) {
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const list = data.toReview
      .filter((m) => options.includeDrafts || !m.draft)
      .map((m) => ({ m, done: m.approvedBy.includes(data.me) }))
      .filter((x) => !(options.hideApproved && x.done))
      // Pending first and, among them, whatever has waited longest.
      .sort((a, b) => Number(a.done) - Number(b.done) || a.m.createdAt.localeCompare(b.m.createdAt));
    if (!list.length) {
      const s = Math.round(Math.min(32, box.h * 0.3));
      kit.drawTracked(g, kit.truncate(g, tr({ en: 'Nothing to review', es: 'Nada que revisar' }), box.w, { size: s, family: fonts.sans }), box.x, box.y + s * 1.1, { size: s, family: fonts.sans, color: colors.inkDim });
      return;
    }
    const rowH = Math.max(40, Math.min(84, box.h / Math.max(2, list.length), box.w / 5.5));
    const rows = Math.max(1, Math.floor(box.h / rowH + 0.1));
    const ts = Math.round(rowH * 0.4), ms = Math.round(rowH * 0.28);
    list.slice(0, rows).forEach(({ m, done }, i) => {
      const top = box.y + i * rowH;
      const look = pipelineLook(m.pipeline, colors);
      const t1 = { size: ts, family: fonts.sans, color: done ? colors.inkDim : colors.ink };
      kit.drawTracked(g, kit.truncate(g, m.title, box.w, t1), box.x, top + ts * 1.0, t1);
      // The pipeline status first, in its colour; then whose it is and how long it has waited.
      const lw = kit.drawTracked(g, tr(look.label), box.x, top + ts + ms * 1.45, { size: ms, family: fonts.sans, color: done ? colors.inkDim : look.color });
      const meta = `${shortRef(m.reference, options.aliases)} · ${m.author} · ${age(m.createdAt, now, locale)}${done ? ` · ${tr({ en: 'approved', es: 'aprobada' })}` : ''}`;
      const mo = { size: ms, family: fonts.mono, color: colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, meta, box.w - lw - ms, mo), box.x + lw + ms * 0.8, top + ts + ms * 1.45, mo);
    });
  },
  demo: ({ now }) => ({ sources: { [SOURCE]: demoMergeRequests(now) } }),
});

export default definePlugin({
  id: 'gitlab',
  name: { en: 'GitLab', es: 'GitLab' },
  version: '0.1.0',
  description: { en: 'Your merge requests\' pipelines and the reviews waiting for you.', es: 'Los pipelines de tus merge requests y las revisiones que te esperan.' },
  author: 'Tessera',
  license: 'MIT',
  icon: 'gitlab',
  widgets: [pipelines, reviews],
  sources: [mergeRequests],
});
