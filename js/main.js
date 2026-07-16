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
const reportBugBtn = document.getElementById("reportBugBtn");
const bugReportDialog = document.getElementById("bugReportDialog");
const bugReportForm = document.getElementById("bugReportForm");
const bugReportInput = document.getElementById("bugReportInput");
const bugReportStatus = document.getElementById("bugReportStatus");
const bugReportCancelBtn = document.getElementById("bugReportCancelBtn");
const bugReportSubmitBtn = document.getElementById("bugReportSubmitBtn");

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

reportBugBtn.addEventListener("click", () => {
  bugReportInput.value = "";
  bugReportStatus.hidden = true;
  bugReportDialog.showModal();
});

bugReportCancelBtn.addEventListener("click", () => {
  bugReportDialog.close();
});

bugReportForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  bugReportSubmitBtn.disabled = true;
  try {
    await BugReport.submit(bugReportInput.value.trim());
    bugReportDialog.close();
  } catch (err) {
    console.error(err);
    bugReportStatus.hidden = false;
    bugReportStatus.textContent = err.message.includes("Daily bug report limit")
      ? "You've reached today's bug report limit, try again tomorrow."
      : "Couldn't send, please try again.";
  } finally {
    bugReportSubmitBtn.disabled = false;
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
  // The queue needs a real (anonymous) auth session before any of its RPCs
  // will authorize anything — see js/queue.js/supabase/schema.sql.
  Queue.ready.then(() => {
    const clientId = Queue.getClientId();

    // Tracks which renderer currently owns #board's DOM so renderQueueState
    // doesn't rebuild it (and reset the HUD) on every unrelated queue change —
    // only when playing starts/stops or the spectated player changes.
    let boardOwner = null; // "game" | "spectator"
    let watchedPlayerId = undefined;

    // Pending grace-period timers for a currently-active client_id (playing
    // or front-of-queue waiting) found absent from Presence, cancelled if
    // it's found present again in time.
    const staleReleaseTimers = {};
    let latestRows = [];
    // null means "no presence sync received yet" — distinct from an empty
    // Set (genuinely nobody tracked). A brand-new tab's queue snapshot
    // (plain REST) typically resolves well before its Realtime channel
    // finishes its first presence sync, so treating "no data yet" as
    // "nobody's here" would falsely flag a genuinely active player as
    // absent within seconds of any second client loading the page.
    let latestPresentIds = null;

    // Live game state kept by the playing client so a spectator who joins
    // Presence mid-round (see subscribeToPresenceJoin below) can be caught
    // up immediately instead of waiting for the next incidental broadcast.
    let currentScore = 0;
    let currentSeconds = null;
    const currentUpHoles = new Set();

    const scheduleStaleRelease = (staleClientId) => {
      if (staleReleaseTimers[staleClientId]) return;
      staleReleaseTimers[staleClientId] = setTimeout(() => {
        delete staleReleaseTimers[staleClientId];
        Queue.releaseStaleMember(staleClientId).catch((err) => console.error(err));
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
    const checkPresence = (someClientId) => {
      if (!someClientId || someClientId === clientId) return;
      if (latestPresentIds.has(someClientId)) {
        cancelStaleRelease(someClientId);
      } else {
        scheduleStaleRelease(someClientId);
      }
    };

    // Covers both halves of "a queue member disappeared": the active player
    // (checked before, via Presence) and — since an abandoned front-of-queue
    // 'waiting' row would otherwise permanently block every client behind it,
    // as claim_next_turn only ever looks at that single row — the client
    // currently at the front of the line too.
    const checkStaleQueueMembers = () => {
      if (latestPresentIds === null) return;
      checkPresence(Queue.currentPlayer(latestRows)?.client_id ?? null);
      const [frontOfLine] = latestRows.filter((r) => r.status === "waiting");
      checkPresence(frontOfLine?.client_id ?? null);
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

    const enterPlayingMode = (player) => {
      boardOwner = "game";
      watchedPlayerId = undefined;
      boardEl.classList.remove("board--readonly");
      joinQueueBtn.hidden = true;
      queueStatusTextEl.hidden = true;
      modeLabelEl.textContent = "You're playing!";
      Sounds.unlock();
      currentScore = 0;
      currentSeconds = null;
      currentUpHoles.clear();
      // A resumed turn (e.g. this client reloading mid-round) rebuilds a
      // completely fresh local board with nothing up — but any hole that was
      // already "up" on spectators' boards from before the reload has no
      // matching hole_hide coming (the timer that would have sent it was
      // destroyed by the reload), so it'd otherwise stay stuck until that
      // same hole happens to spawn again. Broadcasting a reset here clears
      // spectators' boards in sync with this genuinely-empty new one.
      Queue.broadcastGameEvent("reset");
      Game.buildBoard(boardEl);
      // Uses the queue row's own turn_started_at (rather than Date.now()) so
      // a page reload mid-round resumes the real remaining time instead of
      // restarting a fresh 30s round — the queue row already existed before
      // this reload, so its turn_started_at reflects when the turn actually
      // began, not when this particular page load happened.
      Game.start({
        onScoreChange: (score) => {
          currentScore = score;
          scoreValueEl.textContent = score;
          Queue.broadcastGameEvent("score", { score });
        },
        onTimeChange: (seconds) => {
          currentSeconds = seconds;
          timeValueEl.textContent = seconds;
          Queue.broadcastGameEvent("time", { seconds });
        },
        onHoleShow: (index) => {
          currentUpHoles.add(index);
          Queue.broadcastGameEvent("hole_show", { index });
        },
        onHoleHide: (index) => {
          currentUpHoles.delete(index);
          Queue.broadcastGameEvent("hole_hide", { index });
        },
        onHoleHit: (index) => Queue.broadcastGameEvent("hole_hit", { index }),
        onGameOver: (finalScore) => {
          currentSeconds = null;
          currentUpHoles.clear();
          lastScore = finalScore;
          finalScoreValueEl.textContent = finalScore;
          gameOverDialog.showModal();
          Queue.releaseTurn().catch((err) => console.error(err));
        },
      }, new Date(player.turn_started_at).getTime());
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

      checkStaleQueueMembers();

      if (iAmPlaying) {
        if (boardOwner !== "game") enterPlayingMode(player);
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
      reset: () => SpectatorBoard.reset(),
    });

    Queue.subscribeToPresence((presentIds) => {
      latestPresentIds = presentIds;
      checkStaleQueueMembers();
    });

    // Catches up a spectator who starts watching mid-round: broadcasts only
    // carry deltas as they happen, so without this a newly-joined client
    // would see score "0" and an empty board until the next incidental
    // score/hole change, which could be many seconds away (or never, in a
    // lull near round end).
    Queue.subscribeToPresenceJoin((joinedIds) => {
      if (boardOwner !== "game") return;
      if (!joinedIds.some((id) => id !== clientId)) return;
      Queue.broadcastGameEvent("score", { score: currentScore });
      if (currentSeconds !== null) Queue.broadcastGameEvent("time", { seconds: currentSeconds });
      currentUpHoles.forEach((index) => Queue.broadcastGameEvent("hole_show", { index }));
    });

    // Tracked once for the lifetime of the tab (not just while playing) so
    // Presence reflects every connected client — including one merely
    // waiting at the front of the queue — which checkStaleQueueMembers
    // above depends on to detect an abandoned queue slot.
    Queue.trackPresence();

    // Score can never be recovered on reload (it's never persisted), so a
    // resumed turn would only ever coast to a confusing 0-point finish.
    // Ending it outright instead — while a merely-waiting client's queue row
    // is left untouched and keeps its position — lets the next real waiting
    // player start immediately instead of watching out however long is left
    // on a turn its owner may not even still be looking at.
    window.addEventListener("pagehide", () => {
      if (boardOwner === "game") Queue.releaseTurnOnUnload();
    });

    joinQueueBtn.addEventListener("click", async () => {
      Sounds.unlock();
      joinQueueBtn.disabled = true;
      try {
        await Queue.joinQueue();
        // Left disabled: the next queue snapshot will hide it once the join
        // is reflected, and re-enabling before then would let a fast second
        // click submit a duplicate join for the same client.
      } catch (err) {
        console.error(err);
        joinQueueBtn.disabled = false;
      }
    });
  }).catch((err) => {
    console.error(err);
    joinQueueBtn.hidden = true;
    queueStatusTextEl.hidden = false;
    queueStatusTextEl.textContent = "Couldn't connect to the game server — reload to try again.";
  });
}
