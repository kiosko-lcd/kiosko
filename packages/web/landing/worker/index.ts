/**
 * Cloudflare Worker in front of GitHub Pages, on the route `kioskolcd.dev/`
 * only (wrangler.toml): a visit to the front page goes on to its language
 * (choose.ts) before anything is sent. Everything else, and visits that stay,
 * go to GitHub Pages untouched.
 *
 * Deploy: see README.md next to this file.
 */
import { choose } from './choose.ts';

/** Crawlers keep `/`: they index each language at its own address (hreflang), not where their IP is. */
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|lighthouse/i;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const front = url.pathname === '/' || url.pathname === '/index.html';
    // `?card` is the page as the share picture is taken (pages.mjs leaves it in English too).
    if (!front || !['GET', 'HEAD'].includes(request.method) || /(^|&)card\b/.test(url.search.slice(1)) || BOT.test(request.headers.get('user-agent') ?? '')) {
      return fetch(request);
    }
    const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;
    const go = choose({ acceptLanguage: request.headers.get('accept-language'), country, cookie: request.headers.get('cookie') });
    if (!go) return fetch(request);
    return new Response(null, {
      status: 302,
      headers: {
        location: `${url.origin}/${go}/${url.search}`,
        // The answer depends on who asks: no cache keeps it for someone else.
        'cache-control': 'private, no-store',
        vary: 'Accept-Language, Cookie',
      },
    });
  },
};
