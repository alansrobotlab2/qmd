<!-- ─────────────────────────────────────────────────────────────────────
LOCAL FORK SECTION — added 2026-09-07, not upstream's.
`git checkout CLAUDE.md` removes it. Strip it before any PR to tobi/qmd.
────────────────────────────────────────────────────────────────────── -->

# This clone: Lloyd's retrieval backend

You are in `/home/alansrobotlab/lloyd/qmd`, a clone of `tobi/qmd` kept inside
the Lloyd repo. Upstream's own guidance follows the local section below and is
still the authority on qmd's commands and concepts.

**Read `WORKLOG.md` and `GAMEPLAN.md` first.** They carry the state of the fork,
the measurements behind every open decision, and the ordered next steps. This
file is orientation only.

## The one fact that catches everyone

**The running daemon is this tree's `dist/`, not `src/`.** Since 2026-09-07
`agent-qmd-daemon` under supervisord runs:

```
node /home/alansrobotlab/lloyd/qmd/dist/cli/qmd.js mcp --http --port 8181
```

with `QMD_LLM_IDLE_TIMEOUT_MS=0` and `QMD_RERANK_PARALLELISM=4` in its
environment (`agent-services/supervisor/conf.d/agent-qmd-daemon.conf`). So a
change in `src/` is inert until you `npm run build` **and** restart the
program:

```bash
npm run build && cat dist/cli/build-info.json     # commit stamp; "-dirty" if uncommitted
/home/alansrobotlab/.local/share/uv/tools/supervisor/bin/supervisorctl \
  -c /home/alansrobotlab/lloyd/agent-services/supervisor/supervisord.conf restart agent-qmd-daemon
```

Editing `src/` and then measuring the daemon measures the previous build.
`qmd --version` from `dist/` prints the commit the build came from.

The published 2.8.3 package is still installed at
`~/.bun/install/global/node_modules/@tobilu/qmd/` and `~/.bun/bin/qmd` still
points at it — that is what `agent-qmd-watcher` uses for `update`/`embed`,
and it is the revert: swap the `command=` line back and restart. The two
share the index file; the daemon reloads its in-memory vector index on the
next search after any write from another process (~0.5 s).

**The client sends `rerank: true` on purpose.** `agent_mcp/vault.py` used to
send `skipRerank: true`, which 2.8.3 ignored and this fork honours; honouring
it costs 0.16 MRR on `vault_recall` (WORKLOG section 6). Do not "optimise"
that flag back off without re-running the pinned eval.

## Why Lloyd depends on it

qmd is the document half of Lloyd's memory. `agent_mcp/vault.py` in the parent
repo calls `POST http://localhost:8181/query` with a lex leg and a vec leg, and
merges the results with a knowledge-graph pass and a source-code grep. If qmd
is slow or wrong, `vault_recall` is slow or wrong, and that is on the hot path
of most agent turns.

The client fans one question out to **twelve collections, one request each,
four at a time** (`VAULT_SEGMENTS`, `max_workers=4`). Twelve requests per
question, so a twenty-question eval is 240 requests.

## Relationship to the Obsidian vault

The vault is `~/obsidian`. Collections are configured in
`~/.config/qmd/index.yml`; the index itself is one SQLite file at
`~/.cache/qmd/index.sqlite`. Live document counts as of 2026-09-07:

| collection | path | docs | queried by Lloyd? |
|---|---|---|---|
| `subliminal` | `~/obsidian` (all, minus agents/templates) | 4015 | no |
| `autonomy-runs` | `~/lloyd/autonomy-runs` (`*/run_*.md`) | 3763 | no |
| `knowledge` | `~/obsidian/knowledge` | 2465 | yes |
| `memory` | `~/obsidian/memory` | 571 | yes |
| `backlog` | `~/obsidian/backlog` | 338 | yes |
| `skills` | `~/obsidian/skills` | 240 | yes |
| `projects` | `~/obsidian/projects` | 175 | yes |
| `work`, `architecture`, `autonomy`, `people`, `personal`, `lloyd` | under `~/obsidian` | 208 total | yes |
| `facts` | `~/obsidian/facts` | **0** | yes |
| `sessions` | `~/obsidian/sessions` | **0** | no |

Three things in that table are worth knowing before you touch anything:

