// Supabase's public "anon" key, not a secret — see README's "Security model"
// section. It's safe to commit: it only grants what the RLS policies in
// supabase/schema.sql allow (public read, insert-only, no update/delete).
// Analogous to a Stripe *publishable* key or a Firebase client config.
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
