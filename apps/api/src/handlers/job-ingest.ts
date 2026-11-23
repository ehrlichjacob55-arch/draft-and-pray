import { createDynamo, dynamoConfigFromEnv } from "@dnp/db";
import { loadConfig } from "../config";
import { createEspnLiveSource } from "../providers";
import { awsPublisher } from "../realtime/aws-publisher";
import { noopPublisher } from "../realtime/types";
import { runDueIngests } from "../scoring/job";

/** Scheduler target (rate(2 minutes)): runs every enabled season whose next poll is due. */
export const handler = async (event: unknown) => {
  void event;
  const config = loadConfig();
  const db = createDynamo(dynamoConfigFromEnv({ ...process.env, APP_TABLE: config.APP_TABLE }));
  const publisher =
    config.WS_MANAGEMENT_ENDPOINT && config.WS_CONNECTIONS_TABLE ? awsPublisher : noopPublisher;
  const summary = await runDueIngests({
    db,
    now: () => new Date(),
    source: createEspnLiveSource(),
    publisher,
  });
  return { ok: true, ...summary };
};
