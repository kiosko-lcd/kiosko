/**
 * The store pages' script (store.mjs writes the pages): filters and sorts the
 * cards already in the list page, keeps the choice in the address (a link
 * to "square panels, Spanish" works), and on a plugin's page switches its
 * pictures to another language. Nothing is sent anywhere.
 */
const texts = JSON.parse(document.getElementById('store-texts')?.textContent ?? '{}') as Record<string, string>;
const lang = texts.lang ?? document.documentElement.lang;

function shown(n: number): string {
  const form = new Intl.PluralRules(lang).select(n);
  return (texts[`store-shown-${form}`] ?? texts['store-shown-other'] ?? '{n}').replace('{n}', new Intl.NumberFormat(lang).format(n));
}

const form = document.querySelector<HTMLFormElement>('form.filters');
const box = document.querySelector<HTMLElement>('.cards');

if (form && box) {
  const cards = [...box.querySelectorAll<HTMLElement>('article.card')];
  const featured = new Map(cards.map((c, i) => [c, i]));
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T | null;
  const names = ['q', 'cat', 'panel', 'orient', 'os', 'lang', 'license', 'tier', 'tag', 'sort'];
  const empty = document.querySelector<HTMLElement>('.empty');
  const clear = form.querySelector<HTMLButtonElement>('button.clear');
  const count = form.querySelector<HTMLElement>('.count');

  // What the address asks for.
  const params = new URLSearchParams(location.search);
  for (const n of names) {
    const el = field(n);
    const v = params.get(n);
    if (el && v !== null && (!(el instanceof HTMLSelectElement) || [...el.options].some((o) => o.value === v))) el.value = v;
  }
  const region = field<HTMLInputElement>('region');
  if (region && params.get('region') === '0') region.checked = false;

  const has = (el: HTMLElement, key: string, v: string) => (el.dataset[key] ?? '').split(' ').includes(v);

  function apply(): void {
    const v = (n: string) => field(n)?.value ?? '';
    const q = v('q').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const panel = v('panel');
    const orient = v('orient');
    let visible = 0;
    for (const c of cards) {
      const classes = (c.dataset.classes ?? '').split(' ');
      const any = classes.includes('any');
      const ok =
        q.every((w) => (c.dataset.search ?? '').includes(w)) &&
        (!v('cat') || has(c, 'cats', v('cat'))) &&
        (!panel || any || (panel.startsWith('class:') ? classes.includes(panel.slice(6)) : has(c, 'presets', panel.slice(7)))) &&
        (!orient || any || (orient === 'h' ? classes.some((x) => x === 'bar' || x === 'landscape') : classes.includes('portrait'))) &&
        (!v('os') || has(c, 'os', v('os'))) &&
        (!v('lang') || has(c, 'langs', v('lang'))) &&
        (!v('license') || c.dataset.license === v('license')) &&
        (!v('tier') || c.dataset.tier === v('tier')) &&
        (!v('tag') || has(c, 'tags', v('tag'))) &&
        // Useful only elsewhere: out unless searched for by name (never hidden from search).
        (!region?.checked || q.length > 0 || c.dataset.market !== 'elsewhere');
      c.hidden = !ok;
      if (ok) visible++;
    }
    const sort = v('sort') || 'featured';
    const order = [...cards].sort((a, b) =>
      sort === 'name' ? (a.dataset.name ?? '').localeCompare(b.dataset.name ?? '', lang) : sort === 'recent' ? (b.dataset.date ?? '').localeCompare(a.dataset.date ?? '') : featured.get(a)! - featured.get(b)!,
    );
    for (const c of order) box!.append(c);
    if (count) count.textContent = shown(visible);
    if (empty) empty.hidden = visible > 0;
    const next = new URLSearchParams();
    for (const n of names) if (v(n) && !(n === 'sort' && v(n) === 'featured')) next.set(n, v(n));
    if (region && !region.checked) next.set('region', '0');
    if (clear) clear.hidden = ![...next.keys()].some((k) => k !== 'sort');
    const qs = next.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  }

  // On a phone the filters start folded: the search and the plugins come first.
  const more = form.querySelector<HTMLDetailsElement>('details.more');
  if (more && matchMedia('(max-width: 560px)').matches && ![...params.keys()].some((k) => k !== 'q' && k !== 'sort')) more.open = false;
  form.addEventListener('input', apply);
  form.addEventListener('change', apply);
  const reset = () => {
    for (const n of names) {
      const el = field(n);
      if (el) el.value = el instanceof HTMLSelectElement ? (el.options[0]?.value ?? '') : '';
    }
    if (region) region.checked = true;
    apply();
  };
  clear?.addEventListener('click', reset);
  empty?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) reset();
  });
  apply();
}

// A plugin's page: its pictures in another language.
const pick = document.querySelector<HTMLSelectElement>('select.shot-lang');
pick?.addEventListener('change', () => {
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-shots]')) {
    const shots = JSON.parse(img.dataset.shots ?? '{}') as Record<string, string>;
    img.src = shots[pick.value] ?? shots.en ?? img.src;
  }
});
