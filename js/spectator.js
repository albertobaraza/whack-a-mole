// Read-only mirrored board for spectators: no timers, scoring, or hit
// detection, just applies visual state from the active player's broadcast
// game events (see js/queue.js's subscribeToGameEvents/broadcastGameEvent).
const SpectatorBoard = (() => {
  let holeEls = [];

  function buildBoard(boardEl) {
    boardEl.innerHTML = "";
    holeEls = [];
    for (let i = 0; i < Game.HOLE_COUNT; i++) {
      const holeEl = document.createElement("div");
      holeEl.className = "hole";
      const moleEl = document.createElement("span");
      moleEl.className = "mole";
      moleEl.textContent = "🐹";
      holeEl.appendChild(moleEl);
      boardEl.appendChild(holeEl);
      holeEls.push(holeEl);
    }
  }

  function showHole(index) {
    holeEls[index]?.classList.add("is-up");
  }

  function hideHole(index) {
    holeEls[index]?.classList.remove("is-up");
  }

  function flashHit(index) {
    const holeEl = holeEls[index];
    if (!holeEl) return;
    holeEl.classList.add("is-hit");
    setTimeout(() => holeEl.classList.remove("is-hit"), 220);

    const rect = holeEl.getBoundingClientRect();
    const burst = document.createElement("span");
    burst.className = "whack-burst";
    burst.textContent = "💥";
    burst.style.left = `${rect.width / 2}px`;
    burst.style.top = `${rect.height / 2}px`;
    holeEl.appendChild(burst);
    burst.addEventListener("animationend", () => burst.remove());
  }

  function reset() {
    holeEls.forEach((el) => el.classList.remove("is-up", "is-hit"));
  }

  return { buildBoard, showHole, hideHole, flashHit, reset };
})();
