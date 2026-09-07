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

---

## 6. Branch, install trial, and the reranker finding — 2026-09-07 (afternoon)

### 6.1 Committed

Branch `lloyd`, cut from `dbfd0b4`. Two commits, on purpose:

| commit | contents |
|---|---|
| `7b4bafe` | every code change in section 1: `src/`, the four test files, CHANGELOG, `package.json`, `bun.lock` |
| `81ce937` | the local CLAUDE.md section, plus `WORKLOG.md` and `GAMEPLAN.md` force-added past upstream's `*.md` ignore |

The split is so the second commit can be dropped when cherry-picking toward
`tobi/qmd`. `git clean -fdx` can no longer delete the notes. Item 0 of the
gameplan is closed.

Verification at `81ce937`: `test:types` clean; full vitest suite under
`CI=true` **1178 passed, 78 skipped, 0 failed** — the `mcp.test.ts` failure in
section 2 did not reproduce with `CI=true`. `npm run build` stamps
`dist/cli/build-info.json` with `81ce937`; `qmd status` from that build reads
the live index in 0.23 s.

### 6.2 Method: two snapshots, two daemons, one box

`VACUUM INTO` two copies of the live index (1.36 s each, 1008 MB):
`lloydfork.sqlite` served by this tree's `dist/` on :8183 with
`QMD_LLM_IDLE_TIMEOUT_MS=0`, and `lloydbase.sqlite` served by the published
2.8.3 on :8184. Same supervisord environment (`scratchpad/launch.sh` mirrors
`agent-qmd-daemon.conf`). The daemons bind `[::1]` only — probe `localhost`,
not `127.0.0.1`.

Bench replicates `_run_vault_search`: twelve collections, one request each,
lex+vec, `limit 20`, `skipRerank: true`, twelve queries lifted from
`eval/vault_recall_queries.yaml`.

### 6.3 Speed

| twelve-collection fan-out, wall (median) | fork | published 2.8.3 |
|---|---|---|
| 1 worker | 229 ms | 10 065 ms |
| 4 workers | **162 ms** | 9 562 ms |
| 8 workers | 165 ms | 9 530 ms |
| 12 workers | 167 ms | 9 519 ms |
| per-request median at 1 worker | 18 ms | 842 ms |
| first request after start | 3.4 s | 5.6 s |

The 2.8.3 column looked slower than section 4's 3.0 s live figure, and I
first put that down to its reranker pool being sized from free VRAM at first
use (25% of free, 1 GB per context, capped at 4) with two daemons sharing
GPU 0. The live daemon then measured 9.3 s itself (6.6), so the snapshot was
representative and section 4 was not. The fork is ~58x on this path — and it
is not reranking those requests at all, which is the whole story; see 6.5.

### 6.4 Parity

Same query set, per collection, both daemons on identical corpora:

| comparison | identical | both empty | different |
|---|---|---|---|
| fork `rerank:false` vs 2.8.3 `rerank:false` | 132 | 12 | **0** |
| 2.8.3 `skipRerank:true` vs 2.8.3 `rerank:false` | 0 | 12 | **132** |

Row one: the in-memory index returns exactly what sqlite-vec returns — same
files, same order, same scores to four places. The twelve empties are `facts`.

Row two is the finding. **Published 2.8.3 reranks every request the lloyd
client sends.** `skipRerank: true` and `rerank: false` return different
result lists on 2.8.3, the former with reranker-shaped scores (0.99, 0.62,
0.52) and the latter with RRF-shaped ones (1.0, 0.5, 0.33). The client has
sent `skipRerank` on every request since it was written; it was never
honoured. This is gameplan item 3, closed: the four-wide ceiling is the
reranker pool's cap of 4, and "rerank made no latency difference" in the
gameplan's caveat was true because the flag changed nothing.

### 6.5 The eval — quality does move, and it is the client's flag

Three arms of `eval/run_eval.py`, corpus held still on the snapshots via
`LLOYD_CONFIG_OVERLAY`, 20 queries, 0 errors in every arm. Note that
`_vault_recall` sends **one** twelve-collection request per question, not the
twelve-way fan-out; that belongs to `vault_search`. The reranker-forced arm is
`scratchpad/run_eval_rerank.py`, which wraps `_qmd_daemon_search` with
`skip_rerank=False` and changes nothing else.

