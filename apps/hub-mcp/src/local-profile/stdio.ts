import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LocalBackend } from './backend.js'
import { createLocalServer } from './server.js'

const home = process.env.CORTEX_LOCAL_HOME || join(homedir(), '.codex', 'data', 'cortex-local')
const binary =
  process.env.CORTEX_CBM_BINARY ||
  join(process.env.LOCALAPPDATA || '', 'Programs', 'codebase-memory-mcp', 'codebase-memory-mcp.exe')
const backend = new LocalBackend(home, binary)
const server = createLocalServer(backend)
await server.connect(new StdioServerTransport())
process.stdin.on('end', () => {
  void server.close().finally(() => backend.db.close())
})
