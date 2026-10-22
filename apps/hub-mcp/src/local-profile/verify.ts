import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Repo } from './backend.js'

const home = process.env.CORTEX_LOCAL_HOME || join(homedir(), '.codex/data/cortex-local')
const client = new Client({ name: 'installed-profile-verifier', version: '1' })
const entry = fileURLToPath(new URL('./stdio.js', import.meta.url))
const checks: Array<Record<string, unknown>> = []
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', entry],
    stderr: 'pipe',
  }),
)
try {
  const tools = await client.listTools()
  for (const name of [
    'cortex_health',
    'cortex_projects',
    'cortex_session_start',
    'cortex_session_end',
    'cortex_memory_search',
    'cortex_memory_store',
    'cortex_knowledge_search',
    'cortex_knowledge_store',
    'cortex_code_status',
  ]) {
    if (!tools.tools.some((t) => t.name === name))
      throw new Error('Missing installed tool: ' + name)
  }
  const health = await client.callTool({ name: 'cortex_health', arguments: {} })
  if (health.isError) throw new Error('Installed health tool failed.')
  const repos = JSON.parse(readFileSync(resolve(home, 'registry.json'), 'utf8')) as Repo[]
  for (const repo of repos) {
    const response = await client.callTool({
      name: 'cortex_code_status',
      arguments: { repo: repo.path },
    })
    const data = JSON.parse((response.content as Array<{ text: string }>)[0]?.text || '{}')
    const ready = !response.isError && data.status?.status === 'ready'
    checks.push({
      path: repo.path,
      projectId: repo.id,
      engineProject: repo.cbmProject,
      ready,
      nodes: data.status?.nodes,
      edges: data.status?.edges,
    })
    if (!ready) throw new Error('Index not ready: ' + repo.path)
  }
  const result = {
    verifiedAt: new Date().toISOString(),
    transport: 'actual-stdio-mcp',
    enabledToolNamesPresent: 9,
    checkouts: checks,
    allReady: checks.every((c) => c.ready),
    health,
    externalModelCalls: 0,
    quotaSavingsMeasured: false,
  }
  writeFileSync(resolve(home, 'runtime-verification.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(
    JSON.stringify({
      allReady: result.allReady,
      checkouts: checks.length,
      receipt: resolve(home, 'runtime-verification.json'),
    }),
  )
} finally {
  await client.close()
}
