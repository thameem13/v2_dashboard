# Deployment

`RELEASE.md` in the repo root is the operational source of truth and is worth
reading in full before a release. This is the summary plus the parts of it that
have since gone stale.

## Not GitHub Pages

The project **was** on GitHub Pages, and moved off in commit
`ed6d766 Run the Supabase proxy as a Worker instead of a Pages Function`.
Several comments still describe Pages; they are wrong. There is no `CNAME`
file and no Pages workflow in the repo.

Today: **Cloudflare Workers** with Git integration.

- `main` is production. Cloudflare reads `wrangler.jsonc` on every push to
  `main` and deploys the `v2-dashboard` Worker from it, within a minute or two.
- There is no staging environment and no manual deploy step. **Pushing `main`
  publishes.**
- `main: "worker.js"` is what makes this a real Worker rather than a
  static-assets-only project - which is what lets the `/api/rpc` proxy run at
  all.
- `assets.directory: "."` serves the **repo root** as the static site.
  Requests matching a real file are served directly; everything else falls
  through to `worker.js`.

### `.assetsignore` is not optional

Because the repo root is the asset directory, anything present at build time is
uploaded and published. That was harmless until `package.json` arrived:
Cloudflare's build then runs `npm install`, creating `node_modules/` **inside**
the directory being uploaded. The `supabase` dev-dependency carries a large
platform binary, the upload blows past the file-count and size limits, the
deploy fails - and the site silently keeps serving the previous version.

`.gitignore` cannot cover this; the build container creates `node_modules/`
itself, long after git is done. `.assetsignore` excludes `node_modules/`,
`package*.json`, `.wrangler/`, `supabase/`, `sql/` and the internal `.md`
notes.

**Adding a file to the repo root adds it to the public-behind-Access site.**

## The domain and the gate

- Custom domain **`dashflow.trade`**, a Cloudflare zone, routed to the Worker.
- **Cloudflare Access gates the whole hostname**, including `/api/*`. Sign-in
  is an OTP round-trip. This is why `curl` against the site returns the login
  page rather than HTML, and why the build stamp has to be checked in a
  browser.
- `/cdn-cgi/access/logout` is handled at Cloudflare's edge **before** both
  Access and the Worker (verified: it answers 200 where an unknown path answers
  a 302 to login), so `logout()` in `js/rpc.js` needs no route and never
  reaches `worker.js`.
- In front of Access, on the zone: a WAF custom rule "Allow CA and IN only",
  plus Bot Fight Mode.

### `workers_dev: false` and `preview_urls: false`

Both are off **deliberately and pinned in `wrangler.jsonc`**, not left to the
dashboard toggles, because Wrangler defaults `workers_dev` to **true** and
Cloudflare treats this file as the source of truth on every Git deploy. Left
unset, the next push would quietly republish the Worker at
`v2-dashboard.<subdomain>.workers.dev`.

That hostname is **not in the `dashflow.trade` zone**, so neither the WAF rule
nor Bot Fight Mode applies to it. Access still gates it, so it is not an open
door - but it is a hole through the two layers in front of Access, re-opened by
a routine deploy with nothing in the diff to show it. `preview_urls` covers the
`*-v2-dashboard.<subdomain>.workers.dev` wildcard, which is the same exposure
once per deployed version.

**Do not remove or flip either line.**

## Bindings

Set in the Cloudflare dashboard under **Settings -> Bindings** (not
Builds -> build variables):

| Name | Kind | Where it lives |
|---|---|---|
| `SUPABASE_URL` | plaintext var | `wrangler.jsonc` (not a secret; already in the repo) |
| `ASSETS` | assets binding | `wrangler.jsonc` |
| `ALERTS` | KV namespace | `wrangler.jsonc` (an id is an identifier, not a credential) |
| `SUPABASE_SECRET_KEY` | **Secret** | dashboard only, never the repo |
| `TELEGRAM_BOT_TOKEN` | **Secret** | dashboard only, never the repo |
| `TELEGRAM_CHAT_ID` | **Secret** | dashboard only, never the repo |

