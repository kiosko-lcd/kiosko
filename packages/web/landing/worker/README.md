# kiosko-lang: the front page's language at the edge

A Cloudflare Worker on `kioskolcd.dev/` (and `/index.html`) only. A visit to
the front page goes on to its language before any page is sent
([choose.ts](choose.ts)):

1. the language picked in the site's menu (cookie `kiosko_lang`, written by
   `landing/main.ts`);
2. the browser's languages (`Accept-Language`), by preference;
3. if none of those is one the site has: the visit's country (Spain and Latin
   America → `es`, Germany and Austria → `de`, Taiwan, Hong Kong and Macau →
   `zh-Hant`, mainland China → `zh-Hans`).

English stays at `/`. Crawlers, `?card` and every other address go to GitHub
Pages untouched. The redirect is a `302` with `Cache-Control: private,
no-store`. Without the Worker, the English page's own script
(`pages.mjs`, `redirect`) still does steps 1 and 2 in the browser.

Tests: `landing/worker.test.ts` (part of `npm test`).

## Deploy

Free plan: the Worker only runs for visits to `/`, far below the free plan's
100,000 requests a day.

Steps 1–3 were done on 2026-11-21: the proxy is on for the A, AAAA and `www`
records (mail is untouched) and the routes exist. SSL is *Full* rather than
*Full (strict)* on purpose: GitHub Pages may fail to renew its certificate
behind the proxy, and *Full* keeps the site up if it does. A change to the
Worker only needs step 4.

1. **Cloudflare → DNS**: turn on the proxy (orange cloud) on the records of
   `kioskolcd.dev` that point to GitHub Pages (`185.199.108–111.153`, and
   `www` if there is one).
2. **SSL/TLS → Overview**: *Full (strict)*. *Flexible* loops redirects with
   GitHub Pages, which forces HTTPS.
3. An API token: *My Profile → API Tokens → Create token → Edit Cloudflare
   Workers*, for the account and the `kioskolcd.dev` zone.
4. Deploy: **Actions → Language Worker → Run workflow**
   ([worker.yml](../../../../.github/workflows/worker.yml)). It tests, deploys
   and checks the live site. It reads the token from the repository secret
   `CLOUDFLARE_API_TOKEN`; the token is not an input, because inputs show in
   the run's details. Add the secret with a short-lived token, run the
   workflow, then delete the secret.

   Or from a computer, with wrangler in Docker (nothing installed). Run this
   from the repository's root:

   ```sh
   docker run --rm -it -e CLOUDFLARE_API_TOKEN -v "$PWD/packages:/src:ro" node:22 sh -c '
     mkdir -p /w/packages/sdk/src /w/packages/web/landing
     cp /src/sdk/src/languages.ts /w/packages/sdk/src/
     cp -r /src/web/landing/worker /w/packages/web/landing/
     cd /w/packages/web/landing/worker && npx -y wrangler@4 deploy'
   ```

5. Check:

   ```sh
   curl -sI -H 'Accept-Language: zh-TW' https://kioskolcd.dev/ | grep -i '^location'   # /zh-Hant/
   curl -sI -H 'Accept-Language: en-US' https://kioskolcd.dev/ | head -1             # 200
   ```

Undo: *Workers & Pages → kiosko-lang → Settings → Domains & Routes*, delete
the routes (or the Worker). The site works as before, with the browser's
redirect.
