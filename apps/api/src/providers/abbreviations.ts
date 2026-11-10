/**
 * ESPN <-> Sleeper team abbreviations. Verified 2026-11-09 against both live feeds: of the 32
 * current teams only Washington differs (ESPN `WSH`, Sleeper `WAS`). Everything else is identical.
 * Field abbreviations in the app are ESPN's.
 */
const ESPN_TO_SLEEPER: Readonly<Record<string, string>> = { WSH: "WAS" };
const SLEEPER_TO_ESPN: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ESPN_TO_SLEEPER).map(([espn, sleeper]) => [sleeper, espn]),
);

export const toSleeperAbbr = (espn: string): string => ESPN_TO_SLEEPER[espn] ?? espn;
export const toEspnAbbr = (sleeper: string): string => SLEEPER_TO_ESPN[sleeper] ?? sleeper;
