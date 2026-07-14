# Whack-a-Mole

A small browser whack-a-mole game with a global leaderboard. Plain HTML/CSS/JS, no build step, deployable directly to GitHub Pages.

## Run locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. (`fetch()` to Supabase needs `http://`, not `file://`.)

Append `?fastround=1` to the URL for a shortened 8s round, handy for quickly testing the game-over/leaderboard flow.

## Setting up the global leaderboard (Supabase)

The game itself needs no setup, but the leaderboard needs a free [Supabase](https://supabase.com) project:

1. Sign in at supabase.com and create a new project (any name/region; you'll be asked to set a DB password, which this app never uses directly since it only talks to the REST API).
2. Open **SQL Editor** in the project dashboard, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the `scores` table plus row-level security policies.
3. Go to **Project Settings → API**, copy the **Project URL** and the **anon public** key.
4. Paste both into [`js/config.js`](js/config.js):
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
   ```
5. Reload the page — the leaderboard should load, and finishing a round should let you submit a score.

No Supabase Auth setup is needed; the game only uses anonymous REST access governed by RLS.

## Security model

`js/config.js` commits the Supabase **anon** key in plain text, and that's intentional. Supabase's anon key is a *public* key, not a secret — it's meant to be shipped to browsers, similar to a Stripe publishable key or a Firebase client config. The actual access boundary is the [row-level security policies](supabase/schema.sql): the `anon` role can only `SELECT` (read the leaderboard) and `INSERT` (submit a score) — there's no `UPDATE`/`DELETE` policy, so those are denied by default.

Because this is a static site with no server, scoring is client-authoritative: a determined user could in principle POST a fake score directly to the REST endpoint. A `CHECK` constraint caps scores at 200 (well above what's achievable through normal play) to block obviously fabricated values, but this is a soft anti-abuse guard, not real anti-cheat. Genuine anti-cheat would require server-side validation, which is out of scope for this hobby project.

## Project structure

```
index.html
css/style.css       # layout, board, animations
js/config.js         # Supabase URL + anon key
js/sounds.js          # Web Audio API synthesized sound effects
js/game.js              # grid state, spawn/difficulty ramp, scoring, timer
js/leaderboard.js        # Supabase REST calls + leaderboard rendering
js/main.js                 # DOM wiring: start/game-over flow, name capture
supabase/schema.sql          # SQL to run once in Supabase's SQL editor
```
