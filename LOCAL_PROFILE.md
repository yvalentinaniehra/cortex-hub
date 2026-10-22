# V-TIP local profile — Cortex + existing CBM

This is a local adaptation of Cortex Hub 1.3.1 at 0a6ef4a716907453ce41a89592f22853c2cdea2c, not the upstream Docker release. Authorization: owner selected the route without GitNexus/license fees on 22 October 2026.

## Architecture and boundaries

- Reuses the upstream Cortex memory/knowledge MCP schemas and formatting. A small in-process backend replaces their HTTP calls only in the explicit local entry point.
- Local SQLite WAL + FTS5/BM25 stores explicit technical knowledge and session summaries. Vietnamese accent folding is supported. It is keyword search, **not semantic embedding search**, and does not run mem9 fact extraction/consolidation.
- Existing `codebase-memory-mcp` 0.8.1 provides source graph/search/trace/snippets. Cortex's optional code search adapter calls that executable; no GitNexus is installed, spawned, imported or contacted by this profile.
- STDIO transport: Codex starts the process for a connection; SQLite and existing CBM indexes persist across processes. No Docker, listening network port, cloud model, API token, scheduled task or auto-updater is needed.
- Scope is the explicit registry. No global cross-project memory fallback. Unknown/missing scope fails visibly. Worktree paths are preserved; shared Git repositories have the same project ID but distinct checkout graph names.
- No mass document import, historical-chat ingestion, business-data migration or production action. Memory deletion is unavailable. Do not store credentials or restricted source documents.
- Upstream dashboard, Conductor worker scheduling, quality enforcement hooks and vector retrieval are **not deployed** by this local profile. The standard upstream files are retained as source, not running services.
- No token/credit/quota savings are fabricated. The profile reports observed operation counts and zero external model calls; measure actual Codex usage separately.

## License provenance

Cortex source remains under the root MIT LICENSE. CBM is separately MIT (https://github.com/DeusData/codebase-memory-mcp/blob/main/LICENSE), installed locally at 0.8.1. Runtime SDK/Zod packages are those pinned by upstream pnpm-lock.yaml. The Noncommercial GitNexus dependency in upstream Dockerfile is not part of this profile's runtime. This is not a claim that every optional component/image in the retained upstream repository has been license-audited.

## Operator commands

Run from this repository with Node 22.20+:

```powershell
node scripts/local-profile-operator.mjs prepare
node scripts/local-profile-operator.mjs protect
node scripts/local-profile-operator.mjs index --rebuild
```

Data: `%USERPROFILE%/.codex/data/cortex-local/`. `registry.json` maps allowed checkouts; `context.sqlite` persists context; `index-receipt.json` records per-checkout results. Indexing is serial, fast mode, no source artifact export. `protect` adds a marked `.cbmignore` block to each approved checkout and records original bytes separately for rollback; it excludes document/config-data formats, vaults, credentials and generated output. Existing ignore rules are retained. Fast mode has coverage exclusions; inspect index status and use literal searches/direct source reads when needed.

Native entry point after build: `apps/hub-mcp/dist/local-profile/stdio.js`. Install it in the user Codex MCP configuration, preserving existing servers. Do not run the upstream installer or docker-compose for this profile.

Use `--rebuild` for initial filtered indexes or after changing ignore rules: CBM 0.8.1 can otherwise serve the old cache. Only the registered derived cache is replaced. If an existing source artifact bootstraps excluded Markdown, the operator temporarily holds that one artifact file, builds a filtered local cache, restores the artifact in `finally`, and checks its SHA256 is unchanged. Product source is not moved or deleted.

Installed connection: `[mcp_servers.cortex-local]` in the user Codex config, with nine enabled tools. Existing CBM remains the code engine; duplicate Cortex code-search aliases and unsupported/deletion tools are not exposed in that client configuration. Global guidance is appended as a marked block to user AGENTS.md, with a private local backup recorded in the install receipt. Existing open chats may need a new MCP connection to load the new server.

## Daily workflow

1. Start a session with the checkout path and retain sessionId/projectId.
2. Recall narrowly relevant knowledge/memory once; use returned projectId and current branch.
3. Use existing CBM for source discovery; do not repeat an identical lookup in both servers. Read the actual relevant source and verify current Git state before editing.
4. Save reusable technical conclusions with file/SHA/evidence when authorized. Close the session with a concise technical summary. A stored summary never proves CI, staging, production or real-user acceptance.
5. Refresh an index after source/branch changes. Do not assume a CLI-indexed repo is watched. The saved registry SHA is a snapshot, not an automatic freshness guarantee.

## Rollback

Remove only `[mcp_servers.cortex-local]` and the marked local-profile block added to the user AGENTS.md, using the backups produced during installation. Keep SQLite/index data unless the owner asks for deletion. Existing CBM configuration is independent and is not disabled by the installation.
