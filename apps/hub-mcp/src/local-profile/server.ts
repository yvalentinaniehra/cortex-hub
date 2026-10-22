import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { setLocalApi } from '../api-call.js'
import { registerMemoryTools } from '../tools/memory.js'
import { registerKnowledgeTools } from '../tools/knowledge.js'
import type { Env } from '../types.js'
import type { LocalBackend } from './backend.js'

const reply = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2),
    },
  ],
})
// Graph fingerprints and raw whole-module text are not useful model context.
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !['fp', 'sp', 'bt', 'source', 'context'].includes(k))
        .map(([k, v]) => [k, compact(v)]),
    )
  return value
}
export function createLocalServer(backend: LocalBackend) {
  const server = new McpServer(
    { name: 'cortex-local-cbm', version: '1.3.1-local.1' },
    {
      instructions:
        'Offline Cortex adaptation. SQLite FTS5 recall (keyword/BM25, no embeddings); existing MIT CBM handles code. Start with repo checkout path. Recall relevant context once, then use CBM search_graph/get_code_snippet/trace_path; do not duplicate the same lookup in both servers. Save only authorized technical conclusions with SHA/source; never credentials or restricted documents. Verify Git/source freshness. No cloud models or GitNexus. Statistics do not claim quota savings.',
    },
  )
  setLocalApi((path, init) => backend.api(path, init))
  const env: Env = {
    QDRANT_URL: '',
    CLIPROXY_URL: '',
    DASHBOARD_API_URL: 'local://cortex',
    MCP_SERVER_NAME: 'cortex-local-cbm',
    MCP_SERVER_VERSION: '1.3.1-local.1',
    API_KEYS: '',
  }
  // Reuse upstream tools and schemas. Correct their descriptions for lexical local search.
  const tool = server.tool.bind(server)
  // The upstream SDK has several overloads; this wrapper forwards its four-argument form.
  server.tool = ((
    name: string,
    description: string,
    schema: Record<string, z.ZodType>,
    handler: never,
  ) =>
    tool(
      name,
      description
        .replace(/semantic similarity/g, 'local keyword/BM25 relevance')
        .replace(/semantic search/g, 'local keyword/BM25 search')
        .replace(
          'Auto-chunks and embeds the content',
          'Stores the content locally without embeddings',
        )
        .replace('auto-embedded', 'keyword query'),
      schema,
      handler,
    )) as typeof server.tool
  registerMemoryTools(server, env)
  registerKnowledgeTools(server, env)
  const safe =
    (fn: (args: Record<string, unknown>) => Promise<unknown>) =>
    async (args: Record<string, unknown>) => {
      try {
        return reply(await fn(args))
      } catch (error) {
        return {
          ...reply({ error: error instanceof Error ? error.message : String(error) }),
          isError: true,
        }
      }
    }
  server.tool(
    'cortex_health',
    'Report actual offline services, project count and limitations; does not infer quota savings.',
    {},
    safe(async () => ({
      profile: 'offline-local-cbm',
      projects: backend.repos.length,
      memory: 'sqlite-fts5',
      code: 'existing-codebase-memory-mcp',
      externalModelCalls: 0,
      gitnexus: 'not-installed',
      dashboard: 'upstream dashboard not deployed',
      metrics: backend.metrics,
    })),
  )
  server.tool(
    'cortex_projects',
    'List approved checkout IDs and index identifiers. No automatic document import.',
    {},
    safe(async () =>
      backend.repos.map(({ id, path, branch, cbmProject }) => ({ id, path, branch, cbmProject })),
    ),
  )
  server.tool(
    'cortex_session_start',
    'Start a project-scoped local session. Pass checkout path; Git branches remain independently indexed.',
    { repo: z.string(), agentId: z.string().optional(), branch: z.string().optional() },
    safe(async (a) => {
      const repo = backend.repo(String(a.repo), a.branch as string | undefined)
      backend.active = repo
      const id = randomUUID()
      const recent = backend.db
        .prepare(
          'SELECT id, branch, ended, summary FROM sessions WHERE project=? AND status=? ORDER BY ended DESC LIMIT 3',
        )
        .all(repo.id, 'completed')
      backend.db
        .prepare('INSERT INTO sessions(id,project,branch,agent,started,status) VALUES(?,?,?,?,?,?)')
        .run(
          id,
          repo.id,
          repo.branch,
          String(a.agentId || 'codex'),
          new Date().toISOString(),
          'active',
        )
      return {
        sessionId: id,
        projectId: repo.id,
        checkout: repo.path,
        branch: repo.branch,
        recentSessions: recent,
        instructions:
          'Recall relevant memory/knowledge using this projectId; code uses CBM project ' +
          repo.cbmProject,
      }
    }),
  )
  server.tool(
    'cortex_session_end',
    'Close a real local session and save the supplied technical summary. Idempotent; unknown session is an error.',
    { sessionId: z.string(), summary: z.string().min(1).max(12000), auto: z.boolean().optional() },
    safe(async (a) => {
      const row = backend.db.prepare('SELECT * FROM sessions WHERE id=?').get(String(a.sessionId))
      if (!row || !backend.active || row.project !== backend.active.id)
        throw new Error('Unknown session or wrong active project.')
      if (row.status !== 'active')
        return { sessionId: row.id, status: row.status, alreadyClosed: true }
      if (!a.auto)
        backend.save(
          backend.active,
          'memory',
          String(a.summary),
          'Session summary',
          String(row.branch),
          { sessionId: row.id, source: 'session_end' },
        )
      backend.db
        .prepare('UPDATE sessions SET ended=?,status=?,summary=? WHERE id=?')
        .run(
          new Date().toISOString(),
          a.auto ? 'abandoned' : 'completed',
          String(a.summary),
          String(a.sessionId),
        )
      return {
        sessionId: row.id,
        status: a.auto ? 'abandoned' : 'completed',
        savedToMemory: !a.auto,
      }
    }),
  )
  server.tool(
    'cortex_code_status',
    'Check the actual CBM index for a registered checkout. Does not run an index or write source.',
    { repo: z.string().optional(), branch: z.string().optional() },
    safe(async (a) =>
      backend.projectStatus(
        backend.repo(a.repo as string | undefined, a.branch as string | undefined),
      ),
    ),
  )
  server.tool(
    'cortex_code_search',
    'Search the existing CBM graph; returns compact symbols and source positions, not GitNexus execution flows.',
    {
      query: z.string().min(1).max(500),
      repo: z.string().optional(),
      limit: z.number().int().min(1).max(12).optional(),
    },
    safe(async (a) => {
      const repo = backend.repo(a.repo as string | undefined)
      return compact(
        await backend.cbm('search_graph', {
          project: repo.cbmProject,
          query: a.query,
          limit: a.limit || 8,
        }),
      )
    }),
  )
  return server
}
