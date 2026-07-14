// Reads/writes the global leaderboard directly against Supabase's REST API
// using the public anon key — see config.js for why that key is safe to ship.
const Leaderboard = (() => {
  const TABLE_URL = `${SUPABASE_URL}/rest/v1/scores`;

  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };

  // An unreachable/misconfigured Supabase URL (e.g. the placeholder in
  // config.js before setup) can otherwise hang fetch() indefinitely.
  const FETCH_TIMEOUT_MS = 8000;

  function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
  }

  async function fetchTopScores(limit = 10) {
    const res = await fetchWithTimeout(`${TABLE_URL}?select=player_name,score&order=score.desc&limit=${limit}`, {
      headers,
    });
    if (!res.ok) throw new Error(`Failed to load leaderboard (${res.status})`);
    return res.json();
  }

  async function submitScore(playerName, score) {
    const res = await fetchWithTimeout(TABLE_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ player_name: playerName, score }),
    });
    if (!res.ok) throw new Error(`Failed to submit score (${res.status})`);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async function render(listEl) {
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
