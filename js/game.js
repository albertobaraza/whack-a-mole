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
    hole.hideTimeoutId = setTimeout(() => {
      if (!hole.resolved) Sounds.playMiss();
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

  function start(cb) {
    callbacks = cb;
    score = 0;
    running = true;
    startTime = Date.now();
    callbacks.onScoreChange?.(score);
    callbacks.onTimeChange?.(Math.ceil(ROUND_DURATION_MS / 1000));
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

  return { buildBoard, start };
})();
