# WORKLOG

State of this fork, and how it got here. Companion to `GAMEPLAN.md`, which is
the forward half.

**These two files are local to this clone.** They are not upstream's and should
not go into a PR to `tobi/qmd`. Upstream's `.gitignore` line 11 is `*.md`, so
git does not see them at all: they will not show in `status`, and
`git clean -fdx` will delete them. That is deliberate for notes; see the
warning at the top of `GAMEPLAN.md` for what it means for the code.

Clone: `/home/alansrobotlab/lloyd/qmd`, upstream `main` at `dbfd0b4`
(post-v2.8.3). Read-only reference for the daemon, which runs the **published**
package from bun, not this tree. That distinction is the single most important
fact below: none of the work here is in the running system.

---

## 1. What exists, and who wrote it

Everything in section 1.1 predates 2026-09-07 and is the fork's own work. My
contribution on 2026-09-07 is section 1.2 and is deliberately tiny, because the
thing I set out to add turned out to be worthless. See section 3.

### 1.1 The fork's work in progress

Uncommitted against `dbfd0b4`. About 640 new lines plus 287 changed.

| File | State | What |
|---|---|---|
| `src/vecindex.ts` | new, 351 lines | in-memory exact vector index |
| `src/store.ts` | modified, +178/-50 | wires the index into `searchVec`, chunk-resolution fix |
| `src/llm.ts` | modified | idle timeout, rerank parallelism knobs |
| `src/mcp/server.ts` | modified | `resolveRestRerank`, `rerankWindowChars` on REST |
| `src/index.ts` | modified | SDK surface for the above |
| `test/vecindex.test.ts` | new | 12 tests, index vs sqlite-vec parity |
| `test/daemon-knobs.test.ts` | new | 11 tests, env-knob validation |
| `test/rerank-window.test.ts` | new | 9 tests |
| `test/fts-single-char.test.ts` | new | 3 tests |
| `package.json` | modified | `trustedDependencies` only |

Five changes, in the fork's own words from the CHANGELOG diff:

