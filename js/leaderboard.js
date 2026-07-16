// Reads/writes the global leaderboard via the shared Supabase client — see
// config.js for why the public anon key is safe to ship.
const Leaderboard = (() => {
  const { sb, timeoutSignal } = SupabaseClient;

  async function fetchTopScores(limit = 10) {
    const { data, error } = await sb
      .from("scores")
      .select("player_name,score")
      .order("score", { ascending: false })
      .limit(limit)
      .abortSignal(timeoutSignal());
    if (error) throw new Error(`Failed to load leaderboard: ${error.message}`);
    return data;
  }

  async function submitScore(playerName, score) {
    if (!SUPABASE_CONFIGURED) return;
    const { error } = await sb
      .from("scores")
      .insert({ player_name: playerName, score })
      .abortSignal(timeoutSignal());
    if (error) throw new Error(`Failed to submit score: ${error.message}`);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async function render(listEl) {
    if (!SUPABASE_CONFIGURED) {
      listEl.innerHTML = `<li class="leaderboard__empty">Leaderboard needs Supabase setup — see README.</li>`;
      return;
    }
    listEl.innerHTML = `<li class="leaderboard__empty">Loading…</li>`;
    try {
      const rows = await fetchTopScores();
      if (!rows.length) {
        listEl.innerHTML = `<li class="leaderboard__empty">No scores yet — be the first!</li>`;
        return;
      }
      listEl.innerHTML = rows
        .map(
          (row, i) =>
            `<li><span><span class="leaderboard__rank">${i + 1}.</span>${escapeHtml(row.player_name)}</span><span>${row.score}</span></li>`
        )
        .join("");
    } catch (err) {
      listEl.innerHTML = `<li class="leaderboard__empty">Couldn't load leaderboard.</li>`;
      console.error(err);
    }
  }

  return { submitScore, render };
})();
