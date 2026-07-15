// Supabase's public "anon" key, not a secret — see README's "Security model"
// section. It's safe to commit: it only grants what the RLS policies in
// supabase/schema.sql allow (public read, insert-only, no update/delete).
// Analogous to a Stripe *publishable* key or a Firebase client config.
const SUPABASE_URL = "https://agmvhgntrrvdtsxwembu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TQAKysC6wmzmpiT7fOpQwQ_RmxEe2f0";

// True once both values above are replaced with real project values. Gates
// the leaderboard and turn-queue features so the game still runs solo,
// without hitting the network at all, until both are actually set.
const SUPABASE_CONFIGURED =
  SUPABASE_URL !== "https://YOUR-PROJECT.supabase.co" && SUPABASE_ANON_KEY !== "YOUR-ANON-KEY";
