// Turn queue: REST actions (join/leave/claim/release) plus Supabase Realtime
// subscriptions (queue changes, presence, game-event broadcast). This is the
// only module that talks to the supabase-js client directly — main.js and
// spectator.js only see the plain callback-based API returned below.
const Queue = (() => {
  const { sb, timeoutSignal } = SupabaseClient;
  const BOARD_CHANNEL_NAME = "arcade-board";

  // Every queue action is bound to the caller's own Supabase Auth session
  // (anonymous sign-in — no email/password) rather than a client-supplied
  // id, so `getClientId()` only resolves once that session exists. Callers
  // must await `ready` before using anything else this module exports.
  let clientId = null;

  async function ensureSession() {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (session) return session.user.id;

    const { data, error } = await sb.auth.signInAnonymously();
    if (error) {
      throw new Error(
        `Failed to start an anonymous session (${error.message}) — is Anonymous Sign-In enabled in the Supabase dashboard?`
      );
    }
    return data.user.id;
  }

  const ready = ensureSession().then((id) => {
    clientId = id;
  });

  const getClientId = () => clientId;

  // Kept in sync (including through token refreshes) so releaseTurnOnUnload
  // can authenticate its request without an async call — there's no time
  // for one once the page has started unloading.
  let cachedAccessToken = null;
  sb.auth.onAuthStateChange((_event, session) => {
    cachedAccessToken = session?.access_token ?? null;
  });

  // Fire-and-forget release for a page unload (reload, close, navigate away)
  // while this client is the active player. A normal callRpc/fetch can be
  // cut off mid-flight once unloading starts, so this bypasses the
  // Supabase client for a raw `fetch(..., { keepalive: true })` — the one
  // request shape browsers commit to actually delivering after the page
  // that sent it is already gone. `navigator.sendBeacon` is the more common
  // tool for this, but it can't carry a custom Authorization header, which
  // this RPC (auth.uid()-scoped, see schema.sql) requires.
  function releaseTurnOnUnload() {
    if (!cachedAccessToken) return;
    fetch(`${SUPABASE_URL}/rest/v1/rpc/release_turn`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${cachedAccessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      keepalive: true,
    });
  }

  async function joinQueue() {
    const { error } = await sb.from("queue").insert({ status: "waiting" }).abortSignal(timeoutSignal());
    if (error) throw new Error(`Failed to join queue: ${error.message}`);
  }

  async function callRpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args).abortSignal(timeoutSignal());
    if (error) throw new Error(`Failed to call ${fn}: ${error.message}`);
    return data;
  }

  const leaveQueue = () => callRpc("leave_queue");
  const claimNextTurn = () => callRpc("claim_next_turn");
  const releaseTurn = () => callRpc("release_turn");
  const releaseStaleMember = (staleClientId) => callRpc("release_stale_member", { p_target_client_id: staleClientId });

  async function fetchQueueSnapshot() {
    const { data, error } = await sb.from("queue").select("*").order("id", { ascending: true }).abortSignal(timeoutSignal());
    if (error) throw new Error(`Failed to load queue: ${error.message}`);
    return data;
  }

  // Postgres Changes only streams *future* row events, so every notification
  // (including the initial call) just re-fetches the full snapshot rather
  // than patching individual insert/update/delete payloads client-side.
  // Each notification issues its own independent fetch with no cancellation
  // of a prior in-flight one, so responses can arrive out of order; the
  // request-id guard below only ever applies the most recently *issued*
  // request's result, discarding any older response that resolves late.
  function subscribeToQueue(onChange) {
    let latestRequestId = 0;
    const notify = () => {
      const requestId = ++latestRequestId;
      fetchQueueSnapshot()
        .then((rows) => {
          if (requestId === latestRequestId) onChange(rows);
        })
        .catch((err) => console.error(err));
    };
    notify();
    sb.channel("queue-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "queue" }, notify)
      .subscribe();
  }

  // One shared channel carries both Presence (is a given client still
  // connected?) and Broadcast (live mole events). Listeners must be attached
  // before the single .subscribe() call, so the channel is built lazily on
  // first use and handlers are stored in mutable closures that can be
  // (re)registered at any time afterward.
  let boardChannel = null;
  let gameEventHandlers = {};
  let presenceSyncHandler = null;
  let presenceJoinHandler = null;

  // The full current presence set, not just join/leave deltas: a "leave"
  // event only reaches clients that were already connected at the moment
  // someone drops, so a tab that connects (or reconnects) *after* the
  // active player has already disappeared would never see one and would
  // otherwise never notice the machine is stuck. "sync" fires on every
  // presence change (including the initial one right after subscribing),
  // so cross-checking the full set against who the queue table says is
  // playing/waiting catches both cases uniformly.
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
      .on("presence", { event: "join" }, ({ newPresences }) => {
        presenceJoinHandler?.(newPresences.map((meta) => meta.client_id));
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

  // Fires with the list of client_ids that just joined Presence — used to
  // catch up a newly-arrived spectator with the current game state instead
  // of leaving them stuck at defaults until the next incidental broadcast.
  function subscribeToPresenceJoin(onJoin) {
    presenceJoinHandler = onJoin;
    ensureBoardChannel();
  }

  function trackPresence() {
    ensureBoardChannel().track({ client_id: getClientId() });
  }

  function untrackPresence() {
    boardChannel?.untrack();
  }

  function myQueuePosition(rows, clientId) {
    const idx = rows.filter((r) => r.status === "waiting").findIndex((r) => r.client_id === clientId);
    return idx === -1 ? null : idx;
  }

  const currentPlayer = (rows) => rows.find((r) => r.status === "playing") || null;

  return {
    ready,
    getClientId,
    joinQueue,
    leaveQueue,
    claimNextTurn,
    releaseTurn,
    releaseTurnOnUnload,
    releaseStaleMember,
    fetchQueueSnapshot,
    subscribeToQueue,
    subscribeToGameEvents,
    broadcastGameEvent,
    subscribeToPresence,
    subscribeToPresenceJoin,
    trackPresence,
    untrackPresence,
    myQueuePosition,
    currentPlayer,
  };
})();
