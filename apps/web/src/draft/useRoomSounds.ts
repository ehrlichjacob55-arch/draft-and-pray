import type { DraftSnapshot } from "@dnp/contract";
import { useEffect, useRef } from "react";
import { playAlarm, playChime, playFanfare } from "./sounds";

export interface RoomSoundPlayers {
  chime: () => void;
  fanfare: () => void;
  alarm: () => void;
}
const REAL: RoomSoundPlayers = { chime: playChime, fanfare: playFanfare, alarm: playAlarm };

/** True when the draft moves from not-yet-started to running (a paused draft with no picks counts as not started). */
export function isDraftStart(prev: DraftSnapshot, next: DraftSnapshot): boolean {
  if (next.status !== "in_progress") return false;
  return (
    prev.status === "scheduled" ||
    prev.status === "lobby" ||
    (prev.status === "paused" && prev.picks.length === 0)
  );
}

/**
 * Room sounds, all gated by the sound toggle (state is tracked even while muted, so unmuting never
 * replays anything):
 * - chime once when the viewer enters the room;
 * - fanfare when the draft transitions to in_progress while the viewer is here (not on load);
 * - alarm once per clock when it reaches zero while the viewer is here (not if it was already
 *   expired on arrival).
 */
export function useRoomSounds(
  snapshot: DraftSnapshot,
  clockExpired: boolean,
  soundOn: boolean,
  players: RoomSoundPlayers = REAL,
) {
  const on = useRef(soundOn);
  const p = useRef(players);
  useEffect(() => {
    on.current = soundOn;
    p.current = players;
  });

  const entered = useRef(false);
  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    if (on.current) p.current.chime();
  }, []);

  const prev = useRef<DraftSnapshot | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = snapshot;
    if (before && isDraftStart(before, snapshot) && on.current) p.current.fanfare();
  }, [snapshot]);

  const clock = snapshot.clock;
  const clockKey = clock ? `${clock.startedAt}|${clock.expiresAt}` : null;
  const alarm = useRef<{ key: string | null; armed: boolean; fired: boolean }>({
    key: null,
    armed: false,
    fired: false,
  });
  useEffect(() => {
    const a = alarm.current;
    if (clockKey !== a.key) {
      // A new clock: only arm it if it was still running when we saw it.
      alarm.current = { key: clockKey, armed: clockKey !== null && !clockExpired, fired: false };
      return;
    }
    if (a.key !== null && a.armed && !a.fired && clockExpired) {
      a.fired = true;
      if (on.current) p.current.alarm();
    }
  }, [clockKey, clockExpired]);
}
