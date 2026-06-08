import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadWorkflows } from '../../packages/workflow-agents/src/workflows/loader.js'

const workflowsDir = new URL(
  '../../packages/workflow-agents/src/workflows',
  import.meta.url,
).pathname

test('loadWorkflows auto-discovers the workflow folders', async () => {
  const { mapping, localTasks } = await loadWorkflows(workflowsDir)
  assert.deepEqual(Object.keys(mapping).sort(), ['code-review', 'your-review'])
  assert.equal(typeof localTasks['code-review'], 'function')
  assert.equal(typeof localTasks['your-review'], 'function')
  // Slugs are derived as "{service}/{folder}".
  assert.match(mapping['code-review'] ?? '', /\/code-review$/)
})