- **`facts` is empty and Lloyd queries it anyway.** The directory exists and
  holds nothing. The real fact tree is `~/lloyd/_pipeline/vault-derived/facts`,
  23,604 entity dirs, and it is *not* indexed here. Facts reach retrieval
  through the knowledge-graph layer instead, not through qmd. So one of every
  twelve requests is a round trip for nothing. See `GAMEPLAN.md` item 4.
- **`subliminal` is the whole vault again.** Its path is `~/obsidian` itself,
  so nearly every file indexed under a topic collection is indexed a second
  time here. 4,015 docs against roughly 3,997 for all the topic collections
  combined. Whether that duplication is deliberate is an open question; it is
  not something to "clean up" without finding out why it exists.
- **Two thirds of the index is invisible to Lloyd's fan-out.** `subliminal`
  and `autonomy-runs` are 7,778 of 11,775 documents and are not in
  `VAULT_SEGMENTS`. For `subliminal` that is harmless duplication; for
  `autonomy-runs` it is 3,763 genuinely unique documents the agent cannot
  reach by this path.

Not everything indexed is in the vault: `autonomy-runs` points into the Lloyd
repo. Do not assume "collection" means "vault subdirectory".

## Working here

```bash
npm run test:types                  # tsc --noEmit
node ./node_modules/vitest/vitest.mjs run test/          # full suite
node ./node_modules/vitest/vitest.mjs run test/vecindex.test.ts
npm run build                       # then install to make it live
```

The suite has **one known failure** in `test/mcp.test.ts`, reproduced on clean
upstream `dbfd0b4`. It is not yours. Everything else should be green.

**Be careful with the live daemon.** It is shared with a running assistant and
it embeds on the GPU while spending real CPU. One eval run is 82 s and 128 s of
qmd CPU. Benchmarking in a loop against port 8181 slows Lloyd's actual
retrieval for as long as it runs. To measure without touching production,
snapshot the index and serve it on another port:

```bash
# VACUUM INTO a copy (1.5 s for 1 GB), then:
qmd mcp --http --port 8183 --index <snapshot-name>
```

`scripts/selfmod/evalpin.py` in the parent repo does exactly this and can be
read as a worked example.

<!-- ── end local fork section; upstream's CLAUDE.md follows ── -->

# QMD - Query Markup Documents

Use Bun instead of Node.js (`bun` not `node`, `bun install` not `npm install`).

## Commands

```sh
qmd collection add . --name <n>   # Create/index collection
qmd collection list               # List all collections with details
qmd collection remove <name>      # Remove a collection by name
qmd collection rename <old> <new> # Rename a collection
qmd init                          # Create a project-local .qmd index
qmd ls [collection[/path]]        # List collections or files in a collection
qmd context add [path] "text"     # Add context for path (defaults to current dir)
qmd context list                  # List all contexts
qmd context check                 # Check for collections/paths missing context
qmd context rm <path>             # Remove context
qmd get <file>[:from[:count]]     # Get by path or docid (#abc123); optional line range
qmd multi-get <pattern>           # Get multiple docs by glob or comma-separated list
qmd status                        # Show index status and collections
qmd doctor                        # Diagnose config, index, model, and device issues
qmd update                        # Re-index collections; configured update hooks run first
qmd trust [list|revoke]           # Approve a checked-in .qmd config's hooks/paths/models
qmd embed                         # Generate vector embeddings (uses node-llama-cpp)
qmd query <query>                 # Search with query expansion + reranking (recommended)
qmd search <query>                # Full-text keyword search (BM25, no LLM)
qmd vsearch <query>               # Vector similarity search (no reranking)
qmd bench <fixture.json>          # Run search-quality benchmarks
qmd mcp                           # Start MCP server (stdio transport)
qmd mcp --http [--port N]         # Start MCP server (HTTP, default port 8181)
qmd mcp --http --daemon           # Start as background daemon
qmd mcp stop                      # Stop background MCP daemon
```

## Collection Management

