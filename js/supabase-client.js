// Single Supabase client shared by js/queue.js and js/leaderboard.js, so both
// modules see the same auth session (needed once the queue signs in
// anonymously — see js/queue.js) instead of each hand-rolling its own fetch
// headers and timeout logic.
const SupabaseClient = (() => {
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const FETCH_TIMEOUT_MS = 8000;

  // An unreachable/misconfigured Supabase URL (e.g. the placeholder in
  // config.js before setup) can otherwise hang a request indefinitely.
  const timeoutSignal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

  return { sb, timeoutSignal };
})();
