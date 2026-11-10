import type { DraftSnapshot } from "@dnp/contract";
import { useEffect, useRef, useState } from "react";

export const ALERT_TITLE = "⏰ Your pick! – Draft & Pray";
const SOUND_KEY = "dnp.draft.sound";

export function readSoundPref(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "0"; // on unless explicitly muted
  } catch {
    return true;
  }
}

function writeSoundPref(on: boolean) {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the preference just is not remembered */
  }
}

/** A short beep generated with Web Audio (no audio files). Never throws. */
export function beep() {
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => void ctx.close?.();
  } catch {
    /* audio blocked or unsupported */
  }
}

const isMyTurn = (s: DraftSnapshot) =>
  s.status === "in_progress" && !!s.myTeamId && s.onClockTeamId === s.myTeamId;

/**
 * Alerts the viewer when their team comes on the clock: title flash (until the page is focused or
 * visible again), an optional beep and a vibration where supported. Not fired on first load, and
 * not when the turn arrives right after the viewer's own pick (e.g. the snake turnaround).
 */
export function useTurnAlert(snapshot: DraftSnapshot) {
  const [sound, setSoundState] = useState(readSoundPref);
  const soundRef = useRef(sound);
  const prevMine = useRef<boolean | null>(null);
  const flashRef = useRef<{ stop: () => void } | null>(null);

  const setSound = (on: boolean) => {
    setSoundState(on);
    soundRef.current = on;
    writeSoundPref(on);
    if (on) beep(); // also lets the browser unlock audio on a user gesture
  };

  const mine = isMyTurn(snapshot);
  const last = snapshot.picks.reduce<DraftSnapshot["picks"][number] | null>(
    (a, p) => (!a || p.overallPick > a.overallPick ? p : a),
    null,
  );
  const ownPickJustMade =
    !!last && last.teamId === snapshot.myTeamId && last.overallPick === snapshot.currentPick - 1;

  useEffect(() => {
    const before = prevMine.current;
    prevMine.current = mine;
    if (before === null || before || !mine || ownPickJustMade) return;

    const unfocused = document.hidden || !document.hasFocus();
    if (unfocused) {
      flashRef.current?.stop();
      const original = document.title;
      let on = true;
      document.title = ALERT_TITLE;
      const id = setInterval(() => {
        on = !on;
        document.title = on ? ALERT_TITLE : original;
      }, 1000);
      const stop = () => {
        clearInterval(id);
        document.title = original;
        window.removeEventListener("focus", onBack);
        document.removeEventListener("visibilitychange", onBack);
        flashRef.current = null;
      };
      const onBack = () => {
        if (!document.hidden && document.hasFocus()) stop();
      };
      window.addEventListener("focus", onBack);
      document.addEventListener("visibilitychange", onBack);
      flashRef.current = { stop };
    }
    if (soundRef.current) beep();
    try {
      navigator.vibrate?.([200, 100, 200]);
    } catch {
      /* vibration unsupported */
    }
  }, [mine, ownPickJustMade]);

  // Turn over (or room left): stop flashing.
  useEffect(() => {
    if (!mine) flashRef.current?.stop();
  }, [mine]);
  useEffect(() => () => flashRef.current?.stop(), []);

  return { sound, setSound };
}
