/**
 * Pattern 3 — gateway (web service).
 *
 * A Hono server that turns inbound PR submissions / GitHub webhooks into Render
 * Workflow runs, and serves the shared telemetry viewer.
 *
 * In local dev (`RENDER_USE_LOCAL_DEV=true`) workflows run in-process as direct
 * function calls. In production the Render SDK dispatches them as Workflow task
 * runs on separate instances. Either way, code reviews are persisted to
 * @workshop/db so the viewer shows the same reviews table as Patterns 1 & 2.
 */
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { addFinding, createReview, migrate, setReviewResult } from "@workshop/db";
import { createUiRouter } from "@workshop/ui";
import { loadWorkflows } from "./workflows/loader.js";
import { matchPullRequest, verifyGithubSignature } from "./github.js";

/** What the code-review workflow returns (see workflows/code-review). */
interface CodeReviewResult {
  verdict?: string;
  reason?: string;
  reviews?: Array<{ agent: string; note: string }>;
}

/** Build the gateway app. Exported so tests can drive it via `app.fetch`. */
export async function createApp(): Promise<Hono> {
  const isLocalDev = process.env.RENDER_USE_LOCAL_DEV === "true";
  const { mapping, localTasks } = await loadWorkflows(
    new URL("./workflows", import.meta.url).pathname,
  );

  /**
   * Run a workflow to completion and return its result. Local dev calls the task
   * function directly; production dispatches it to the Render Workflow service.
   */
  async function runWorkflow(name: string, input: unknown): Promise<unknown> {
    if (isLocalDev) {
      const fn = localTasks[name];
      if (!fn) throw new Error(`no local task for workflow "${name}"`);
      return fn(input);
    }
    const slug = mapping[name];
    if (!slug) throw new Error(`unknown workflow "${name}"`);
    const { Render } = await import("@renderinc/sdk");
    const render = new Render();
    const started = await render.workflows.startTask(slug, [input]);
    const finished = await started.get();
    const ok = finished.status === "succeeded" || finished.status === "completed";
    if (!ok) throw new Error(finished.error ? String(finished.error) : "workflow failed");
    return finished.results;
  }

  /**
   * Start a code review: create the review row immediately (so the viewer shows
   * it as running), then run the workflow in the background and persist the
   * outcome.
   */
  async function runCodeReview(prUrl: string, labels: string[] = []): Promise<string> {
    const reviewId = await createReview(prUrl);
    void (async () => {
      try {
        const result = (await runWorkflow("code-review", {
          url: prUrl,
          labels,
          _runId: reviewId,
        })) as CodeReviewResult;
        for (const f of result.reviews ?? []) await addFinding(reviewId, f.agent, f.note);
        await setReviewResult(reviewId, {
          status: "done",
          ...(result.verdict ? { verdict: result.verdict } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[workflow-agents] review ${reviewId} failed:`, message);
        await setReviewResult(reviewId, { status: "error", reason: message }).catch(() => {});
      }
    })();
    return reviewId;
  }

  const app = new Hono();

  // API-key auth for the review + webhook write paths. Open when WORKFLOW_API_KEY
  // is unset. (Reads — the viewer and its APIs — are always open.)
  const apiKey = process.env.WORKFLOW_API_KEY;
  if (apiKey) {
    const expected = `Bearer ${apiKey}`;
    app.use("/webhooks/*", async (c, next) => {
      if (c.req.header("authorization") === expected) return next();
      return c.json({ error: "unauthorized" }, 401);
    });
    app.use("/api/reviews", async (c, next) => {
      if (c.req.method !== "POST") return next();
      if (c.req.header("authorization") === expected) return next();
      return c.json({ error: "unauthorized" }, 401);
    });
  }

  app.get("/healthz", (c) => c.json({ ok: true }));

  // The single trigger for a code review (same shape as Patterns 1 & 2). Authored
  // workflows like your-review are run via the Render CLI (`render workflows dev`).
  app.post("/api/reviews", async (c) => {
    if (!mapping["code-review"]) return c.json({ error: "code-review not available" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { prUrl?: string };
    if (!body.prUrl) return c.json({ error: "prUrl is required" }, 400);
    const reviewId = await runCodeReview(body.prUrl);
    return c.json({ id: reviewId }, 202);
  });

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    if (!verifyGithubSignature(rawBody, c.req.header())) {
      return c.json({ error: "signature verification failed" }, 401);
    }
    let event: unknown;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const matched = matchPullRequest(event, c.req.header());
    if (!matched) return c.json({ ignored: true }, 202);
    const reviewId = await runCodeReview(matched.url, matched.labels);
    return c.json({ runId: reviewId, status: "running" }, 202);
  });

  // The same telemetry viewer as Patterns 1 & 2 (reviews + findings + spans).
  // Deep per-agent traces live in the Render Dashboard.
  app.route("/", createUiRouter("Pattern 3 — Workflow agents"));

  console.info(
    `[workflow-agents] workflows: ${Object.keys(mapping).join(", ")} (localDev: ${isLocalDev})`,
  );
  return app;
}

// Run as a server only when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  await migrate();
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    console.info(`[workflow-agents] listening on http://localhost:${info.port}`);
  });
}