| arm | MRR | NDCG@10 | doc hit | doc recall | avg latency |
|---|---|---|---|---|---|
| 2.8.3, client's `skipRerank` (ignored, so reranked) | 0.484 | 0.590 | 0.95 | 0.625 | 3027 ms |
| fork, `skipRerank` honoured — no rerank | **0.323** | **0.450** | 0.85 | 0.533 | 447 ms |
| fork, rerank on, VRAM-sized pool | 0.484 | 0.590 | 0.95 | 0.625 | 1867 ms |
| fork, rerank on, `QMD_RERANK_PARALLELISM=4` | 0.484 | 0.590 | 0.95 | 0.625 | 1570 ms |
| fork, rerank on, pool 4, `QMD_RERANK_WINDOW_CHARS=600` | 0.463 | 0.550 | 0.95 | 0.625 | 1156 ms |

Rerank-on arms reproduce 2.8.3 **exactly**: 20 of 20 top-10 document lists
identical, every metric identical. That is the acceptance test passed for the
engine. But the arm that matches what the client actually sends loses a third
of MRR, because honouring the flag removes a reranker the client has been
getting for free. The comment at `agent_mcp/vault.py:317` — "the reranker
rarely changes top-1 and shuffles within top-5; not worth the tax" — was
measured against a daemon that ignored the flag. It is wrong by 0.16 MRR.

So **installing the fork unchanged regresses `vault_recall`**, and the fix is
not in this repo: the client must stop sending `skipRerank`, or send
`rerank: true`. With that change the fork gives identical results at 1570 ms
against 3027 ms.

The window is not free: 600 characters costs 0.02 MRR and 0.04 NDCG@10
against whole chunks. Everything else in that row is identical, so it is
the ranking within the top ten that moves, not what is retrieved.

### 6.6 The live daemon, measured once, and the whole picture

One pass against :8181 (eight fan-outs at four workers, six single
requests, the client's own `skipRerank` payload), because the section-4
figure of 3.0 s did not match the 9.5 s the 2.8.3 snapshot daemon showed.
It does not match today either — the live daemon is the slow one:

| what the client sends | twelve-way fan-out, 4 workers | single 12-collection request | `vault_recall` MRR |
|---|---|---|---|
| **live 2.8.3 today** (flag ignored, reranks) | **9 278 ms** | **2 079 ms** | 0.484 |
| fork, `skipRerank` honoured | 162 ms | 90 ms | 0.323 |
| fork, rerank on, pool 4, whole chunks | 7 976 ms | 725 ms | 0.484 |
| fork, rerank on, pool 4, window 600 | 2 861 ms | 339 ms | 0.463 |

Section 4's "3.00 s at four workers" was taken under conditions this pass
did not reproduce — most likely repeated queries hitting the embedding
cache, since the min here was 1.5 s. Treat 9.3 s as the baseline.

Read down the table: the fork with the reranker on and whole chunks is the
only row that keeps quality exactly, and it is 3x faster on the recall path
and roughly level on the fan-out. The window buys a further 2-3x on both
paths for 0.02 MRR. The no-rerank row is the one the client currently asks
for, and it is the one that should not ship.

### 6.7 Housekeeping

`scripts/rerank-configs.sh` in the scratchpad ended its parent shell with a
`pkill -f "port 8183 --index lloydfork"` — the pattern matched the tool
wrapper's own command line, which carried the script text. The chain itself
ran to completion (`### DONE`), and every number above is from a finished
run. Next time match on the pid.

### 6.8 Not done

The daemon still runs published 2.8.3. Nothing in `agent-services/` or
`agent_mcp/` was edited. The snapshot daemons were stopped; `lloydfork.sqlite`
and `lloydbase.sqlite` remain in `~/.cache/qmd/` (1 GB each) for a re-run
and can be deleted. The five eval arms are `eval/baselines/qmdpin-*.json` in
the lloyd repo; the bench and launcher scripts were scratchpad-only.
