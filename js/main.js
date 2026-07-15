// DOM wiring: queue/spectate/play orchestration (or, without a Supabase
// project configured, a direct solo-play fallback), game-over flow, name
// capture, mute toggle.
const boardEl = document.getElementById("board");
const scoreValueEl = document.getElementById("scoreValue");
const timeValueEl = document.getElementById("timeValue");
const modeLabelEl = document.getElementById("modeLabel");
const muteToggle = document.getElementById("muteToggle");
const leaderboardListEl = document.getElementById("leaderboardList");
const gameOverDialog = document.getElementById("gameOverDialog");
const gameOverForm = document.getElementById("gameOverForm");
const finalScoreValueEl = document.getElementById("finalScoreValue");
const playerNameInput = document.getElementById("playerNameInput");
const skipBtn = document.getElementById("skipBtn");
const joinQueueBtn = document.getElementById("joinQueueBtn");
const queueStatusTextEl = document.getElementById("queueStatusText");
const queueListEl = document.getElementById("queueListEl");

let lastScore = 0;

Leaderboard.render(leaderboardListEl);
playerNameInput.value = localStorage.getItem("wam_player_name") || "";

// Unlocks on the very first tap/click anywhere on the page, not just on a
// specific button: a queued player's round can start automatically (via a
// realtime callback, with no fresh click at that exact moment) once it's
// their turn, so relying only on e.g. the join-queue click would leave
// audio suspended for anyone who reloads mid-queue.
document.addEventListener("pointerdown", () => Sounds.unlock(), { once: true });

const updateMuteButton = () => {
  const muted = Sounds.isMuted();
  muteToggle.textContent = muted ? "🔇" : "🔊";
  muteToggle.setAttribute("aria-pressed", String(muted));
};
updateMuteButton();

muteToggle.addEventListener("click", () => {
  Sounds.setMuted(!Sounds.isMuted());
  updateMuteButton();
});

skipBtn.addEventListener("click", () => {
  gameOverDialog.close();
});

gameOverForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = playerNameInput.value.trim().slice(0, 20) || "Anonymous";
  localStorage.setItem("wam_player_name", name);
  gameOverDialog.close();
  try {
    await Leaderboard.submitScore(name, lastScore);
    Leaderboard.render(leaderboardListEl);
  } catch (err) {
    console.error(err);
  }
});

