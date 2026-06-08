/**
 * Code-review workflow — the root Render Workflow task.
 *
 * Importing this module registers the `code-review` task *and* one task per
 * shared agent (the top-level `agentTask(...)` calls). Inside the task body,
 * `prepareDiff` runs in-process and each reviewer runs as its own chained Render
 * task via `Promise.all` — the same fan-out as naive-agent and worker-agents, but each agent in
 * its own isolated instance.
 *
 * The agents themselves come from @workshop/agent — identical to the ones the
 * naive and worker patterns run.
 */
import { task } from "@renderinc/sdk/workflows";
import {
  prepareDiff,
  filterDiff,
  parseDecision,
  securityReviewer,
  performanceReviewer,
  uxReviewer,
  hasFrontendFiles,
  judge,
} from "@workshop/agent";
import { agentTask } from "../../agentTask.js";

// Register each shared agent as its own Render task (at module load). Every agent
// is registered up front; the UX task is only *invoked* when the diff warrants it.
const securityTask = agentTask(securityReviewer);
const performanceTask = agentTask(performanceReviewer);
const uxTask = agentTask(uxReviewer);
const judgeTask = agentTask(judge);

interface CodeReviewInput {
  url: string;
  labels?: string[];
  /** Break-glass: review the whole diff, including noise files. */
  breakGlass?: boolean;
  /** Correlation id — links this run's agent spans together in the viewer. */
  _runId?: string;
}

export default task(
  { name: "code-review", timeoutSeconds: 600 },
  async function codeReview(input: CodeReviewInput) {
    const runId = input._runId;

    // Deterministic steps run in-process; agents run as chained Render tasks.
    const allPatches = await prepareDiff({ url: input.url, labels: input.labels ?? [] });
    const breakGlass = input.breakGlass || (input.labels ?? []).includes("break-glass");
    const { patches } = filterDiff(allPatches, breakGlass ? { breakGlass } : {});

    // Conditional fan-out: security + performance always; UX only for frontend.
    const reviewerTasks = [
      { name: securityReviewer.name, run: securityTask },
      { name: performanceReviewer.name, run: performanceTask },
    ];
    if (hasFrontendFiles(patches)) {
      reviewerTasks.push({ name: uxReviewer.name, run: uxTask });
    }

    const reviews = await Promise.all(
      reviewerTasks.map(async ({ name, run }) => {
        const result = await run({ patches }, runId);
        return { agent: name, note: result.text };
      }),
    );

    const decision = await judgeTask({ findings: reviews }, runId);
    const parsed = parseDecision(decision.text);

    return { verdict: parsed.verdict, reason: parsed.reason, reviews };
  },
);
