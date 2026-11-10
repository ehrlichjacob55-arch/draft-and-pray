import leagueV1 from "../../rulesets/league.v1.json";
import placeholderV1 from "../../rulesets/placeholder.v1.json";

/** Rulesets shipped as data (`packages/domain/rulesets/`); `pnpm admin seed-ruleset` loads one. */
export const BUILTIN_RULESETS = {
  league: leagueV1,
  placeholder: placeholderV1,
} as const;
export type BuiltinRulesetName = keyof typeof BUILTIN_RULESETS;
