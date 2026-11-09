import { ulid } from "ulid";

/** Sortable unique id for leagues, seasons, teams, players, audit events, transactions. */
export const newId = (seedTime?: number): string => ulid(seedTime);
