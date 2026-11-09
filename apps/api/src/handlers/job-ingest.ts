// TODO(task 4/9): StatsProvider adapters (task 4) and the real ingestion job + elimination (task 9)
// per docs/design/07-implementation-plan.md §4.
export const handler = async (event: unknown) => {
  console.log("job-ingest invoked", JSON.stringify(event));
  return { ok: true, skipped: "not implemented" };
};
