import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { LocalBackend, type Repo } from './backend.js'

const home = mkdtempSync(join(tmpdir(), 'cortex-local-integration-'))
const registry = JSON.parse(
  readFileSync(join(homedir(), '.codex/data/cortex-local/registry.json'), 'utf8'),
) as Repo[]
const repoA = registry.find((r) => r.name === 'Ketoan-app') as Repo
const repoB = registry.find((r) => r.name === 'claris-sift-pdf') as Repo
if (!repoA || !repoB) throw new Error('Required integration checkout fixtures are not registered.')
writeFileSync(join(home, 'registry.json'), JSON.stringify([repoA, repoB]))
const clients: Client[] = []
async function connect() {
  const client = new Client({ name: 'local-profile-integration', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings', resolve('dist/local-profile/stdio.js')],
      env: { ...process.env, CORTEX_LOCAL_HOME: home } as Record<string, string>,
      stderr: 'pipe',
    }),
  )
  clients.push(client)
  return client
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args })
  const blocks = response.content as Array<{ text?: string }>
  return { error: response.isError === true, text: blocks.map((b) => b.text || '').join('\n') }
}
describe('real local STDIO profile', () => {
  let first: Client
  beforeAll(async () => {
    first = await connect()
  }, 20000)
  afterAll(async () => {
    for (const client of clients) await client.close()
  })
  it('has real offline capability disclosure and rejects unknown scope/session', async () => {
    expect((await call(first, 'cortex_health', {})).text).toContain('sqlite-fts5')
    expect((await call(first, 'cortex_session_start', { repo: 'not-registered' })).error).toBe(true)
    expect(
      (await call(first, 'cortex_session_end', { sessionId: 'invented', summary: 'must fail' }))
        .error,
    ).toBe(true)
  })
  it('persists recall across process reconnects, scopes projects and deduplicates concurrent writes', async () => {
    const session = JSON.parse(
      (await call(first, 'cortex_session_start', { repo: repoA.path })).text,
    )
    const note = {
      projectId: repoA.id,
      branch: repoA.branch,
      content:
        'Kiểm tra đối chiếu công nợ; nguồn: fixture integration, không phải kết quả sản phẩm.',
    }
    expect((await call(first, 'cortex_memory_store', note)).error).toBe(false)
    expect(
      (
        await call(first, 'cortex_memory_search', {
          projectId: repoA.id,
          branch: repoA.branch,
          query: 'doi chieu cong no',
        })
      ).text,
    ).toContain('đối chiếu công nợ')
    expect(
      (
        await call(first, 'cortex_memory_search', {
          projectId: repoB.id,
          query: 'doi chieu cong no',
        })
      ).text,
    ).not.toContain('đối chiếu công nợ')
    const second = await connect()
    expect(
      (
        await call(second, 'cortex_memory_search', {
          projectId: repoA.id,
          branch: repoA.branch,
          query: 'cong no',
        })
      ).text,
    ).toContain('đối chiếu công nợ')
    const simultaneous = await Promise.all([
      call(first, 'cortex_memory_store', {
        ...note,
        content: 'Concurrent unique technical fixture.',
      }),
      call(second, 'cortex_memory_store', {
        ...note,
        content: 'Concurrent unique technical fixture.',
      }),
    ])
    expect(simultaneous.every((r) => !r.error)).toBe(true)
    const ids = simultaneous.map((r) => JSON.parse(r.text).result.id)
    expect(ids[0]).toBe(ids[1])
    expect(
      (
        await call(first, 'cortex_session_end', {
          sessionId: session.sessionId,
          summary: 'Integration fixture completed; no product acceptance claim.',
        })
      ).error,
    ).toBe(false)
    expect(
      (await call(first, 'cortex_session_end', { sessionId: session.sessionId, summary: 'repeat' }))
        .text,
    ).toContain('alreadyClosed')
  })
  it('reuses the actual CBM binary and fails visibly for a missing executable', async () => {
    const status = await call(first, 'cortex_code_status', { repo: repoA.path })
    expect(status.error).toBe(false)
    expect(status.text).toContain(repoA.cbmProject)
    const search = await call(first, 'cortex_code_search', {
      repo: repoA.path,
      query: 'ledger',
      limit: 3,
    })
    expect(search.error).toBe(false)
    expect(search.text).toContain('results')
    const backend = new LocalBackend(home, join(home, 'missing.exe'), home)
    await expect(backend.cbm('list_projects', {})).rejects.toThrow('unavailable')
    backend.db.close()
  }, 30000)
  it('stores knowledge, applies filters, rejects credentials and does not silently delete', async () => {
    expect(
      (
        await call(first, 'cortex_knowledge_store', {
          projectId: repoA.id,
          title: 'Technical fixture',
          content: 'SQLITE_WAL_BUSY fixture resolution',
          tags: ['fixture'],
          hallType: 'lesson',
        })
      ).error,
    ).toBe(true)
    expect(
      (
        await call(first, 'cortex_knowledge_store', {
          projectId: repoA.id,
          title: 'Technical fixture',
          content: 'SQLITE_WAL_BUSY fixture resolution',
          tags: ['fixture'],
          hallType: 'discovery',
        })
      ).error,
    ).toBe(false)
    expect(
      (
        await call(first, 'cortex_knowledge_search', {
          projectId: repoA.id,
          query: 'SQLITE_WAL_BUSY',
          tags: ['fixture'],
        })
      ).text,
    ).toContain('fixture resolution')
    expect(
      (
        await call(first, 'cortex_knowledge_search', {
          projectId: repoB.id,
          query: 'SQLITE_WAL_BUSY',
        })
      ).text,
    ).not.toContain('fixture resolution')
    expect(
      (
        await call(first, 'cortex_memory_store', {
          projectId: repoA.id,
          content: '-----BEGIN PRIVATE KEY----- synthetic fixture only',
        })
      ).error,
    ).toBe(true)
    expect((await call(first, 'cortex_memory_delete', { id: 'invented' })).error).toBe(true)
  })
})
