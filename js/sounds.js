// Synthesized sound effects via the Web Audio API — no external audio files,
// so no licensing/attribution or asset-loading concerns.
const Sounds = (() => {
  let audioCtx = null;
  let muted = localStorage.getItem("wam_muted") === "true";

  const ensureContext = () => {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  };

  const playTone = ({ freq, endFreq, duration, type = "sine", gain = 0.2 }) => {
    if (muted) return;
    const ctx = ensureContext();
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), now + duration);
    }

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(gain, now + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gainNode).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  };

  return {
    unlock: ensureContext,
    isMuted: () => muted,
    setMuted(value) {
      muted = value;
      localStorage.setItem("wam_muted", String(muted));
    },
    playPop() {
      playTone({ freq: 300, endFreq: 500, duration: 0.12, type: "sine", gain: 0.15 });
    },
    playHit() {
      playTone({ freq: 220, endFreq: 80, duration: 0.15, type: "square", gain: 0.2 });
    },
    playMiss() {
      playTone({ freq: 180, endFreq: 90, duration: 0.2, type: "sawtooth", gain: 0.1 });
    },
    playGameOver() {
      const notes = [523, 440, 349, 262];
      notes.forEach((freq, i) => {
        setTimeout(() => playTone({ freq, duration: 0.25, type: "triangle", gain: 0.18 }), i * 150);
      });
    },
  };
})();