```sh
# List all collections
qmd collection list

# Create a collection with explicit name
qmd collection add ~/Documents/notes --name mynotes --mask '**/*.md'

# Remove a collection
qmd collection remove mynotes

# Rename a collection
qmd collection rename mynotes my-notes

# Show collection details
qmd collection show mynotes

# Set or clear the pre-update hook (runs before re-indexing on `qmd update`)
qmd collection update-cmd mynotes 'git pull --ff-only'
qmd collection update-cmd mynotes            # clear

# Include or exclude from default (unscoped) queries
qmd collection exclude mynotes
qmd collection include mynotes

# List all files in a collection
qmd ls mynotes

# List files with a path prefix
qmd ls journals/2025
qmd ls qmd://journals/2025
```

## Context Management

```sh
# Add context to current directory (auto-detects collection)
qmd context add "Description of these files"

# Add context to a specific path
qmd context add /subfolder "Description for subfolder"

# Add global context to all collections (system message)
qmd context add / "Always include this context"

# Add context using virtual paths
qmd context add qmd://journals/ "Context for entire journals collection"
qmd context add qmd://journals/2024 "Journal entries from 2024"

# List all contexts
qmd context list

# Check for collections or paths without context
qmd context check

# Remove context
qmd context rm qmd://journals/2024
qmd context rm /  # Remove global context
```

## Document IDs (docid)

Each document has a unique short ID (docid) - the first 6 characters of its content hash.
Docids are shown in search results as `#abc123` and can be used with `get` and `multi-get`:

```sh
# Search returns docid in results
qmd search "query" --json
# Output: [{"docid": "#abc123", "score": 0.85, "file": "docs/readme.md", ...}]

# Get document by docid
qmd get "#abc123"
qmd get abc123              # Leading # is optional

# Docids also work in multi-get comma-separated lists
qmd multi-get "#abc123, #def456"
```

## Options

```sh
# Search & retrieval
-c, --collection <name>  # Restrict search to collection(s) (repeatable)
-n <num>                 # Number of results
--all                    # Return all matches
--min-score <num>        # Minimum score threshold
--full                   # Show full document content
--intent <text>          # Describe what you're after to sharpen ranking (query)
--no-rerank              # Skip LLM reranking (faster, lower quality)
--full-path              # Show on-disk paths instead of qmd:// URIs

# Get / multi-get
-l <num>                 # Maximum lines per file
--max-bytes <num>        # Skip files larger than this (default 10KB)
--no-line-numbers        # Disable line numbers (on by default for get/multi-get)

# Output format (search, query, multi-get)
--format <kind>          # cli (default) | json | csv | md | xml | files
                         # legacy --json/--csv/--md/--xml/--files still work as aliases
```

## Development

```sh
bun src/cli/qmd.ts <command>   # Run from source
bun link               # Install globally as 'qmd'
```

## Tests

All tests live in `test/`. Run everything:

```sh
npx vitest run --reporter=verbose test/
bun test --preload ./src/test-preload.ts test/
```

## Architecture

- SQLite FTS5 for full-text search (BM25)
- sqlite-vec for vector similarity search
- node-llama-cpp for embeddings (embeddinggemma), reranking (qwen3-reranker), and query expansion (Qwen3)
- Reciprocal Rank Fusion (RRF) for combining results
- Smart chunking: 900 tokens/chunk with 15% overlap, prefers markdown headings as boundaries
- AST-aware chunking: use `--chunk-strategy auto` to chunk code files (.ts/.js/.py/.go/.rs) at function/class/import boundaries via tree-sitter. Default is `regex` (existing behavior). Markdown and unknown file types always use regex chunking.

## Important: Do NOT run automatically

- Never run `qmd collection add`, `qmd embed`, or `qmd update` automatically
- Never modify the SQLite database directly
- Write out example commands for the user to run manually
- Index is stored at `~/.cache/qmd/index.sqlite`

## Do NOT compile

- Never run `bun build --compile` - it overwrites the shell wrapper and breaks sqlite-vec
- The `qmd` file is a shell script that runs compiled JS from `dist/` - do not replace it
- `npm run build` compiles TypeScript to `dist/` via `tsc -p tsconfig.build.json`

## Releasing

Use `/release <version>` to cut a release. Full changelog standards,
release workflow, and git hook setup are documented in the
[release skill](skills/release/SKILL.md).

Key points:
- Add changelog entries under `## [Unreleased]` **as you make changes**
- The release script renames `[Unreleased]` → `[X.Y.Z] - date` at release time
- Credit external PRs with `#NNN (thanks @username)`
- GitHub releases roll up the full minor series (e.g. 1.2.0 through 1.2.3)
