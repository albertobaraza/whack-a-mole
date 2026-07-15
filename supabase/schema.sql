-- Run this once in the Supabase SQL Editor for your project.

create table public.scores (
  id bigint generated always as identity primary key,
  player_name text not null check (char_length(player_name) between 1 and 20),
  score integer not null check (score >= 0 and score <= 200),
  created_at timestamptz not null default now()
);

create index scores_score_desc_idx on public.scores (score desc);

alter table public.scores enable row level security;

-- Anyone (including the anonymous browser client) can read all scores,
-- since the leaderboard is public by design.
create policy "Public read access"
  on public.scores
  for select
  to anon
  using (true);

-- Anyone can insert a new score row. Data-shape validation (name length,
-- score range) is enforced by the CHECK constraints above, not here.
-- No update/delete policy is created for `anon`, so with RLS enabled those
-- operations are denied by default — scores are append-only from the client.
create policy "Public score submission"
  on public.scores
  for insert
  to anon
  with check (true);

-- ── Turn queue ────────────────────────────────────────────────────────────
-- Makes the board behave like a physical arcade machine: only one player
-- may be `playing` at a time, everyone else waits their turn. `client_id`
-- is a random UUID the browser generates and keeps in localStorage — same
-- trust model as `player_name` above (no auth; RLS is what constrains the
-- anon key, not a login). All state transitions away from `waiting` go
-- through SECURITY DEFINER RPCs below rather than raw REST UPDATEs, so a
-- naive client-side "claim the front row" race can't double-claim a turn,
-- and spoofing someone else's release requires knowing their exact UUID.

create table public.queue (
  id bigint generated always as identity primary key,
  client_id uuid not null,
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

create policy "Public read access to queue"
  on public.queue
  for select
  to anon
  using (true);

-- Anyone can join the back of the line directly via REST, but only ever as
-- 'waiting' — never as 'playing'. That closes off the exact spoof this
-- feature most needs to prevent.
create policy "Public can join the queue"
  on public.queue
  for insert
  to anon
  with check (status = 'waiting');

-- No update/delete policy for `anon`: every transition (claim, release,
-- stale-release, voluntary leave) must go through a SECURITY DEFINER RPC.

-- Atomically claim the next turn for a specific client. Safe to call
-- concurrently from every waiting client whenever the queue changes — only
-- the true front-of-line client's call can succeed, since it checks the
-- locked row's client_id against the caller's own.
create or replace function public.claim_next_turn(p_client_id uuid)
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

  if v_row.id is null or v_row.client_id <> p_client_id then
    return; -- queue empty, or caller isn't next in line
  end if;

  update public.queue
     set status = 'playing', turn_started_at = now()
   where id = v_row.id
  returning * into v_row;

  return next v_row;
end;
$$;
grant execute on function public.claim_next_turn(uuid) to anon;

-- Normal end-of-round release, called by the active player's own client.
create or replace function public.release_turn(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.queue
   where client_id = p_client_id and status = 'playing';
end;
$$;
grant execute on function public.release_turn(uuid) to anon;

-- Reclaims a stale turn; called by a spectator who observed (via Presence)
-- that the active player's client disappeared. Idempotent — a second
-- concurrent caller just deletes 0 rows. The turn_started_at guard is a
-- server-side floor matching the client-side grace timer, so a spurious or
-- late call can't nuke a turn that only just started.
create or replace function public.release_stale_turn(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.queue
   where client_id = p_client_id
     and status = 'playing'
     and turn_started_at < now() - interval '5 seconds';
end;
$$;
grant execute on function public.release_stale_turn(uuid) to anon;

-- Voluntary leave, before being claimed. Routed through an RPC rather than
-- an open delete policy so griefing another player's queue slot requires
-- knowing their exact client_id (a 128-bit UUID), not just a filterless
-- REST DELETE.
create or replace function public.leave_queue(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.queue
   where client_id = p_client_id and status = 'waiting';
end;
$$;
grant execute on function public.leave_queue(uuid) to anon;

-- Enables Realtime (Postgres Changes) on the queue table. Realtime also
-- needs to be turned on for this table in the Supabase dashboard if it
-- isn't already (Database → Replication) — a one-time manual project step.
alter publication supabase_realtime add table public.queue;
