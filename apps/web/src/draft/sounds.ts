/** Draft room sounds, synthesized with Web Audio (no audio files). Every function never throws. */

interface Note {
  freq: number;
  /** Start offset in seconds. */
  at: number;
  dur: number;
  type: OscillatorType;
  gain: number;
}

let shared: AudioContext | null = null;

function context(): AudioContext | null {
  if (shared && shared.state !== "closed") return shared;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctx = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctx) return null;
  shared = new Ctx();
  return shared;
}

function schedule(ctx: AudioContext, notes: Note[]) {
  const t0 = ctx.currentTime;
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = n.type;
    osc.frequency.value = n.freq;
    const start = t0 + n.at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(n.gain, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + n.dur + 0.02);
  }
}

/**
 * Plays `notes` when audio is allowed. A suspended context (autoplay policy) is resumed; if the
 * browser refuses and `deferToGesture` is set, the sound plays once on the first pointerdown/keydown.
 */
function play(notes: Note[], deferToGesture = false) {
  try {
    const ctx = context();
    if (!ctx) return;
    if (ctx.state === "running") {
      schedule(ctx, notes);
      return;
    }
    const later = () => {
      if (!deferToGesture) return;
      const go = () => {
        window.removeEventListener("pointerdown", go);
        window.removeEventListener("keydown", go);
        try {
          void Promise.resolve(ctx.resume())
            .then(() => schedule(ctx, notes))
            .catch(() => undefined);
        } catch {
          /* still blocked */
        }
      };
      window.addEventListener("pointerdown", go);
      window.addEventListener("keydown", go);
    };
    Promise.resolve(ctx.resume())
      .then(() => (ctx.state === "running" ? schedule(ctx, notes) : later()))
      .catch(later);
  } catch {
    /* audio blocked or unsupported */
  }
}

/** Two soft notes (E5, A5) when the viewer enters the room. */
export function playChime() {
  play(
    [
      { freq: 659.25, at: 0, dur: 0.35, type: "sine", gain: 0.12 },
      { freq: 880, at: 0.18, dur: 0.55, type: "sine", gain: 0.12 },
    ],
    true,
  );
}

/** Three rising notes (C5, E5, G5 + octave) when the draft starts. */
export function playFanfare() {
  play([
    { freq: 523.25, at: 0, dur: 0.22, type: "triangle", gain: 0.2 },
    { freq: 659.25, at: 0.2, dur: 0.22, type: "triangle", gain: 0.2 },
    { freq: 783.99, at: 0.4, dur: 0.22, type: "triangle", gain: 0.2 },
    { freq: 1046.5, at: 0.6, dur: 0.7, type: "triangle", gain: 0.24 },
  ]);
}

/** Four harsh square-wave pulses (about 1.5 s) when the pick clock runs out. */
export function playAlarm() {
  play(
    [0, 0.38, 0.76, 1.14].map((at) => ({
      freq: 740,
      at,
      dur: 0.28,
      type: "square" as const,
      gain: 0.1,
    })),
  );
}
