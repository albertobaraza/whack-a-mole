// Grid state, spawn/difficulty ramp, scoring, and round timer.
const Game = (() => {
  const HOLE_COUNT = 9;
  const ROUND_DURATION_MS = new URLSearchParams(location.search).has("fastround") ? 8000 : 30000;
  const UP_MS_START = 1100;
  const UP_MS_END = 500;
  const SPAWN_MS_START = 900;
  const SPAWN_MS_END = 400;

  let holes = [];
  let score = 0;
  let startTime = 0;
  let spawnTimeoutId = null;
  let tickIntervalId = null;
  let running = false;
  let callbacks = {};

  const lerp = (a, b, t) => a + (b - a) * Math.min(Math.max(t, 0), 1);

  function buildBoard(boardEl) {
    boardEl.innerHTML = "";
    holes = [];
    for (let i = 0; i < HOLE_COUNT; i++) {
      const holeEl = document.createElement("div");
      holeEl.className = "hole";
      const moleEl = document.createElement("span");
      moleEl.className = "mole";
      moleEl.textContent = "🐹";
      holeEl.appendChild(moleEl);
      boardEl.appendChild(holeEl);

      const hole = { el: holeEl, isUp: false, resolved: false, hideTimeoutId: null };
      holes.push(hole);
      holeEl.addEventListener("pointerdown", (e) => handleHit(hole, e));
    }
  }

  function handleHit(hole, e) {
    if (!running || !hole.isUp || hole.resolved) return;
    hole.resolved = true;
    hideHole(hole);

    hole.el.classList.add("is-hit");
    setTimeout(() => hole.el.classList.remove("is-hit"), 220);
    spawnWhackBurst(hole, e);
    callbacks.onHoleHit?.(holes.indexOf(hole));

    score += 1;
    callbacks.onScoreChange?.(score);
    Sounds.playHit();
  }

  function spawnWhackBurst(hole, e) {
    const rect = hole.el.getBoundingClientRect();
    const burst = document.createElement("span");
    burst.className = "whack-burst";
    burst.textContent = "💥";
    burst.style.left = `${(e.clientX ?? rect.left + rect.width / 2) - rect.left}px`;
    burst.style.top = `${(e.clientY ?? rect.top + rect.height / 2) - rect.top}px`;
    hole.el.appendChild(burst);
    burst.addEventListener("animationend", () => burst.remove());
  }

  function showHole(hole, upMs) {
    hole.isUp = true;
    hole.resolved = false;
    hole.el.classList.add("is-up");
    Sounds.playPop();
    callbacks.onHoleShow?.(holes.indexOf(hole), upMs);
    hole.hideTimeoutId = setTimeout(() => {
      if (!hole.resolved) {
        Sounds.playMiss();
        callbacks.onHoleMiss?.(holes.indexOf(hole));
      }
      hideHole(hole);
    }, upMs);
  }

  function hideHole(hole) {
    hole.isUp = false;
    hole.el.classList.remove("is-up");
    if (hole.hideTimeoutId) {
      clearTimeout(hole.hideTimeoutId);
      hole.hideTimeoutId = null;
    }
    callbacks.onHoleHide?.(holes.indexOf(hole));
  }

  function pickHole(maxConcurrent) {
    const upCount = holes.filter((h) => h.isUp).length;
    if (upCount >= maxConcurrent) return null;
    const candidates = holes.filter((h) => !h.isUp);
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function scheduleSpawn() {
    if (!running) return;
    const t = (Date.now() - startTime) / ROUND_DURATION_MS;
    const upMs = lerp(UP_MS_START, UP_MS_END, t);
    const spawnMs = lerp(SPAWN_MS_START, SPAWN_MS_END, t);
    const maxConcurrent = t < 0.5 ? 1 : 2;

    const hole = pickHole(maxConcurrent);
    if (hole) showHole(hole, upMs);

    spawnTimeoutId = setTimeout(scheduleSpawn, spawnMs);
  }

  function tick() {
    const remainingMs = Math.max(ROUND_DURATION_MS - (Date.now() - startTime), 0);
    callbacks.onTimeChange?.(Math.ceil(remainingMs / 1000));
    if (remainingMs <= 0) end();
  }

  // `startAt` lets a caller resume a round already in progress (e.g. the
  // active player reloaded mid-round) using the turn's real start time
  // instead of restarting the full duration from this page load. Score
  // still resets to 0 either way — it's never persisted anywhere — but the
  // clock and spawn ramp correctly reflect actual elapsed time.
  function start(cb, startAt = Date.now()) {
    callbacks = cb;
    score = 0;
    running = true;
    startTime = startAt;
    callbacks.onScoreChange?.(score);
    const remainingMs = Math.max(ROUND_DURATION_MS - (Date.now() - startTime), 0);
    callbacks.onTimeChange?.(Math.ceil(remainingMs / 1000));
    scheduleSpawn();
    tickIntervalId = setInterval(tick, 100);
  }

  function end() {
    running = false;
    clearTimeout(spawnTimeoutId);
    clearInterval(tickIntervalId);
    holes.forEach(hideHole);
    Sounds.playGameOver();
    callbacks.onGameOver?.(score);
  }

  // Halts a round from the outside (e.g. the turn was taken away) without
  // the normal game-over fanfare/callback — just stops the timers and hides
  // any up holes so nothing keeps silently spawning/ticking/broadcasting
  // against a board no one owns. Callbacks are cleared first so hideHole's
  // callbacks.onHoleHide?.(...) can't fire on behalf of the ended game (a
  // hole still up at this point would otherwise leave its own hide timeout
  // pending, which — left uncleared — fires later using these same stale
  // callbacks, broadcasting a hide event for whichever player owns the
  // board by then).
  function stop() {
    running = false;
    clearTimeout(spawnTimeoutId);
    clearInterval(tickIntervalId);
    callbacks = {};
    holes.forEach(hideHole);
  }

  return { buildBoard, start, stop, HOLE_COUNT };
})();
