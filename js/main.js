// DOM wiring: start/game-over flow, name capture, mute toggle.
const boardEl = document.getElementById("board");
const scoreValueEl = document.getElementById("scoreValue");
const timeValueEl = document.getElementById("timeValue");
const startBtn = document.getElementById("startBtn");
const muteToggle = document.getElementById("muteToggle");
const leaderboardListEl = document.getElementById("leaderboardList");
const gameOverDialog = document.getElementById("gameOverDialog");
const gameOverForm = document.getElementById("gameOverForm");
const finalScoreValueEl = document.getElementById("finalScoreValue");
const playerNameInput = document.getElementById("playerNameInput");
const skipBtn = document.getElementById("skipBtn");

let lastScore = 0;

Game.buildBoard(boardEl);
Leaderboard.render(leaderboardListEl);
playerNameInput.value = localStorage.getItem("wam_player_name") || "";

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

startBtn.addEventListener("click", () => {
  Sounds.unlock();
  startBtn.disabled = true;
  Game.start({
    onScoreChange: (score) => {
      scoreValueEl.textContent = score;
    },
    onTimeChange: (seconds) => {
      timeValueEl.textContent = seconds;
    },
    onGameOver: (finalScore) => {
      startBtn.disabled = false;
      lastScore = finalScore;
      finalScoreValueEl.textContent = finalScore;
      gameOverDialog.showModal();
    },
  });
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
