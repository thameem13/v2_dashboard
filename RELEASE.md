# Releasing and rolling back

How this dashboard reaches production, and how to get it back when a release
goes wrong. Emergency first, because that is the order you need it in.

**`main` is production.** Cloudflare reads `wrangler.jsonc` on every push to
`main` and deploys `v2-dashboard` from it. There is no staging environment and
no manual deploy step: pushing `main` publishes, within a minute or two. That is
the whole deploy model, and it is why the rest of this document exists.

---

## If production is broken: roll back

**Do this first. It does not need git, a rebuild, or a cache wait.**

1. Cloudflare dashboard → **Workers & Pages** → **v2-dashboard** →
   **Deployments**.
2. Find the last known-good version — the build stamp in each version's code
   tells you which is which.
3. Three-dot menu → **Rollback**.

It takes effect immediately across all routes. The last **100** versions are
available, so this is never the constraint.

Same thing from the terminal:

```
npx wrangler rollback
```

Then, once the dashboard is working again, **fix it in git**:

```
git revert <bad-commit>
git push origin main
```

This matters. A Cloudflare rollback changes what is *deployed*, not what is in
the repo — `main` still holds the bad commit, so the next push to `main`
silently re-deploys it. Use `git revert` rather than `reset --hard`: `main` is
pushed and the deploy follows it, so rewriting its history is a second outage.

### What a rollback does *not* undo

Rollback reverts **code only**. Everything the Worker talks to keeps its
current state:

- **The `ALERTS` KV namespace**, which holds `lastAlertedCandle`. The cron will
  not re-send an alert it has already recorded, so rolling back does not replay
  alerts you missed during the bad deploy.
- **Supabase** — all tables, RPCs and data.

So a rolled-back Worker can come back up against data that the older code never
expected to see. If a release changed what gets written, rolling back the code
is only half the fix.

---

## Releasing

1. **Work on a branch.** `main` is production; a branch costs nothing.
2. **Verify it.** `npx wrangler dev` (see below) gives a local copy with a real
   `/api/rpc`. A plain static server does not — `/api/rpc` only exists inside
   the Worker, so the tables will sit empty.
3. **Bump the version — all of it, together:**
   - `BUILD` in `js/config.js`
   - `BUILD_TS` in `js/config.js`
   - `<meta name="build">` in `index.html`
   - every `?v=` query string in `index.html` (8 CSS + 12 JS)

   These are one change, not four. The `?v=` strings exist so a cached
   stylesheet can never be served against a newer page — and that failure is
   not cosmetic drift, it is a page whose CSS does not know about its own
   markup.
4. **Merge to `main`** only once it is verified, then push. This is the
   publishing act.
5. **Tag it**, matching `BUILD`:
   ```
   git tag -a v1.10.0 -m "<what changed>"
   git push origin v1.10.0
   ```
   Tags are the restore points. They are why this repo does not keep a "backup"
   branch: git already holds every previous state immutably, and a tag gives
   the useful ones a name that never goes stale.

### Timing

**Avoid pushing `main` between 09:30 and 16:00 ET on weekdays.** The cron in
`wrangler.jsonc` runs `*/1 13-21 * * 1-5` UTC for the same reason — there is a
live session to disrupt, and a bad deploy at 10am costs a trading day. This is
already how the project behaves; `FEASIBILITY_REVIEW.md` defers its migration to
a weekend because the market was open. It just had not been written down.

---

## Confirming what is actually live

**Read the build stamp in the footer.** It is the only reliable check:

```
build 1.10.0
```

If it does not match what you just pushed, you are on a cached copy — hard
reload with **Ctrl+Shift+R**.

> **Note:** the cache comment at the top of `index.html` is **stale**. It
> describes GitHub Pages and a `max-age=600` header, but
> `ed6d766 Run the Supabase proxy as a Worker instead of a Pages Function`
> moved this off Pages. The caching behaviour is Cloudflare's now. The footer
> stamp is still correct; the explanation around it is not. This document is
> the source of truth until that comment is fixed.

The page is behind Cloudflare Access, so checking the build with `curl` gets you
the login redirect rather than the HTML. Use a browser.

---

## Running it locally

```
npx wrangler dev
```

This runs `worker.js` *and* serves the repo root as static assets, exactly as
production does, so `/api/rpc` works and the preview is faithful.

It needs the Supabase key, which is correctly not in the repo. Create
`.dev.vars` in the project root:

```
SUPABASE_SECRET_KEY=<from the Cloudflare dashboard: Settings -> Variables>
```

> **⚠️ This repo has no `.gitignore`.** `.dev.vars` will show up as an untracked
> file, and a `git add -A` would commit your Supabase service key. Add a
> `.gitignore` containing `.dev.vars` **before** you create that file.

`SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are Secrets
in the Cloudflare dashboard, never in the repo — see the note at the bottom of
`wrangler.jsonc`. Plain Variables do not survive deploys; Secrets do.

---

## One thing to know about the assets directory

`wrangler.jsonc` sets `assets.directory` to `"."`, so **every file in this repo
is served by the Worker** — including this one, at `/RELEASE.md`. Everything
sits behind Cloudflare Access, so it is not public, but do not add a file here
that you would not want served.
