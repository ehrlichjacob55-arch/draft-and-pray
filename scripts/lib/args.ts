import { parseArgs } from "node:util";

/** Parses `--flag value` options; first positional(s) are the command words. */
export function parseCli(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      email: { type: "string" },
      league: { type: "string" },
      year: { type: "string" },
      count: { type: "string" },
      table: { type: "string" },
      region: { type: "string" },
      "user-pool-id": { type: "string" },
      "client-id": { type: "string" },
      "base-url": { type: "string" },
      "season-id": { type: "string" },
      "season-year": { type: "string" },
      "test-league": { type: "boolean" },
      "from-csv": { type: "boolean" },
      teams: { type: "string" },
      players: { type: "string" },
      pool: { type: "string" },
    },
  });
  return { flags: values, positionals };
}
