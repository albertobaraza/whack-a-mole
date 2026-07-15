# Whack-a-Mole

A small browser whack-a-mole game with a turn queue, live spectating, and a global leaderboard. Plain HTML/CSS/JS, no build step, deployable directly to GitHub Pages.

## Run locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. (`fetch()` to Supabase needs `http://`, not `file://`.)

Append `?fastround=1` to the URL for a shortened 8s round, handy for quickly testing the game-over/leaderboard flow.

Without a Supabase project configured (see below), the page still runs — the **Join Queue** button becomes a plain **Start** button and plays solo, and the leaderboard shows a "needs setup" message instead of trying to load. This is controlled by the `SUPABASE_CONFIGURED` check in [`js/config.js`](js/config.js), which only requires that `SUPABASE_URL`/`SUPABASE_ANON_KEY` no longer be the placeholder values below.

## Setting up Supabase (leaderboard + turn queue)

The game itself needs no setup, but the leaderboard and the turn queue both need a free [Supabase](https://supabase.com) project:

1. Sign in at supabase.com and create a new project (any name/region; you'll be asked to set a DB password, which this app never uses directly since it only talks to the REST API).
2. Open **SQL Editor** in the project dashboard, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the `scores` and `queue` tables, their row-level security policies, and the turn-claiming RPCs.
3. Go to **Database → Publications** and confirm the `supabase_realtime` publication lists the `queue` table (the schema's `alter publication supabase_realtime add table public.queue;` line does this automatically when you run the script, so this is just a confirmation — the queue list and live spectating won't update without it). Note: the sidebar also has a separate **Replication** entry under "Platform" for Read Replicas/Pipelines — that's a different feature and not what you want here.
4. Go to **Project Settings → API**, copy the **Project URL** and the anon/public key — newer projects call it the **Publishable key** (`sb_publishable_...`), older ones the **anon key** (a JWT); either works the same way.
5. Paste both into [`js/config.js`](js/config.js):
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
   ```
6. Reload the page — the leaderboard should load, and clicking **Join Queue** should start your turn immediately (since the queue starts empty).

No Supabase Auth setup is needed; the game only uses anonymous REST + Realtime access governed by RLS. Only one player can be `playing` at a time — everyone else queues up and watches the active player's board mirrored live via Supabase Realtime broadcast.

## Security model

`js/config.js` commits the Supabase **anon** key in plain text, and that's intentional. Supabase's anon key is a *public* key, not a secret — it's meant to be shipped to browsers, similar to a Stripe publishable key or a Firebase client config. The actual access boundary is the [row-level security policies](supabase/schema.sql): the `anon` role can only `SELECT` (read the leaderboard) and `INSERT` (submit a score) — there's no `UPDATE`/`DELETE` policy, so those are denied by default.

Because this is a static site with no server, scoring is client-authoritative: a determined user could in principle POST a fake score directly to the REST endpoint. A `CHECK` constraint caps scores at 200 (well above what's achievable through normal play) to block obviously fabricated values, but this is a soft anti-abuse guard, not real anti-cheat. Genuine anti-cheat would require server-side validation, which is out of scope for this hobby project.

The turn queue extends the same no-auth trust model: each browser generates a random `client_id` (a UUID kept in `localStorage`) instead of logging in, so a determined user could in principle spoof another client's ID. What RLS actually prevents is *unauthorized state changes*, not identity spoofing: `anon` can `SELECT` the queue and `INSERT` a new `waiting` row, but every transition away from `waiting` (claiming a turn, releasing it, reclaiming a stale one) is only reachable through `SECURITY DEFINER` RPC functions in [`supabase/schema.sql`](supabase/schema.sql), never a raw `UPDATE`/`DELETE`. A partial unique index also guarantees at the database level that only one row can ever be `playing`, independent of any application bug.

## Project structure

```
index.html
css/style.css       # layout, board, animations
js/config.js         # Supabase URL + anon key
js/sounds.js          # Web Audio API synthesized sound effects
js/game.js              # grid state, spawn/difficulty ramp, scoring, timer
js/leaderboard.js        # Supabase REST calls + leaderboard rendering
js/queue.js               # turn queue REST calls + Realtime (Postgres Changes, Presence, Broadcast)
js/spectator.js             # read-only mirrored board driven by broadcast game events
js/main.js                    # DOM wiring: queue/spectate/play orchestration, game-over flow
supabase/schema.sql             # SQL to run once in Supabase's SQL editor
```

The turn queue's live spectating relies on Supabase Realtime, loaded via a pinned-version CDN `<script>` tag in `index.html` (`@supabase/supabase-js`) — the only external dependency in the project; everything else is plain fetch/DOM APIs.
