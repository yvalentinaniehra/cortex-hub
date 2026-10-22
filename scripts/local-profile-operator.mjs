import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const exec = promisify(execFile)
const data = process.env.CORTEX_LOCAL_HOME || join(homedir(), '.codex', 'data', 'cortex-local')
const cbm =
  process.env.CORTEX_CBM_BINARY ||
  join(process.env.LOCALAPPDATA, 'Programs', 'codebase-memory-mcp', 'codebase-memory-mcp.exe')
const inventoryPath = join(
  homedir(),
  '.codex',
  'reports',
  'cortex-rollout-20261022',
  'repo-inventory.json',
)
const run = async (file, args, timeout = 180000) =>
  (await exec(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
const git = (path, ...args) => run('git', ['-C', path, ...args])
const norm = (s) => s.replaceAll('\\', '/').toLowerCase()
mkdirSync(data, { recursive: true })
if (process.argv[2] === 'prepare') {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8').replace(/^\uFEFF/, ''))
  const projects = JSON.parse(await run(cbm, ['cli', 'list_projects', '{}'])).projects
  const rows = []
  for (const item of inventory.repositories) {
    const common = await git(item.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    let alias = ''
    try {
      const remote = await git(item.path, 'remote', 'get-url', 'origin')
      alias =
        remote
          .replace(/\.git$/, '')
          .split(/[/\\]/)
          .pop() || ''
    } catch {
      /* no remote required */
    }
    const id = 'repo-' + createHash('sha256').update(norm(common)).digest('hex').slice(0, 12)
    const found = projects.find((p) => norm(p.root_path) === norm(item.path))
    rows.push({
      id,
      path: item.path,
      name: basename(item.path),
      branch: await git(item.path, 'branch', '--show-current'),
      head: await git(item.path, 'rev-parse', 'HEAD'),
      commonGitDir: common,
      aliases: [alias].filter(Boolean),
      cbmProject:
        found?.name ||
        item.path
          .replace(/[^a-zA-Z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/-$/, ''),
    })
  }
  writeFileSync(join(data, 'registry.json'), JSON.stringify(rows, null, 2) + '\n')
  console.log(
    JSON.stringify({
      action: 'prepare',
      checkouts: rows.length,
      repositories: new Set(rows.map((r) => r.id)).size,
      registry: join(data, 'registry.json'),
    }),
  )
} else if (process.argv[2] === 'protect') {
  const repos = JSON.parse(readFileSync(join(data, 'registry.json'), 'utf8'))
  const marker = '# BEGIN cortex-local source-only'
  const patterns = [
    marker,
    '# Index code only. Docs/credentials/derived output remain outside the graph.',
    '*.md',
    '*.mdx',
    '*.txt',
    '*.csv',
    '*.tsv',
    '*.json',
    '*.jsonl',
    '*.ndjson',
    '*.yaml',
    '*.yml',
    '*.toml',
    '*.ini',
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    'credentials/',
    'secrets/',
    'vaults/',
    'out/',
    'output/',
    'scratch/',
    'backups/',
    '_backups/',
    'vendor/',
    'third_party/',
    'third-party/',
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    'artifacts/',
    'reports/',
    '*.min.js',
    '# END cortex-local source-only',
    '',
  ].join('\n')
  const backups = join(data, 'ignore-backups')
  mkdirSync(backups, { recursive: true })
  const changes = []
  for (const repo of repos) {
    const target = join(repo.path, '.cbmignore')
    const old = existsSync(target) ? readFileSync(target, 'utf8') : null
    if (old?.includes(marker)) continue
    const backup = join(
      backups,
      createHash('sha256').update(norm(repo.path)).digest('hex').slice(0, 16) + '.json',
    )
    if (existsSync(backup))
      throw new Error('Ignore backup already exists; inspect before overwriting.')
    writeFileSync(backup, JSON.stringify({ target, existed: old !== null, content: old }))
    writeFileSync(target, (old ? (old.endsWith('\n') ? old : old + '\n') : '') + patterns)
    changes.push({ path: target, backup })
  }
  if (changes.length) {
    const receiptPath = join(data, 'ignore-install-receipt.json')
    const previous = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : []
    writeFileSync(receiptPath, JSON.stringify([...previous, ...changes], null, 2) + '\n')
  }
  console.log(JSON.stringify({ action: 'protect', filesAddedOrAppended: changes.length }))
} else if (process.argv[2] === 'index') {
  const repos = JSON.parse(readFileSync(join(data, 'registry.json'), 'utf8'))
  const results = []
  for (const repo of repos) {
    const started = new Date().toISOString()
    console.log(JSON.stringify({ event: 'index-start', repo: repo.path, at: started }))
    try {
      const head = await git(repo.path, 'rev-parse', 'HEAD')
      const branch = await git(repo.path, 'branch', '--show-current')
      if (process.argv.includes('--rebuild')) {
        const known = JSON.parse(await run(cbm, ['cli', 'list_projects', '{}'])).projects
        const old = known.find((p) => p.name === repo.cbmProject)
        if (old && norm(old.root_path) !== norm(repo.path))
          throw new Error('Refusing to replace an index belonging to another root.')
        if (old)
          await run(cbm, ['cli', 'delete_project', JSON.stringify({ project: repo.cbmProject })])
      }
      let result = JSON.parse(
        await run(
          cbm,
          [
            'cli',
            'index_repository',
            JSON.stringify({ repo_path: repo.path, mode: 'fast', persistence: false }),
          ],
          600000,
        ),
      )
      if (result.error || result.isError || ['degraded', 'failed', 'error'].includes(result.status))
        throw new Error(JSON.stringify(result))
      // Source is never staged, stashed, committed, cleaned or copied by this operator.
      const stable =
        head === (await git(repo.path, 'rev-parse', 'HEAD')) &&
        branch === (await git(repo.path, 'branch', '--show-current'))
      const projects = JSON.parse(await run(cbm, ['cli', 'list_projects', '{}'])).projects
      const project = projects.find((p) => norm(p.root_path) === norm(repo.path))
      if (!project) throw new Error('Indexer did not publish a project for this checkout.')
      let schema = JSON.parse(
        await run(cbm, ['cli', 'get_graph_schema', JSON.stringify({ project: project.name })]),
      )
      let documentSections =
        schema.node_labels?.find((label) => label.label === 'Section')?.count || 0
      const artifact = join(repo.path, '.codebase-memory', 'graph.db.zst')
      if (documentSections && existsSync(artifact)) {
        // CBM 0.8.1 can bootstrap an old artifact despite new ignore rules. Preserve
        // its bytes, rebuild this derived cache without that baseline, then restore.
        const saved = artifact + '.cortex-local-held'
        if (existsSync(saved))
          throw new Error('Held artifact already exists; inspect before any move.')
        const before = createHash('sha256').update(readFileSync(artifact)).digest('hex')
        renameSync(artifact, saved)
        try {
          await run(cbm, ['cli', 'delete_project', JSON.stringify({ project: project.name })])
          result = JSON.parse(
            await run(
              cbm,
              [
                'cli',
                'index_repository',
                JSON.stringify({ repo_path: repo.path, mode: 'fast', persistence: false }),
              ],
              600000,
            ),
          )
        } finally {
          renameSync(saved, artifact)
        }
        if (before !== createHash('sha256').update(readFileSync(artifact)).digest('hex'))
          throw new Error('Original artifact preservation check failed.')
        schema = JSON.parse(
          await run(cbm, ['cli', 'get_graph_schema', JSON.stringify({ project: project.name })]),
        )
        documentSections =
          schema.node_labels?.find((label) => label.label === 'Section')?.count || 0
      }
      if (documentSections > 0)
        throw new Error(
          'Source-only filter verification failed: document sections remain in the graph.',
        )
      repo.cbmProject = project.name
      repo.head = head
      repo.branch = branch
      results.push({
        path: repo.path,
        project: project.name,
        status: stable ? 'INDEXED' : 'SOURCE_CHANGED_DURING_INDEX',
        head,
        branch,
        started,
        finished: new Date().toISOString(),
        index: result,
      })
    } catch (error) {
      results.push({
        path: repo.path,
        status: 'FAILED',
        started,
        finished: new Date().toISOString(),
        error: String(error.message || error),
      })
    }
    writeFileSync(join(data, 'registry.json'), JSON.stringify(repos, null, 2) + '\n')
    writeFileSync(
      join(data, 'index-receipt.json'),
      JSON.stringify({ mode: 'fast', persistence: false, results }, null, 2) + '\n',
    )
    console.log(
      JSON.stringify({ event: 'index-finished', repo: repo.path, status: results.at(-1).status }),
    )
  }
  console.log(
    JSON.stringify({
      checkouts: repos.length,
      indexed: results.filter((r) => r.status === 'INDEXED').length,
      failed: results.filter((r) => r.status !== 'INDEXED').length,
      receipt: join(data, 'index-receipt.json'),
    }),
  )
  process.exitCode = results.some((r) => r.status !== 'INDEXED') ? 1 : 0
} else {
  throw new Error('Use prepare, protect or index. No cloud or billing actions are supported.')
}
