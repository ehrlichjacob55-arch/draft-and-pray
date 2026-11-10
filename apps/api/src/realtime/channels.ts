/** Channel authorization shared by the AWS ws-default Lambda and the local WebSocket server. */
import { parseDraftChannel } from "@dnp/contract";
import { getMember, getSeasonMeta, type Dynamo } from "@dnp/db";

/** `draft:<seasonId>` requires membership of the league that owns the season (docs/design/14 §6). */
export async function canSubscribe(db: Dynamo, userId: string, channel: string): Promise<boolean> {
  const seasonId = parseDraftChannel(channel);
  if (!seasonId) return false;
  const meta = await getSeasonMeta(db, seasonId);
  if (!meta) return false;
  return (await getMember(db, meta.leagueId, userId)) !== undefined;
}

/** Ticket from a `?ticket=` query string (never logged). */
export function ticketFromQuery(query: Record<string, string | undefined> | null | undefined) {
  return query?.ticket ?? undefined;
}
