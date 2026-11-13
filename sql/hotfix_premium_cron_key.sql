/* HOTFIX — the option-premium cron has been failing 401 since the legacy keys
 * were disabled. NOT YET APPLIED: needs one value only you can supply.
 *
 * Diagnosed 2026-11-12.
 *
 * ── Symptom ────────────────────────────────────────────────────────────────
 * spy_option_premium stopped gaining rows on 2026-11-02. The Performance tab's
 * premium backtest has been running on a feed that stopped ten days ago, with
 * nothing on the page to say so.
 *
 * ── Why it looked healthy ──────────────────────────────────────────────────
 * cron.job_run_details says "succeeded / 1 row" for every tick, which is true
 * and useless: the job body is a net.http_post(), and pg_net is ASYNCHRONOUS.
 * The job succeeds the moment the request is QUEUED. Whether the HTTP call
 * then worked is recorded somewhere else entirely - net._http_response - and
 * nothing was reading it.
 *
 * What that table actually holds:
 *
 *     status_code 401, "Legacy API keys are disabled",
 *     "...disabled on 2026-10-31T21:44:41Z..."
 *
 * for every retained response, both jobs, no exceptions. (net._http_response
 * is pruned aggressively, so the retained window is only the last few hours -
 * but it is 100% 401 across it, and 2026-10-31 is when the key died, which
 * lines up with the premium table going quiet.)
 *
 * ── Root cause ─────────────────────────────────────────────────────────────
 * Both jobs hardcode a LEGACY service_role JWT in the Authorization header.
 * Legacy anon and service_role keys were disabled on this project on
 * 2026-10-31, so both edge functions - which are verify_jwt = true, correctly -
 * reject every invocation.
 *
 * The same disablement is why the deleted `dashboard` edge function rendered
 * empty, and it is the one thing that kept that public endpoint from leaking
 * real data. Disabling the legacy keys was right. This is its unnoticed
 * second-order casualty.
 *
 * ── Two things wrong, both fixed below ─────────────────────────────────────
 *   1. The key is dead and has to be replaced with the current sb_secret_...
 *      key - the same value as the Worker's SUPABASE_SECRET_KEY binding.
 *   2. The key should never have been inline. cron.job.command is plain text
 *      in a system catalogue, so the old token sat readable in any database
 *      dump, forever, to anyone who could read cron.job. Vault fixes that:
 *      the cron reads the secret by NAME at fire time and the catalogue holds
 *      no credential.
 *
 * ── HOW TO APPLY ───────────────────────────────────────────────────────────
 * STEP 1 — get the key. Supabase dashboard -> Project Settings -> API Keys ->
 *   the secret key (sb_secret_...). It is the same value already stored as
 *   SUPABASE_SECRET_KEY in the Cloudflare Worker bindings. Do NOT paste it
 *   into this file, into any file, or into a commit: this repo is public.
 *
 * STEP 2 — run step 2 below ON ITS OWN in the Supabase SQL editor, with the
 *   key pasted in place of the placeholder. Then clear the editor.
 *
 * STEP 3 — run steps 3 and 4. Step 4 is the verification and must be last,
 *   because the editor shows only the final result set.
 *
 * Applying step 3 before step 2 is harmless: the guard means the jobs simply
 * stay quiet instead of firing with a bad key, which is what they are already
 * doing.
 */


/* --------------------------------------------------------------------------
   STEP 2. Store the key in Vault. RUN THIS ALONE, THEN CLEAR THE EDITOR.
   --------------------------------------------------------------------------
   Re-runnable: updates the secret in place if it already exists, so a key
   rotation is this statement again and nothing else. */
do $$
declare
  v_key text := 'PASTE_THE_sb_secret_KEY_HERE';
  v_id  uuid;
begin
  if v_key not like 'sb_secret_%' then
    raise exception 'That is not a secret key. Expected sb_secret_..., got %',
      left(v_key, 12) || '...';
  end if;

  select id into v_id from vault.secrets where name = 'edge_function_key';

  if v_id is null then
    perform vault.create_secret(
      v_key,
      'edge_function_key',
      'Secret API key pg_cron uses to invoke the option-premium edge functions. Same value as the Cloudflare Worker SUPABASE_SECRET_KEY binding. Replaced a legacy service_role JWT that was disabled 2026-10-31 and had been 401-ing since.');
    raise notice 'edge_function_key created';
  else
    perform vault.update_secret(v_id, v_key);
    raise notice 'edge_function_key updated';
  end if;
end $$;


/* --------------------------------------------------------------------------
   STEP 3. Repoint both cron jobs at Vault.
   --------------------------------------------------------------------------
   cron.schedule() on an existing jobname replaces it in place, so this is
   idempotent and keeps the jobids.

   The schedules are unchanged and deliberately staggered - SPY on even
   minutes, QQQ on odd - so the two never contend for the same tick.

   The WHERE clause is the guard: no request is sent at all unless a
   plausible key is present. Without it, a missing or placeholder secret would
   put 360 doomed requests a day into net._http_response, which is exactly the
   noise that let this failure hide for ten days. */

select cron.schedule(
  'spy-option-premium-5min',
  '*/2 13-21 * * 1-5',
  $job$
  select net.http_post(
    url := 'https://egsgycizhssexstjrsqi.supabase.co/functions/v1/spy-option-premium',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret
                                       from vault.decrypted_secrets
                                      where name = 'edge_function_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from vault.decrypted_secrets
                 where name = 'edge_function_key'
                   and decrypted_secret like 'sb_secret_%');
  $job$
);

select cron.schedule(
  'qqq-option-premium-5min',
  '1-59/2 13-21 * * 1-5',
  $job$
  select net.http_post(
    url := 'https://egsgycizhssexstjrsqi.supabase.co/functions/v1/qqq-option-premium',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret
                                       from vault.decrypted_secrets
                                      where name = 'edge_function_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from vault.decrypted_secrets
                 where name = 'edge_function_key'
                   and decrypted_secret like 'sb_secret_%');
  $job$
);


/* --------------------------------------------------------------------------
   STEP 4. VERIFY. Keep this last - the editor shows only the final result.
   --------------------------------------------------------------------------
   Run it a few minutes into a weekday session, 13:00-21:00 UTC, or the jobs
   will not have fired yet and every count will correctly be zero.

   WHAT YOU WANT TO SEE
     key_present          true
     command_has_secret   false      <- no credential left in the catalogue
     responses_2xx        > 0
     responses_401        0
     premium_newest       today

   If responses_401 is still climbing, the key in Vault is wrong or has itself
   been rotated. If both response counts are 0, the guard is holding - the
   secret is missing or still the placeholder, so go back to step 2. */
select
  (select exists (select 1 from vault.decrypted_secrets
                   where name = 'edge_function_key'
                     and decrypted_secret like 'sb_secret_%'))      as key_present,
  (select bool_or(command ~ '(eyJ|sb_secret_)')
     from cron.job where jobname like '%option-premium%')           as command_has_secret,
  (select count(*) from net._http_response
    where status_code between 200 and 299)                          as responses_2xx,
  (select count(*) from net._http_response
    where status_code = 401)                                        as responses_401,
  (select max(created_at)::text from public.spy_option_premium)        as spy_premium_newest,
  (select max(created_at)::text from public.qqq_option_premium)        as qqq_premium_newest;
