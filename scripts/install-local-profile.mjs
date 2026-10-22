import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const codex = join(homedir(), '.codex')
const config = join(codex, 'config.toml')
const instructions = join(codex, 'AGENTS.md')
const data = join(codex, 'data', 'cortex-local')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(codex, 'backups', 'cortex-local-' + stamp)
const beforeConfig = readFileSync(config, 'utf8')
const beforeInstructions = existsSync(instructions) ? readFileSync(instructions, 'utf8') : ''
const marker = '<!-- cortex-local-cbm:start -->'
if (/^\[mcp_servers\.cortex-local\]/m.test(beforeConfig) || beforeInstructions.includes(marker))
  throw new Error('Existing owned configuration found; inspect before updating.')
const entry = resolve('apps/hub-mcp/dist/local-profile/stdio.js').replaceAll('\\', '/')
if (!existsSync(entry)) throw new Error('Build the actual local entry point before installation.')
const receipt = JSON.parse(readFileSync(join(data, 'index-receipt.json'), 'utf8'))
if (receipt.results.length !== 15 || receipt.results.some((r) => r.status !== 'INDEXED'))
  throw new Error('Every registered checkout must have an index receipt before activation.')
mkdirSync(backup, { recursive: true })
copyFileSync(config, join(backup, 'config.toml'))
if (existsSync(instructions)) copyFileSync(instructions, join(backup, 'AGENTS.md'))
const block = `
# Cortex local profile: STDIO, no GitNexus or cloud models.
[mcp_servers.cortex-local]
command = ${JSON.stringify(process.execPath.replaceAll('\\', '/'))}
args = ["--no-warnings", ${JSON.stringify(entry)}]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled_tools = ["cortex_health", "cortex_projects", "cortex_session_start", "cortex_session_end", "cortex_memory_search", "cortex_memory_store", "cortex_knowledge_search", "cortex_knowledge_store", "cortex_code_status"]
`
const guidance = `
${marker}
## Cortex local context for registered V-TIP repositories

- Registry: C:/Users/ASUS/.codex/data/cortex-local/registry.json. Applies only to its approved checkout paths; retired DEMO-autovd stays excluded.
- At a new registered-repo coding session, call cortex-local.cortex_session_start with the absolute checkout path; retain sessionId/projectId. Recall narrowly relevant memory/knowledge once using that projectId and current branch. SQLite recall is lexical/BM25, not semantic embedding search.
- Keep codebase-memory-mcp as the source graph engine. Use search_graph/get_code_snippet/trace_path for code, literal rg for exact strings. Do not repeat the same lookup through multiple servers. Respect .cbmignore; documents, vaults, credentials and derived output are excluded.
- Verify current Git/source and index freshness; saved registry SHA is only a snapshot. CLI-indexed projects are not assumed watched. To refresh approved indexes use node D:/project/cortex-hub/scripts/local-profile-operator.mjs index; add --rebuild after changing .cbmignore or when an existing cache still exposes excluded files. This operator never stages/stashes/commits product source.
- Save only authorized reusable technical findings with source/SHA/check evidence. Never bulk-import business documents, customer records, secrets or historical chats. Close the owned session with a concise technical summary when work finishes. A saved note is not CI, deploy, UAT or approval evidence.
- If the local server is unavailable, state that briefly and use existing CBM/repo evidence; do not invent remembered facts, successful handoffs or quota savings.
<!-- cortex-local-cbm:end -->
`
// Preserve all existing config and instructions verbatim; append only owned sections.
writeFileSync(config, beforeConfig + (beforeConfig.endsWith('\n') ? '' : '\n') + block)
writeFileSync(
  instructions,
  beforeInstructions + (beforeInstructions.endsWith('\n') ? '' : '\n') + guidance,
)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const installed = {
  at: new Date().toISOString(),
  backup,
  config,
  instructions,
  configSha256: hash(config),
  instructionsSha256: hash(instructions),
  entry,
  enabledTools: 9,
  transport: 'stdio',
  sourceProfile: '1.3.1-local.1',
  gitnexusActivated: false,
  externalModelCalls: 0,
}
writeFileSync(join(data, 'install-receipt.json'), JSON.stringify(installed, null, 2) + '\n')
console.log(
  JSON.stringify({
    installed: true,
    transport: 'stdio',
    enabledTools: 9,
    receipt: join(data, 'install-receipt.json'),
    backup,
  }),
)
