import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export type Repo = {
  id: string
  path: string
  name: string
  branch: string
  head: string
  aliases: string[]
  cbmProject: string
  commonGitDir: string
}
const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase()
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const boundedLimit = (v: unknown) => Math.max(1, Math.min(10, Number(v) || 5))
const normalize = (s: string) =>
  s
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
    .toLowerCase()

export class LocalBackend {
  readonly db: DatabaseSync
  readonly repos: Repo[]
  active?: Repo
  readonly metrics = { calls: 0, externalModelCalls: 0 }
  constructor(
    readonly home: string,
    readonly binary: string,
    cwd = process.cwd(),
  ) {
    mkdirSync(home, { recursive: true })
    this.repos = JSON.parse(readFileSync(resolve(home, 'registry.json'), 'utf8')) as Repo[]
    this.active = [...this.repos]
      .sort((a, b) => b.path.length - a.path.length)
      .find(
        (r) =>
          normalize(cwd) === normalize(r.path) ||
          normalize(cwd).startsWith(normalize(r.path) + '/'),
      )
    this.db = new DatabaseSync(resolve(home, 'context.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, hash TEXT NOT NULL, metadata TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(project,branch,kind,hash));
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, body);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, agent TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, status TEXT NOT NULL, summary TEXT);
    `)
  }
  repo(ref?: string, branch?: string): Repo {
    if (!ref && this.active) return this.active
    const key = normalize(ref || '')
    const matches = this.repos.filter((r) =>
      [r.id, r.path, r.name, r.cbmProject, ...r.aliases].some((a) => normalize(a) === key),
    )
    const chosen = branch ? matches.filter((r) => r.branch === branch) : matches
    if (chosen.length === 1 && chosen[0]) return chosen[0]
    if (!branch && this.active && chosen.includes(this.active)) return this.active
    throw new Error(
      chosen.length > 1
        ? 'Several checkouts match; specify the checkout path or branch.'
        : 'Unknown project. Use an approved registry path/name; no default cross-project search.',
    )
  }
  scope(body: Record<string, unknown>): { repo: Repo; branch: string } {
    const userId = text(body.userId)
    if (userId.startsWith('project-')) {
      const [ref, ...rest] = userId.slice(8).split(':branch-')
      const repo = this.repo(ref)
      return { repo, branch: rest.join(':branch-') }
    }
    return { repo: this.repo(text(body.projectId) || undefined), branch: text(body.branch) }
  }
  save(
    repo: Repo,
    kind: string,
    content: string,
    title: string,
    branch = '',
    metadata: Record<string, unknown> = {},
  ) {
    if (!content.trim() || content.length > 32000)
      throw new Error('Content must contain 1-32000 characters.')
    if (
      /-----BEGIN .*PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/.test(
        content,
      )
    )
      throw new Error('Possible credential rejected. Store a source reference without secrets.')
    const hash = createHash('sha256').update(content.trim()).digest('hex')
    const old = this.db
      .prepare('SELECT id FROM notes WHERE project=? AND branch=? AND kind=? AND hash=?')
      .get(repo.id, branch, kind, hash)
    if (old) return { id: String(old.id), deduplicated: true }
    const id = randomUUID(),
      created = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO notes VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          repo.id,
          branch,
          kind,
          title.slice(0, 180),
          content.trim(),
          hash,
          JSON.stringify(metadata),
          created,
        )
      if (!inserted.changes) {
        const winner = this.db
          .prepare('SELECT id FROM notes WHERE project=? AND branch=? AND kind=? AND hash=?')
          .get(repo.id, branch, kind, hash)
        if (!winner) throw new Error('Concurrent note insertion could not be verified.')
        this.db.exec('COMMIT')
        return { id: String(winner.id), deduplicated: true }
      }
      this.db.prepare('INSERT INTO notes_fts VALUES(?,?)').run(id, fold(title + ' ' + content))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { id, created }
  }
  search(repo: Repo, kind: string, query: string, branch: string, limit: number) {
    const words = [...new Set(fold(query).match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16)
    if (!words.length) return []
    const match = words.map((w) => `"${w}"`).join(' OR ')
    return this.db
      .prepare(
        `SELECT n.*, bm25(notes_fts) AS rank FROM notes_fts JOIN notes n ON n.id=notes_fts.id WHERE notes_fts MATCH ? AND n.project=? AND n.kind=? AND n.branch=? ORDER BY rank, n.created DESC LIMIT ?`,
      )
      .all(match, repo.id, kind, branch, limit)
  }
  async cbm(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!existsSync(this.binary)) throw new Error('Configured CBM executable is unavailable.')
    const { stdout } = await execute(this.binary, ['cli', tool, JSON.stringify(args)], {
      windowsHide: true,
      timeout: 90000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const result: unknown = JSON.parse(stdout.trim())
    if (result && typeof result === 'object' && 'error' in result)
      throw new Error(String((result as { error: unknown }).error))
    return result
  }
  async projectStatus(repo: Repo) {
    const result = await this.cbm('index_status', { project: repo.cbmProject })
    return {
      repo: repo.path,
      projectId: repo.id,
      engineProject: repo.cbmProject,
      observedBranch: repo.branch,
      observedHead: repo.head,
      status: result,
      warning:
        'Registry SHA is a snapshot. Verify current Git and files before editing; index coverage is not proof of tests or deployment.',
    }
  }
  async api(path: string, init?: RequestInit): Promise<Response> {
    this.metrics.calls++
    try {
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      if (path === '/api/knowledge/track-feedback')
        return Response.json({
          recorded: false,
          reason: 'Feedback scoring is not enabled in offline profile.',
        })
      if (path === '/api/mem9/store') {
        const { repo, branch } = this.scope(body)
        const messages = body.messages as Array<{ content: string }>
        const saved = this.save(
          repo,
          'memory',
          messages.map((m) => m.content).join('\n'),
          'Technical handoff',
          branch,
          (body.metadata ?? {}) as Record<string, unknown>,
        )
        return Response.json({ ...saved, engine: 'sqlite-fts5', externalModelCalls: 0 })
      }
      if (path === '/api/mem9/search') {
        const { repo, branch } = this.scope(body)
        const rows = this.search(repo, 'memory', text(body.query), branch, boundedLimit(body.limit))
        return Response.json({
          memories: rows.map((r) => ({
            id: r.id,
            memory: String(r.content).slice(0, 2400),
            metadata: JSON.parse(String(r.metadata)),
          })),
          engine: 'sqlite-fts5',
          externalModelCalls: 0,
        })
      }
      if (path.startsWith('/api/mem9/') && init?.method === 'DELETE') {
        return Response.json(
          { error: 'Deletion is intentionally unavailable in this installed profile.' },
          { status: 403 },
        )
      }
      if (path === '/api/knowledge') {
        const { repo } = this.scope(body)
        return Response.json(
          this.save(repo, 'knowledge', text(body.content), text(body.title), '', {
            tags: body.tags ?? [],
            hallType: body.hallType ?? 'general',
            validFrom: body.validFrom,
            files: body.files ?? [],
            category: body.category ?? 'general',
            source: 'explicit-agent-contribution',
          }),
          { status: 201 },
        )
      }
      if (path === '/api/knowledge/search') {
        const { repo } = this.scope(body)
        const rows = this.search(repo, 'knowledge', text(body.query), '', 10)
        const results = rows
          .filter((r) => {
            const meta = JSON.parse(String(r.metadata)) as Record<string, unknown>
            return (
              (!body.hallType || meta.hallType === body.hallType) &&
              (!body.asOf || String(meta.validFrom || r.created) <= String(body.asOf)) &&
              (!(body.tags as unknown[] | undefined)?.length ||
                (body.tags as unknown[]).every((t) => (meta.tags as unknown[]).includes(t)))
            )
          })
          .slice(0, boundedLimit(body.limit))
          .map((r) => ({
            documentId: r.id,
            title: r.title,
            content: String(r.content).slice(0, 2400),
            score: undefined,
            document: {
              tags: JSON.stringify(JSON.parse(String(r.metadata)).tags ?? []),
              hall_type: JSON.parse(String(r.metadata)).hallType,
            },
          }))
        return Response.json({ query: body.query, results, engine: 'sqlite-fts5' })
      }
      if (path === '/api/knowledge/file-notes')
        return Response.json({ notes: [], engine: 'sqlite-fts5', supported: false })
      return Response.json(
        { error: 'Endpoint not supported by the offline local profile.' },
        { status: 404 },
      )
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      )
    }
  }
}
