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