- **In-memory exact vector index.** sqlite-vec 0.1.9 brute-forces every `MATCH`
  and cannot scope one to a collection, so a collection-filtered search fell
  back to an exact scan at ~76 µs per vector. A twelve-collection query ran
  that scan twelve times, 1.2 s of its 1.3 s on a 21k-chunk index. The store
  now keeps a normalised Float32 copy and scores it in one pass, 12 ms for 21k
  chunks, then takes an exact top-k per collection. Scoping becomes free and
  small collections are never starved (#791, #803, #775). `QMD_VEC_MEMORY_INDEX=0`
  falls back to sqlite-vec; `QMD_VEC_MEMORY_INDEX_MAX_VECTORS` defaults to 200,000.
- **`rerankWindowChars`** (SDK, REST, `QMD_RERANK_WINDOW_CHARS`): how much of
  each candidate the reranker reads. 40 whole 900-token chunks took 1.6 s; 40
  windows of 600 characters took 0.5 s. Default 0 keeps whole chunks.
- **`QMD_RERANK_PARALLELISM`** sizes the reranker context pool outright
  "instead of the VRAM-derived count **capped at 4**".
- **`QMD_LLM_IDLE_TIMEOUT_MS`**: the 5-minute default meant a long-lived daemon
  reloaded the embedding model (2.5 s) and reranker (3 s) on the first query
  after any quiet stretch.
- **REST `/query` accepts `skipRerank: true`** as an alias for `rerank: false`.
  The SDK option is named `skipRerank`, so clients sent it and got the reranker
  they asked to skip, with nothing in the response to say so.

### 1.2 Added 2026-09-07

One test, appended to `test/vecindex.test.ts`: twelve collections give
identical results with the index on and off. The existing parity test stops at
two collections and the real client fans out over twelve.

---

## 2. Verification, 2026-09-07

Run from this clone against the WIP as it stands.

| Check | Result |
|---|---|
| `npm run test:types` | clean |
| the four new test files | 34 passed |
| full vitest suite (`test/`) | 1256 passed, **1 failed** |

**The one failure is upstream's, not the fork's.** `test/mcp.test.ts` has a
stateless `initialize` that expects `content-type: application/json` and gets
`text/event-stream`. I reproduced it on a clean worktree of `dbfd0b4` with all
fork changes absent, so it predates this work. It is unrelated to the vector
path and was not introduced here.

---

## 3. One change tried and reverted

`searchPartitioned` in `vecindex.ts` is written, tested, and called by nothing,
while `searchVec`'s multi-collection branch recurses once per collection. That
reads as a missed optimisation. It is not one.

I wired the partition into the recursion and benchmarked it against a copy of
the live 21k-vector index:

| | 12-collection `searchVec` |
|---|---|
| with the change | 27.2 ms |
| without | 27.6 ms |

Noise. The reason is four lines above `searchPartitioned`: `scores()` memoises
on the query vector, keyed on generation and dataVersion, so the twelve
recursions already share one pass. The dead function is *equivalent* to the
recursion, not faster than it.

`src/store.ts` was restored byte-for-byte. The finding is recorded in a comment
on the test that survived, so the next person does not spend the same hour.

**The open question this leaves:** `searchPartitioned` is either worth deleting
or worth using for clarity, but it is not a performance gap. Decide, do not
re-measure.

---

## 4. Measurements against the RUNNING daemon (published 2.8.3, no fork work)

Taken 2026-09-06/07 while investigating why qmd was loading the box. These
describe the system as it is today, which is the baseline the fork improves on.

- **qmd is GPU-accelerated.** 3.6 GB resident on GPU 0, utilisation spiking to
  93% during a vector leg. An earlier note of mine claimed it was CPU-only;
  that came from piping `nvidia-smi --query-compute-apps` through `head`, and
  qmd is entry fourteen of nineteen. Corrected here so it is not repeated.
- **Per request:** 305 ms warm, 734 ms cold, about 1 CPU-second.
- **First request after an idle stretch: 3.7 s**, which is the embedding model
  loading onto the GPU. This is exactly the `QMD_LLM_IDLE_TIMEOUT_MS` item.
- **Concurrency saturates at four.** Twelve collection-scoped requests: 10.79 s
  at one worker, 3.00 s at four, 3.01 s at eight, 3.08 s at twelve. Beyond four,
  per-request latency rises in proportion while wall time stays flat.
- `UV_THREADPOOL_SIZE=16`: no change. `QMD_EMBED_PARALLELISM=8`: no change.
  Lex-only shows the same four-wide ceiling despite involving no embedding, so
  it is not the embedding pool. **The ceiling is not yet identified.** See the
  gameplan for the leading hypothesis.
- **Lex is not a target:** ~7.5 ms per request, parallelises fine.
- **One request for all collections vs the twelve-way fan-out:** 3.6 s vs
  10.8 s, but 40 documents vs 213, and the 40 are a strict subset. The fan-out
  is buying real recall.

### Index cleanup, 2026-09-07

`qmd status` reported 67% of embedding chunks orphaned. Published 2.8.3
brute-forces every stored vector, so two thirds of every scan was waste.

| | before | after |
|---|---|---|
| vectors | 63,714 | 21,029 |
| index size | 1001 MB | 961 MB |

Took 15 s with the daemon running. A pre-cleanup backup is at
`~/.cache/qmd/index.backup-20260907_100044.sqlite` (998 MB), deletable once
you are satisfied. Orphans were back to 2% within the hour, so this wants a
schedule rather than a one-off.

---

## 5. How the client uses this

The consumer is `agent_mcp/vault.py` in the lloyd repo.

- `VAULT_SEGMENTS` is twelve collections, fanned out one request each,
  `max_workers=4`. That cap matches the measured ceiling; raising it buys
  nothing.
- The `facts` collection points at `~/obsidian/facts`, which **exists and is
  empty**. The real fact tree is `_pipeline/vault-derived/facts` in the lloyd
  repo, 23,604 entity dirs, and is not indexed. So one of every twelve requests
  is a round trip to an empty collection.
- The live index actually holds thirteen collections, including `autonomy-runs`
  and `subliminal`, which `VAULT_SEGMENTS` does not name.
- lloyd now has a pinned-corpus eval harness (`scripts/selfmod/evalpin.py`)
  that freezes both the qmd index and the grep corpus, so a retrieval change
  can be measured as a before-and-after rather than argued about.
