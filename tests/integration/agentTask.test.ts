import { test } from 'node:test'
import assert from 'node:assert/strict'
import { securityReviewer } from '@workshop/agent'
import { agentTask } from '../../packages/workflow-agents/src/agentTask.js'

test('agentTask wraps a shared agent into a callable Render task', async () => {
  const run = agentTask(securityReviewer)
  assert.equal(typeof run, 'function')

  // Outside a workflow context, the task runs the agent in-process (mock model).
  const result = await run({ patches: [{ file: 'a.ts', diff: '+x' }] })
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.length > 0)
  assert.equal(typeof result.usage.inputTokens, 'number')
})

test('agentTask accepts an optional runId for span correlation', async () => {
  const run = agentTask(securityReviewer)
  const result = await run({ patches: [{ file: 'a.ts', diff: '+x' }] }, 'test-run-id')
  assert.equal(typeof result.text, 'string')
})
