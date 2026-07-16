-- Run this once in the Supabase SQL Editor for your project.
--
-- Requires Anonymous Sign-Ins to be enabled: Supabase Dashboard →
-- Authentication → Sign In / Providers → Anonymous Sign-Ins → Enable.
-- The queue's identity model (see below) depends on every browser holding a
-- real (anonymous) auth session, not just the shared anon API key.

create table public.scores (
  id bigint generated always as identity primary key,
  player_name text not null check (char_length(player_name) between 1 and 20),
  score integer not null check (score >= 0 and score <= 200),
  created_at timestamptz not null default now()
);

create index scores_score_desc_idx on public.scores (score desc);

alter table public.scores enable row level security;

-- `to public` (rather than `to anon`) so this also matches clients holding an
-- anonymous-auth session (role `authenticated`, not `anon` — see the queue
-- section below for why that distinction matters), in addition to plain
-- anon-key-only requests. The leaderboard has no identity concept either way.
create policy "Public read access"
  on public.scores
  for select
  to public
  using (true);

-- Anyone can insert a new score row. Data-shape validation (name length,
-- score range) is enforced by the CHECK constraints above, not here.
-- No update/delete policy is created, so with RLS enabled those operations
-- are denied by default — scores are append-only from the client.
create policy "Public score submission"
  on public.scores
  for insert
  to public
  with check (true);

-- ── Turn queue ────────────────────────────────────────────────────────────
-- Makes the board behave like a physical arcade machine: only one player
-- may be `playing` at a time, everyone else waits their turn.
--
-- `client_id` identifies a browser tab across reloads, but it is *not* a
-- client-supplied value: it defaults to `auth.uid()`, the id of the current
-- Supabase Auth session (anonymous sign-in — no email/password, just a real
-- session token instead of a self-declared UUID). Every RPC below acts only
-- on `auth.uid()`'s own row (claim/release/leave) or requires the caller to
-- already be a genuine queue participant (stale-member reclaim), so knowing
-- another client's id is no longer enough to act on their behalf — that id
-- is public read-only information, not a capability.
create table public.queue (
  id bigint generated always as identity primary key,
  client_id uuid not null default auth.uid(),
  status text not null default 'waiting' check (status in ('waiting', 'playing')),
  joined_at timestamptz not null default now(),
  turn_started_at timestamptz
);

-- FIFO order is by `id` (monotonic identity), not `joined_at`, to avoid any
-- timestamp-precision tie-break subtlety.

-- DB-level guarantee that at most one row is ever `playing`: every playing
-- row shares the same indexed value, so a second concurrent UPDATE/INSERT
-- to 'playing' violates this index regardless of application-level bugs.
create unique index queue_one_playing_idx
  on public.queue (status) where (status = 'playing');

-- At most one active (waiting/playing) row per client — guards against a
-- double-submitted Join click or a stray reconnect leaving a ghost row.
create unique index queue_client_active_idx
  on public.queue (client_id) where (status in ('waiting', 'playing'));

alter table public.queue enable row level security;

-- Realtime UPDATE/DELETE payloads only include changed columns by default;
-- this ensures they carry the full row (e.g. client_id) so subscribers can
-- tell who left without a separate lookup.
alter table public.queue replica identity full;

-- `to public`: reading the queue (including other clients' ids) needs no
-- identity — the ids themselves aren't secret, only acting on them is.
create policy "Public read access to queue"
  on public.queue
  for select
  to public
  using (true);

-- Anyone with a session can join the back of the line directly via REST,
-- but only ever as 'waiting' — never as 'playing' — and only under their
-- own client_id (the `default auth.uid()` above already ensures this if the
-- client omits the column, but the check re-verifies it defensively against
-- a client that tries to send someone else's id explicitly). `to
-- authenticated` (not `anon`) because an anonymous-auth session is required
-- to have an `auth.uid()` at all.
create policy "Public can join the queue"
  on public.queue
  for insert
  to authenticated
  with check (status = 'waiting' and client_id = auth.uid());

-- No update/delete policy: every transition (claim, release, stale reclaim,
-- voluntary leave) must go through a SECURITY DEFINER RPC.

-- Atomically claim the next turn for the calling session. Safe to call
-- concurrently from every waiting client whenever the queue changes — only
-- the true front-of-line client's call can succeed, since it checks the
-- locked row's client_id against the caller's own auth.uid().
create or replace function public.claim_next_turn()
returns setof public.queue
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.queue;
begin
  if exists (select 1 from public.queue where status = 'playing') then
    return;
  end if;

  select * into v_row
    from public.queue
   where status = 'waiting'
   order by id
   for update skip locked
   limit 1;

  if v_row.id is null or v_row.client_id <> auth.uid() then
    return; -- queue empty, or caller isn't next in line
  end if;

  update public.queue
     set status = 'playing', turn_started_at = now()
   where id = v_row.id
  returning * into v_row;

  return next v_row;
end;
$$;
grant execute on function public.claim_next_turn() to authenticated;

-- Normal end-of-round release. Takes no argument — it can only ever end the
-- caller's own turn, identified by auth.uid(), not a client-supplied id.
create or replace function public.release_turn()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.queue
   where client_id = auth.uid() and status = 'playing';
end;
$$;
grant execute on function public.release_turn() to authenticated;

-- Reclaims a stale queue member — either a 'playing' row whose active
-- player's client has disappeared (observed via Presence, with a grace
-- period), or a 'waiting' row whose owner disconnected before ever being
-- served (which would otherwise deadlock every client behind it forever,
-- since claim_next_turn only ever considers the single front-of-line row).
-- Idempotent — a second concurrent caller just deletes 0 rows.
--
-- p_target_client_id names someone else's row, so this can't be scoped to
-- auth.uid() like release_turn/leave_queue. Instead it requires the caller
-- to themselves currently hold an active (waiting or playing) row — i.e.
-- only a genuine queue participant, not an arbitrary caller who never
-- joined, can trigger a reclaim. Combined with the fixed grace period below
-- (matching the client-side timer), this bounds — without eliminating — how
-- early an impatient participant could reclaim someone else's slot.
create or replace function public.release_stale_member(p_target_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.queue
     where client_id = auth.uid() and status in ('waiting', 'playing')
  ) then
    return;
  end if;

  delete from public.queue
   where client_id = p_target_client_id
     and (
       (status = 'playing' and turn_started_at < now() - interval '5 seconds')
       or (status = 'waiting' and joined_at < now() - interval '5 seconds')
     );
end;
$$;
grant execute on function public.release_stale_member(uuid) to authenticated;

-- Voluntary leave, before being claimed. Takes no argument — it can only
-- ever remove the caller's own waiting row, identified by auth.uid().
create or replace function public.leave_queue()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.queue
   where client_id = auth.uid() and status = 'waiting';
end;
$$;
grant execute on function public.leave_queue() to authenticated;

-- Enables Realtime (Postgres Changes) on the queue table. Realtime also
-- needs to be turned on for this table in the Supabase dashboard if it
-- isn't already (Database → Replication) — a one-time manual project step.
alter publication supabase_realtime add table public.queue;
