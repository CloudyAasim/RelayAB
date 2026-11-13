/**
 * A submit-then-poll spec small enough for a test.
 *
 * Mirrors the shape of `ASYNC_VIDEO_SPEC` (submit returns a task id, polling
 * returns the final payload) with a two-millisecond interval so a job completes
 * inside a test instead of after three seconds.
 */
export const ASYNC_SPEC_FOR_TEST = {
  specVersion: 1,
  capability: "video.generate",
  displayName: "Async test vendor (submit + poll)",
  transport: { method: "POST", path: "/v1/videos" },
  auth: { type: "bearer" },
  request: { model: "$.model", prompt: "$.prompt" },
  response: {
    taskId: "$.task_id",
    status: "$.status",
    items: { $from: "$.output.urls", $to: { kind: "url", value: "$" } },
  },
  async: {
    submitTaskId: "$.task_id",
    poll: {
      method: "GET",
      path: "/v1/videos/{{taskId}}",
      intervalMs: 20,
      timeoutMs: 3_000,
      statusPath: "$.status",
      statusMap: { SUCCEEDED: "ok", FAILED: "fail", WAITING: "wait", "": "wait" },
    },
  },
  limits: { timeoutMs: 5_000 },
  metadata: { modes: ["text-to-video"], async: true },
};