Plain **Variables do not survive deploys; Secrets do.** A binding added through
the UI that belongs in `wrangler.jsonc` will be dropped by the next push,
because a Git-deployed Worker treats the file as authoritative.

## Local preview

```
npx wrangler dev
```

This runs `worker.js` **and** serves the repo root as static assets, exactly as
production does, so `/api/rpc` works and the preview is faithful.

A plain static server is not a substitute - `/api/rpc` only exists inside the
Worker, so every table sits empty.

It needs the Supabase key, which is correctly not in the repo:

```
# .dev.vars in the project root
SUPABASE_SECRET_KEY=<from the Cloudflare dashboard: Settings -> Bindings>
```

> `.dev.vars` is covered by `.gitignore` (along with `.env*`), so creating it
> is safe. **Do not remove those lines** - this repo is public and
> `SUPABASE_SECRET_KEY` bypasses RLS. Confirm with
> `git check-ignore -v .dev.vars` if in doubt.

Opening `index.html` straight off disk partly works: `BUILD` falls back to
`'dev'` when there is no meta tag, and the staleness check bails when the
fetched HTML has no meta. But there is no `/api/rpc`, so there is no data.

## The version bump

One number, written in many places, and they are **one change, not several**:

- `<meta name="build">` in `index.html`
- `<meta name="build-ts">` in `index.html`
- every `?v=` query string in `index.html` - **8 CSS + 12 JS**

A single find-and-replace covers all of them. Currently `2.12.0`.

`js/config.js` reads `BUILD` **from the meta tag**, not from a literal. Do not
reintroduce a constant there. (`RELEASE.md` still lists `BUILD` and `BUILD_TS`
in `config.js` as things to bump - that is stale.) When it was a literal it
drifted, and the failure was not cosmetic: `chrome.js` compares that value
against the meta tag it re-fetches to decide whether a newer build is live, so
a stale constant made every load raise "a newer build is live, reload" against
a page that was already current - a prompt the reader could never clear.

The `?v=` strings exist so a cached stylesheet can never be served against a
newer page. That failure is not drift, it is a page whose CSS does not know
about its own markup.

## Releasing

1. Work on a branch. `main` is production; a branch costs nothing.
2. Verify with `npx wrangler dev`.
3. Bump the version, all of it together.
4. Merge to `main` and push - this is the publishing act.
5. Tag it, matching `BUILD`:
   `git tag -a v2.12.0 -m "<what changed>" && git push origin v2.12.0`.
   Tags are the restore points, and why this repo keeps no "backup" branch.

**Avoid pushing `main` between 09:30 and 16:00 ET on weekdays.** There is a
live session to disrupt and a bad deploy at 10am costs a trading day.

## Confirming what is live

Read the build stamp in the footer (`build 2.12.0`). It is also logged to the
console on load, so a DevTools screenshot is enough. If it does not match what
you pushed, you are on a cached copy - hard reload with **Ctrl+Shift+R**.

Access means `curl` gets you the login redirect, not the HTML. Use a browser.

## Rollback

**Do this first when production is broken.** It needs no git, no rebuild, no
cache wait.

Cloudflare dashboard -> **Workers & Pages** -> **v2-dashboard** ->
**Deployments** -> pick the last known-good version (the build stamp in each
version's code identifies it) -> three-dot menu -> **Rollback**. Effective
immediately, last 100 versions retained. Or `npx wrangler rollback`.

Then **fix it in git**:

```
git revert <bad-commit>
git push origin main
```

A Cloudflare rollback changes what is *deployed*, not what is in the repo -
`main` still holds the bad commit, so the next push silently re-deploys it.
Use `revert`, not `reset --hard`: `main` is pushed and the deploy follows it,
so rewriting its history is a second outage.

**Rollback reverts code only.** The `ALERTS` KV namespace keeps its cursors, so
alerts missed during the bad deploy are not replayed; Supabase keeps all tables,
RPCs and data. A rolled-back Worker can come back up against data the older
code never expected. If a release changed what gets written, rolling back the
code is only half the fix.
