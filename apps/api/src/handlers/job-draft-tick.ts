// TODO(task 6): idempotent draft tick (start/pause/resume/pick/undo/tick API) per
// docs/design/07-implementation-plan.md §4 and 03-draft-design.md.
export const handler = async (event: unknown) => {
  console.log("job-draft-tick invoked", JSON.stringify(event));
  return { ok: true, skipped: "not implemented" };
};
