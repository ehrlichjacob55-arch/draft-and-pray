import { createHash } from "node:crypto";
import { ulid } from "ulid";

/** Sortable unique id for leagues, seasons, teams, players, audit events, transactions. */
export const newId = (seedTime?: number): string => ulid(seedTime);

/** Stable fake Cognito `sub` for local dev (docs/design/11 §3.2). `email` must be normalized. */
export const localSub = (email: string): string =>
  `local-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
