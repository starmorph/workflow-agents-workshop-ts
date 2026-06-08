# 04 — Author a task (the hands-on finale)

> This is the half where coding agents come out. Open `your-review` and treat it
> as a sandbox — extend it however you like. The API is small enough that an agent
> reasons about it trivially. (In Session 1 you hand-wrote the worker's acks; here
> the goal is to feel how agent-native this is.)

## Anatomy of a task

```ts
import { task } from "@renderinc/sdk/workflows";

export default task(
  {
    name: "your-review",
    timeoutSeconds: 120,
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
  },
  async function yourReview(input) {
    // ...your logic...
  },
);
```

That's the whole API surface:

- **A config object** — `name`, `timeoutSeconds`, `retry` (maxRetries / backoff),
  optional `plan` (compute size).
- **A function** — any `async (input) => result`.

Three things you get for free, that `worker-agents/src/kv.ts` had to build by hand:

| You write | Render gives you |
| --- | --- |
| `retry: { maxRetries: 2, … }` | automatic retries with backoff, in a fresh instance |
| `await someTask({ input })` | isolation — each task runs in its own container |
| nothing | a full trace of every task + sub-task run |

And **composition is just function calls**: call a task from inside a task; wrap
them in `Promise.all` to fan out. A *deterministic step* (pure logic) is just a
plain function — no `task()` needed.

## Your turn

Open [`packages/workflow-agents/src/workflows/your-review/index.ts`](../packages/workflow-agents/src/workflows/your-review/index.ts).
It's a working sandbox that fetches a PR and returns an overview. Explore from there —
the file ends with commented ideas, not a prescribed fill-in.

### 1. Run what's there

```sh
cd packages/workflow-agents
cp .env.example .env
npm install            # from repo root if first time
npm run dev:workflows  # terminal A
```

In terminal B:

```sh
render workflows tasks list --local
# choose your-review → run → input: { "url": "https://github.com/<owner>/<repo>/pull/<n>" }
```

You just authored and ran a task. Note: you never registered it anywhere —
`loader.ts` discovered it because the folder exists and exports a task.

### 2. Compose an agent as a task

Pick one reviewer and run it as its own isolated task. Example — security:

```ts
import { securityReviewer } from "@workshop/agent";
import { agentTask } from "../../agentTask.js";

const securityTask = agentTask(securityReviewer);

// inside yourReview, after you have `filtered.patches`:
const review = await securityTask({ patches: filtered.patches });
return { ...existingReturn, review: review.text };
```

Re-run. In the Render Dashboard trace (or the `render workflows dev` output)
you'll see `your-review` with a nested `security` agent task, its LLM turns, and
token usage.

### 3. See the power: force a retry

Temporarily throw at the top of the task body:

```ts
if (Math.random() < 0.5) throw new Error("flaky!");
```

Re-run a few times and watch Render retry in a fresh instance per your `retry`
config — no try/catch, no queue, no dead-letter logic. Remove it when done.

### 4. Bonus — fan out

Swap the single reviewer for both, in parallel:

```ts
import { REVIEWERS } from "@workshop/agent";
const reviewerTasks = REVIEWERS.map(agentTask);
const reviews = await Promise.all(
  reviewerTasks.map((run) => run({ patches: filtered.patches })),
);
```

That's the same fan-out as the built-in `code-review` workflow — compare your file
to [`code-review/index.ts`](../packages/workflow-agents/src/workflows/code-review/index.ts).

### 5. Go further (optional)

The sandbox is intentionally open-ended. Some directions:

- Add `parseDecision` + `judge` for a full verdict (mirror `code-review`).
- Use `selectReviewers` / `hasFrontendFiles` for conditional UX review.
- Add a custom tool in `shared/agent/src/tools/` and wire it to an agent.
- Return raw patch previews for debugging, or strip them to keep output small.

## The takeaway

You added durable, retried, isolated, traced, parallel execution by writing a
plain function and a config object. In worker-agents that same set of guarantees took
a queue, a consumer group, acks, retries, and a pub/sub bus — all code you had to
own and debug. That is the whole arc of the workshop: the agent never changed;
the substrate did all the work.