if (!SUPABASE_CONFIGURED) {
  // No Supabase project set up: skip the queue/spectating machinery
  // entirely (it would just time out against the placeholder URL) and
  // fall back to the original direct single-player flow.
  joinQueueBtn.textContent = "Start";
  joinQueueBtn.addEventListener("click", () => {
    Sounds.unlock();
    joinQueueBtn.disabled = true;
    Game.buildBoard(boardEl);
    Game.start({
      onScoreChange: (score) => {
        scoreValueEl.textContent = score;
      },
      onTimeChange: (seconds) => {
        timeValueEl.textContent = seconds;
      },
      onGameOver: (finalScore) => {
        joinQueueBtn.disabled = false;
        lastScore = finalScore;
        finalScoreValueEl.textContent = finalScore;
        gameOverDialog.showModal();
      },
    });
  });
} else {
  const clientId = Queue.getClientId();

  // Tracks which renderer currently owns #board's DOM so renderQueueState
  // doesn't rebuild it (and reset the HUD) on every unrelated queue change —
  // only when playing starts/stops or the spectated player changes.
  let boardOwner = null; // "game" | "spectator"
  let watchedPlayerId = undefined;

  // Pending grace-period timers for a currently-playing client_id found
  // absent from Presence, cancelled if it's found present again in time.
  const staleReleaseTimers = {};
  let latestRows = [];
  // null means "no presence sync received yet" — distinct from an empty
  // Set (genuinely nobody tracked). A brand-new tab's queue snapshot
  // (plain REST) typically resolves well before its Realtime channel
  // finishes its first presence sync, so treating "no data yet" as
  // "nobody's here" would falsely flag a genuinely active player as
  // absent within seconds of any second client loading the page.
  let latestPresentIds = null;

  const scheduleStaleRelease = (staleClientId) => {
    if (staleReleaseTimers[staleClientId]) return;
    staleReleaseTimers[staleClientId] = setTimeout(() => {
      delete staleReleaseTimers[staleClientId];
      Queue.releaseStaleTurn(staleClientId).catch((err) => console.error(err));
    }, 6000);
  };

  const cancelStaleRelease = (someClientId) => {
    if (staleReleaseTimers[someClientId]) {
      clearTimeout(staleReleaseTimers[someClientId]);
      delete staleReleaseTimers[someClientId];
    }
  };

  // Never check our own presence: from our own tab's perspective we're
  // trivially "present," and a fresh trackPresence() call hasn't
  // necessarily round-tripped back into our local presence snapshot yet,
  // which would otherwise be a false-positive race right as a turn starts.
  const checkCurrentPlayerPresence = () => {
    if (latestPresentIds === null) return;
    const player = Queue.currentPlayer(latestRows);
    if (!player || player.client_id === clientId) return;
    if (latestPresentIds.has(player.client_id)) {
      cancelStaleRelease(player.client_id);
    } else {
      scheduleStaleRelease(player.client_id);
    }
  };

  const renderQueueList = (rows) => {
    if (!rows.length) {
      queueListEl.innerHTML = `<li class="queue-panel__empty">Queue is empty — be the first!</li>`;
      return;
    }
    let waitingCount = 0;
    queueListEl.innerHTML = rows
      .map((row) => {
        const you = row.client_id === clientId ? " (you)" : "";
        const label = row.status === "playing" ? "Playing now" : `#${++waitingCount} in line`;
        return `<li>${label}${you}</li>`;
      })
      .join("");
  };

  const enterPlayingMode = () => {
    boardOwner = "game";
    watchedPlayerId = undefined;
    boardEl.classList.remove("board--readonly");
    joinQueueBtn.hidden = true;
    queueStatusTextEl.hidden = true;
    modeLabelEl.textContent = "You're playing!";
    Sounds.unlock();
    Queue.trackPresence();
    Game.buildBoard(boardEl);
    Game.start({
      onScoreChange: (score) => {
        scoreValueEl.textContent = score;
        Queue.broadcastGameEvent("score", { score });
      },
      onTimeChange: (seconds) => {
        timeValueEl.textContent = seconds;
        Queue.broadcastGameEvent("time", { seconds });
      },
      onHoleShow: (index) => Queue.broadcastGameEvent("hole_show", { index }),
      onHoleHide: (index) => Queue.broadcastGameEvent("hole_hide", { index }),
      onHoleHit: (index) => Queue.broadcastGameEvent("hole_hit", { index }),
      onGameOver: (finalScore) => {
        lastScore = finalScore;
        finalScoreValueEl.textContent = finalScore;
        gameOverDialog.showModal();
        Queue.untrackPresence();
        Queue.releaseTurn().catch((err) => console.error(err));
      },
    });
  };

  const enterSpectatingMode = (player, myPosition) => {
    joinQueueBtn.hidden = myPosition !== null;
    if (myPosition !== null) {
      queueStatusTextEl.hidden = false;
      queueStatusTextEl.textContent = `You are #${myPosition + 1} in line`;
    } else {
      queueStatusTextEl.hidden = true;
    }
    modeLabelEl.textContent = player ? "Spectating" : "";

    const nowWatching = player?.id ?? null;
    if (boardOwner !== "spectator" || watchedPlayerId !== nowWatching) {
      if (boardOwner === "game") Game.stop();
      boardOwner = "spectator";
      watchedPlayerId = nowWatching;
      boardEl.classList.add("board--readonly");
      SpectatorBoard.buildBoard(boardEl);
      scoreValueEl.textContent = "0";
      timeValueEl.textContent = player ? "—" : "0";
    }
  };

  const renderQueueState = (rows) => {
    latestRows = rows;
    renderQueueList(rows);
    const player = Queue.currentPlayer(rows);
    const myPosition = Queue.myQueuePosition(rows, clientId);
    const iAmPlaying = player?.client_id === clientId;

    // Front of the line and the machine is free — try to claim it. Safe to
    // call every time the queue changes: the RPC is atomic server-side, so
    // only the true front-of-line client's call actually succeeds.
    if (!player && myPosition === 0) {
      Queue.claimNextTurn().catch((err) => console.error(err));
    }

    checkCurrentPlayerPresence();

    if (iAmPlaying) {
      if (boardOwner !== "game") enterPlayingMode();
    } else {
      enterSpectatingMode(player, myPosition);
    }
  };

  Queue.subscribeToQueue(renderQueueState);

  Queue.subscribeToGameEvents({
    score: ({ score }) => {
      scoreValueEl.textContent = score;
    },
    time: ({ seconds }) => {
      timeValueEl.textContent = seconds;
    },
    hole_show: ({ index }) => SpectatorBoard.showHole(index),
    hole_hide: ({ index }) => SpectatorBoard.hideHole(index),
    hole_hit: ({ index }) => SpectatorBoard.flashHit(index),
  });

  Queue.subscribeToPresence((presentIds) => {
    latestPresentIds = presentIds;
    checkCurrentPlayerPresence();
  });

  joinQueueBtn.addEventListener("click", async () => {
    Sounds.unlock();
    joinQueueBtn.disabled = true;
    try {
      await Queue.joinQueue();
    } catch (err) {
      console.error(err);
    } finally {
      joinQueueBtn.disabled = false;
    }
  });
}
