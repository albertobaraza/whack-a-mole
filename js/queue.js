// Turn queue: REST actions (join/leave/claim/release) plus Supabase Realtime
// subscriptions (queue changes, presence, game-event broadcast). This is the
// only module that talks to the supabase-js client directly — main.js and
// spectator.js only see the plain callback-based API returned below.
const Queue = (() => {
  const QUEUE_URL = `${SUPABASE_URL}/rest/v1/queue`;
  const RPC_URL = `${SUPABASE_URL}/rest/v1/rpc`;
  const BOARD_CHANNEL_NAME = "arcade-board";

  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };

  const FETCH_TIMEOUT_MS = 8000;

  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
  }

  function getClientId() {
    let id = localStorage.getItem("wam_client_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("wam_client_id", id);
    }
    return id;
  }

  async function joinQueue() {
    const res = await fetchWithTimeout(QUEUE_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ client_id: getClientId(), status: "waiting" }),
    });
    if (!res.ok) throw new Error(`Failed to join queue (${res.status})`);
  }

  async function callRpc(fn, clientId = getClientId()) {
    const res = await fetchWithTimeout(`${RPC_URL}/${fn}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ p_client_id: clientId }),
    });
    if (!res.ok) throw new Error(`Failed to call ${fn} (${res.status})`);
    // release_turn/release_stale_turn/leave_queue are `returns void` in SQL,
    // so PostgREST sends an empty body for them — only claim_next_turn
    // (`returns setof queue`) has JSON to parse, and nothing currently uses
    // its resolved value anyway (the queue's realtime subscription is the
    // source of truth for state changes).
  }

  const leaveQueue = () => callRpc("leave_queue");
  const claimNextTurn = () => callRpc("claim_next_turn");
  const releaseTurn = () => callRpc("release_turn");
  const releaseStaleTurn = (staleClientId) => callRpc("release_stale_turn", staleClientId);

  async function fetchQueueSnapshot() {
    const res = await fetchWithTimeout(`${QUEUE_URL}?select=*&order=id.asc`, { headers });
    if (!res.ok) throw new Error(`Failed to load queue (${res.status})`);
    return res.json();
  }

  // Postgres Changes only streams *future* row events, so every notification
  // (including the initial call) just re-fetches the full snapshot rather
  // than patching individual insert/update/delete payloads client-side.
  function subscribeToQueue(onChange) {
    const notify = () => fetchQueueSnapshot().then(onChange).catch((err) => console.error(err));
    notify();
    sb.channel("queue-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "queue" }, notify)
      .subscribe();
  }

  // One shared channel carries both Presence (is the active player still
  // connected?) and Broadcast (live mole events). Listeners must be attached
  // before the single .subscribe() call, so the channel is built lazily on
  // first use and handlers are stored in mutable closures that can be
  // (re)registered at any time afterward.
  let boardChannel = null;
  let gameEventHandlers = {};
  let presenceSyncHandler = null;

  // The full current presence set, not just join/leave deltas: a "leave"
  // event only reaches clients that were already connected at the moment
  // someone drops, so a tab that connects (or reconnects) *after* the
  // active player has already disappeared would never see one and would
  // otherwise never notice the machine is stuck. "sync" fires on every
  // presence change (including the initial one right after subscribing),
  // so cross-checking the full set against who the queue table says is
  // playing catches both cases uniformly.
  function getPresentClientIds() {
    const state = boardChannel?.presenceState() ?? {};
    const ids = new Set();
    Object.values(state).forEach((metas) => metas.forEach((meta) => ids.add(meta.client_id)));
    return ids;
  }

  function ensureBoardChannel() {
    if (boardChannel) return boardChannel;
    boardChannel = sb
      .channel(BOARD_CHANNEL_NAME, { config: { presence: { key: getClientId() } } })
      .on("broadcast", { event: "game" }, ({ payload }) => {
        gameEventHandlers[payload.type]?.(payload);
      })
      .on("presence", { event: "sync" }, () => {
        presenceSyncHandler?.(getPresentClientIds());
      })
      .subscribe();
    return boardChannel;
  }

  function subscribeToGameEvents(handlers) {
    gameEventHandlers = handlers;
    ensureBoardChannel();
  }

  function broadcastGameEvent(type, payload = {}) {
    ensureBoardChannel().send({ type: "broadcast", event: "game", payload: { type, ...payload } });
  }

  function subscribeToPresence(onSync) {
    presenceSyncHandler = onSync;
    ensureBoardChannel();
  }

  function trackPresence() {
    ensureBoardChannel().track({ client_id: getClientId() });
  }

  function untrackPresence() {
    boardChannel?.untrack();
  }

  const isPlaying = (rows, clientId) => rows.some((r) => r.client_id === clientId && r.status === "playing");

  function myQueuePosition(rows, clientId) {
    const idx = rows.filter((r) => r.status === "waiting").findIndex((r) => r.client_id === clientId);
    return idx === -1 ? null : idx;
  }

  const currentPlayer = (rows) => rows.find((r) => r.status === "playing") || null;

  return {
    getClientId,
    joinQueue,
    leaveQueue,
    claimNextTurn,
    releaseTurn,
    releaseStaleTurn,
    fetchQueueSnapshot,
    subscribeToQueue,
    subscribeToGameEvents,
    broadcastGameEvent,
    subscribeToPresence,
    trackPresence,
    untrackPresence,
    isPlaying,
    myQueuePosition,
    currentPlayer,
  };
})();
