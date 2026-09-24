# WORKLOG

State of this fork, and how it got here. Companion to `GAMEPLAN.md`, which is
the forward half.

**These two files are local to this clone.** They are not upstream's and should
not go into a PR to `tobi/qmd`. Upstream's `.gitignore` line 11 is `*.md`, so
git does not see them at all: they will not show in `status`, and
`git clean -fdx` will delete them. That is deliberate for notes; see the
warning at the top of `GAMEPLAN.md` for what it means for the code.

Clone: `/home/alansrobotlab/lloyd/qmd`, upstream `main` at `dbfd0b4`
(post-v2.8.3), branch `lloyd`. Sections 1–5 were written while the daemon ran
the **published** package and none of this work was live; section 6.8 is where
that flipped. The daemon now runs this tree's `dist/`.

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

### 6.8 Installed — 2026-09-07, ~18:00

Everything above was the trial. On the go-ahead, three edits in the lloyd
repo and two restarts:

- `agent_mcp/vault.py`: `RECALL_QMD_RERANK = True`, the shared
  `_qmd_daemon_search` default flipped to rerank-on, the request now carries
  an explicit `rerank` boolean (the key every qmd version reads) instead of
  `skipRerank`, and the HTTP-500 fallback retries with `rerank: false`.
  `prefetch.py` keeps its explicit skip — its own comment says "explicit
  vault_recall calls keep rerank on", which was the original design before
  the shared default drifted. 60 vault/prefetch/qmd tests pass.
- `agent-services/supervisor/conf.d/agent-qmd-daemon.conf`: `command=` now
  this tree's `dist/cli/qmd.js` (built at `81ce937`), plus
  `QMD_LLM_IDLE_TIMEOUT_MS="0"` and `QMD_RERANK_PARALLELISM="4"`. Whole-chunk
  reranking; the 600-character window is documented in the conf as the next
  knob, not applied, because it moves MRR by 0.02.
- `.gitignore`'s note about `/qmd/` said the daemon never runs this tree.
  Corrected.

`supervisorctl reread && update` restarted `agent-qmd-daemon` — **and the
whole `lloyd-mc` group**, because `lloyd-mc.conf` had been committed on
2026-09-06 after supervisord last read it and nobody had run `update` since.
Backend, frontend and aggregator came back clean (dashboard error-free,
130 tools, 0 degraded); nothing was in flight at the time. `reread` prints
what `update` will touch — read it before running `update`.

Verified on the live daemon: the client's default request returns
reranker-shaped scores (0.88, 0.62, …) and an explicit skip returns
RRF-shaped ones (1.0, 0.5, 0.33), so both paths do what they say for the
first time. First live eval after the move: **MRR 0.484, NDCG@10 0.590,
doc hit 0.95, doc recall 0.62, 0 errors, 1667 ms average** — every quality
metric identical to the pinned 2.8.3 arm, on the live corpus rather than
the snapshot, at 55% of the latency (3027 ms). That is the acceptance test
in the gameplan, passed.

The snapshots `lloydfork.sqlite` and `lloydbase.sqlite` remain in
`~/.cache/qmd/` (1 GB each) and can be deleted. The six eval arms are
`eval/baselines/qmdpin-*.json` and `fork-live-first-*.json` in the lloyd
repo. Bench and launcher scripts were scratchpad-only; the method is in 6.2.

### 6.9 The rerank window, decided — 2026-09-07, ~19:15

Four arms on the `lloydfork` snapshot (after `qmd cleanup`, 3% orphans
removed — results are unchanged by that, and every arm ran on the same
file), rerank on as the client now sends it, pool 4. Eval = the 20-query
`vault_recall` set; fan-out = twelve requests at four workers; single = one
request over the client's collections.

| `QMD_RERANK_WINDOW_CHARS` | MRR | NDCG@10 | doc hit / recall | eval avg | fan-out | single |
|---|---|---|---|---|---|---|
| 0 (whole chunk) | 0.484 | 0.590 | 0.95 / 0.62 | 1848 ms | 7865 ms | 725 ms |
| 600 | 0.463 | 0.550 | 0.95 / 0.62 | 1150 ms | 2873 ms | 339 ms |
| **1200** | **0.504** | **0.592** | 0.95 / 0.62 | **1338 ms** | **4234 ms** | **432 ms** |
| 2400 | 0.528 | 0.578 | 0.95 / 0.62 | 1610 ms | 6468 ms | — |

The eval is deterministic on a pinned corpus: the 600 arm reproduced its
earlier 0.463/0.550 to three places. Reading across, 600 is the only size
that loses, and the differences among 0/1200/2400 are inside the n=20
noise that `vault.py`'s own header puts at 0.02. So the decision is not
"which is best" — they are tied — but "which tie is fastest": **1200**,
deployed in `agent-qmd-daemon.conf`, halves the reranked fan-out and takes
40% off the single request with no metric below whole-chunk. Unset the
variable to go back.

### 6.10 The rest of the gameplan, closed the same afternoon

- **Item 2, cleanup schedule.** `lloyd-qmd-cleanup.timer` (tracked in
  `agent-services/systemd/`, symlinked like the guardian units, enabled)
  runs the fork's `qmd cleanup` at 04:45 daily. Measured on the snapshot:
  6.9 s at 3% orphans, VACUUM and FTS compaction included.
- **Item 4, the empty `facts` collection.** The safe half: `facts` is out
  of `VAULT_SEGMENTS` with a comment saying why. Indexing the real fact
  tree stays a separate, measurable decision. (`prefetch.py` keeps its own
  list, which includes the equally empty `sessions`; not touched.)
- **Item 5, `searchPartitioned`.** Deleted (`a7b5425`); the finding lives
  on the twelve-collection parity test.
- **Item 6, the MCP test.** Two different failures hide under
  `skipIf(CI)`. The stateless `initialize` one is a stale assertion: the
  SDK's legacy fallback answers as a single SSE event (verified with a raw
  POST — 200, correct result, and a 406 if the client will not accept SSE),
  so the test now accepts either framing and unwraps `data:`. The other,
  "expands query with typed variations", is this box: GPU 0 now holds the
  daemon's resident models plus TTS, and the expansion model cannot get a
  2048 context. **Run the suite with `CUDA_VISIBLE_DEVICES=0`** — without
  it node-llama-cpp picked GPU 2, where the secondary model sits at 21.4 of
  24 GB, and tried to allocate there. Under `CI=true` (what upstream runs)
  the suite is 1178 passed, 78 skipped, 0 failed at `a7b5425`.
- **Item 7, upstreaming.** Branch `upstream-vecindex` = `dbfd0b4` plus
  the two code commits cherry-picked, nothing local (CLAUDE.md untouched,
  no notes). Types clean, full suite green in CI mode. **Not pushed and no PR
  opened** — that publishes, and it is a one-line decision for the human:
  `git push -u origin upstream-vecindex`, then a PR from
  `alansrobotlab2:upstream-vecindex` to `tobi:main` with the text in 6.11.

Housekeeping: the two snapshots are deleted; the worktree is removed and
only the branch remains. Lloyd's side is committed on its `main`
(`91a59f9` plus the window follow-up), and `SETUP.md` Part 0/6/11 now
describe the two installs, the deploy loop and the timer.

One unintended action, recorded so it is not a mystery in the logs: while
writing this section an unquoted shell heredoc let bash execute the
backticked phrase `qmd cleanup`, which ran a real cleanup on the live index
through the published CLI at ~19:20 (80 cached responses cleared, orphans
removed, VACUUM). It is the operation the timer runs nightly and the index
and daemon were verified healthy afterwards, but it was not meant to run
then.

## 7. Latency anatomy, incremental index refresh, and a rerank that says when it did not run — 2026-09-19

Measured on the live index (15,778 documents, 37k vectors), fresh never-seen
queries, production's request shape (lex+vec, eleven collections, pool 240):

| | ms |
|---|---|
| fts (11 collections) | 50–200 |
| embed the query | 5–30 |
| vec (11 collections, in-memory) | 60–90 |
| chunk 240 candidates at query time | 35–95 |
| **rerank 240 rows** | **3,800–4,200** |

**7.1 The cross-encoder is compute-bound on the 3090.** `QMD_RERANK_PARALLELISM`
4 → 8 → 16 at `QMD_RERANK_CONTEXT_SIZE=1024`: 4,030 / 3,976 / 4,161 ms, against
4,232 ms for production's 4 × 4096. node-llama-cpp's `rankAll` scores one
document at a time per context under a lock, and four of those already keep the
card busy (~56 documents/s). More contexts cost VRAM (8.1 GB at sixteen) and buy
nothing. The cost of a rerank is rows × window tokens; only fewer rows, a
smaller model or a faster GPU move it. Context size does not change speed:
1024 saves 1.4 GB, and 2048 is the largest size at which a 1200-char window can
never be truncated (2048 − 512 template − query > 1200 tokens).

**7.2 Any commit from another connection cost the next query a full index
rebuild.** `PRAGMA data_version` moves on every foreign commit — a `qmd update`
that found nothing, included — and a reload read every vector back: 775 ms of
blobs, 124 ms normalising, 44 ms memberships. Measured on the daemon: vec-only
110 ms warm, 982 ms for the first query after a no-op `update`. `VecIndex` now
refreshes instead: an aggregate fingerprint over `content_vectors` and the
active `documents` (~8 ms) skips the work when nothing the index holds moved,
and otherwise only new or re-stamped keys are read (0.06 ms each) and the
memberships re-partitioned; above 25% churn, or with a loader that lacks the
cheap paths, it rebuilds as before. After: 244 ms for the first query after a
foreign commit, refresh 10 ms. The pinned property is equality with a fresh
build (`test/vecindex.test.ts`).

**7.3 A rerank that could not run reported success.** With no VRAM for a
ranking context the LLM layer scores everything 0.5, `model: "fallback"`; the
REST caller got HTTP 200 and an ordinary list, and `rerank()` wrote each 0.5
into the score cache, pinning those (query, chunk) pairs at "no opinion" after
the pressure had passed. Now: fallbacks are not cached, `SearchHooks` gained
`onRerankFallback` and `onPhase`, REST `/query` returns
`meta: { reranked, rerankFallback, ms, phases }` and logs the phases, and
`/health` carries `rerank` counters and `vecIndex` stats. Reproduced by
pointing a daemon at a GPU with 3.1 GB free (`test/rerank-fallback.test.ts`
pins it without a GPU; two of its three tests fail on the old `rerank()`).

**7.4 Global fusion (opt-in; the default is unchanged).** `structuredSearch`
hands RRF one list per search per collection, and RRF reads ranks only: every
collection's #1 ties with every other's, so a document ranked fifth in the one
relevant collection lands near fused position 50 of an eleven-collection
request. That is why Lloyd widened `candidateLimit` 40 -> 240 (#504), and why a
recall costs 4 s. `fusion: "global"` (SDK, REST) runs each search ONCE across
the named collections and merges by score — BM25 and cosine are comparable
inside one index — via `searchFTSAcross` (one FTS pass, no bodies; the
per-collection path ran the same global BM25 query eleven times and loaded up
to 220 documents, the 50-200 ms `fts` phase) and `searchVecAcross`
(`VecIndex.search` over the union of the collections' rows). `lexWeight` and
`collectionFloor` (each collection's best N per search appended to the
candidates, not fused) are the two knobs. Pinned eval, Lloyd's 20 queries, full
`_vault_recall`, rerank on, rerank cache cleared per arm:

| fusion | pool | floor | doc_hit | doc_recall | MRR | NDCG@10 |
|---|---|---|---|---|---|---|
| collection (production) | 240 | - | 1.00 | 0.610 | 0.497 | 0.582 |
| collection | 40 | - | 0.80 | 0.525 | 0.477 | 0.515 |
| global | 40 | - | 0.95 | 0.558 | 0.512 | 0.588 |
| global, lexWeight 2 | 40 | - | 0.95 | 0.533 | 0.543 | 0.587 |
| global | 60 | 1 | 0.95 | 0.558 | 0.535 | 0.595 |
| global | 80 | - | 0.95 | 0.558 | 0.539 | 0.601 |
| global | 40 | 5 | 1.00 | 0.578 | 0.502 | 0.572 |
| global | 240 | - | 0.85 | 0.508 | 0.518 | 0.589 |

Quiet-GPU recall latency: ~1.3 s at pool 40 against ~4.7 s for production.
Ranking is better at a sixth of the rerank rows; what is lost is four expected
documents, ALL `autonomy/NN-*.md` task files, which rank 30-227 fused
per-collection and 116-352 globally — they are poor lexical and semantic
matches for a natural question (front matter plus an activity log), and
production reaches them only by cross-encoding everything, 1 of 5 at rank 14. A
floor deep enough to recover the hit (5) gives the MRR gain back. That gap is an
indexing problem for that collection, not a fusion one. n=20: read 0.02 as noise.

`collectionFloor` also takes a map, because the collection that needs a floor
is one of eleven and a blanket 5 adds ~60 rows of everybody else's:

| fusion | pool | floor | doc_hit | doc_recall | MRR | NDCG@10 |
|---|---|---|---|---|---|---|
| global | 40 | autonomy=5 | 1.00 | 0.578 | 0.532 | 0.603 |
| global | 60 | autonomy=5 | 1.00 | 0.578 | 0.546 | 0.602 |
| global | 40 | autonomy=8 | 1.00 | 0.578 | 0.531 | 0.602 |

Hit rate at parity with production, MRR +0.035, NDCG@10 +0.021, doc_recall
-0.03, ~45 rows reranked instead of 240. Lloyd deployed the first row. The floor
was picked by reading this eval's misses; the durable fix is on Lloyd's side
(make task files retrievable), after which it can go.

## 8. An OR'd keyword leg, and a pending-hint that read the wrong model — 2026-09-21

Two fork commits, both on branch `lloyd` and served since that evening.

**`fa71e57` — `lexMode: "or"`.** A natural-language question under the default
AND matches only documents holding every one of its words, so the lex leg
found almost nothing for the questions Lloyd actually asks. On Lloyd's 87-query
recall eval the lex leg alone had an expected document within its top 32 for
**11%** of queries under AND against **36%** under OR, and within its top 240
for **13%** against **54%**. End to end the recall gained doc_recall **+0.033**,
MRR **+0.028**, NDCG **+0.042** at unchanged latency (+16 ms). The mode is opt-in
on `StructuredSearchOptions`, the SDK options and REST `/query`, and **AND stays
the default** for every existing caller; a negation binds to the whole
disjunction, and both lex paths (global and per-collection) take the mode. Lloyd
sends it from the recall doc leg only (`RECALL_LEX_MODE` in
`agent_mcp/vault.py`). The measurements, kept and rejected, are in Lloyd's
`architecture/retrieval.md`.

**`db52729` — `update` counts pending against the configured model.** `update`
printed its "N unique hashes need vectors" hint from
`getHashesNeedingEmbedding(db)`, i.e. against the built-in default model, while
`embed` and `status` use the configured one. After Lloyd switched to
Qwen3-Embedding-0.6B on 2026-09-21, every hash of a fully embedded index read as
unembedded — all 10,745 of them, on every watcher cycle. Both hint sites now
pass `resolveEmbedModelForCli()`.

## 9. A re-index no longer empties the rerank cache — 2026-09-24 (Lloyd #1366)

Upstream clears `llm_cache` as the first step of every re-index, in three
places: `updateCollections()` in the CLI (`qmd update`, which is what
`qmd-watcher.sh` runs every cycle), `indexFiles()` (`qmd collection add`), and
the SDK `update()` (`src/index.ts`). All three came in with upstream `839d774`
under a "Clear Ollama cache" comment that predates content-addressed keys. On
Lloyd's box it meant a rerank score lived exactly one watcher cycle (median
142 s): one fresh query filled the table 0 → 78 rows and the next `qmd update`
took it 78 → 0, so a repeat that straddled a cycle paid the 3.7–4.0 s
cross-encoder again instead of the ~0.15 s cached answer.

The wipe protected nothing. `llm_cache` has two writers, both
content-addressed: rerank keys hash `(query, model, chunk text)` with the
resolved reranker URI as the model (#764), and expansion keys hash
`(query, model)`. A re-indexed document produces a new chunk text and so a new
key; its old score is never looked up again and ages out. This commit removes
the three calls. What still bounds the table is the prune to the 1,000 newest
rows inside `setCachedResult` (fires on ~1% of writes, so the table can run a
little past 1,000 between prunes), and the explicit routes are unchanged:
`qmd cleanup` (which Lloyd's nightly `lloyd-qmd-cleanup.service` runs, so the
cache still restarts once a day) and `store.clearCache()`.

`test/llm-cache-retention.test.ts` pins it: the CLI `collection add` and
`update` paths and the SDK `update()` leave every row and value unchanged (the
CLI case with an edited document in the same update); a document whose text
changed is re-scored while an unchanged one is served from the cache;
`qmd cleanup` and `clearCache()` still empty it; and 2,000 writes with the prune
forced leave at most 1,001 rows. Four of the five fail on the parent commit.

### 6.11 Upstream PR text

## In-memory exact vector index, collection-scoped search that is actually scoped

sqlite-vec 0.1.9 brute-forces every `MATCH` and cannot scope one to a collection, so a collection-filtered `searchVec` fell back to an exact scan through chunked `hash_seq IN (...)` lists at ~76 µs per vector — and a twelve-collection query ran that scan twelve times. On a 21k-chunk index that was 1.2 s of a 1.3 s query.

This keeps a normalised Float32 copy of `vectors_vec` in memory (`src/vecindex.ts`), scores it in one pass (~12 ms for 21k chunks) and takes an exact top-k per collection from that pass. Results are identical to sqlite-vec's — same files, order and scores; the test pins that against a real vec0 table, at two collections and at twelve. Scoping becomes free and small collections are never starved, so #791, #803 and #775 hold by construction.

- `QMD_VEC_MEMORY_INDEX=0` falls back to the untouched sqlite-vec paths; `QMD_VEC_MEMORY_INDEX_MAX_VECTORS` (default 200 000, ~600 MB at 768 dims) refuses to build above that and degrades to the old behaviour instead of exhausting RAM.
- The index reloads on `PRAGMA data_version` for other processes' writes and on every in-process write path for its own. A reload is a full rebuild (~0.5 s at 21k).

Measured against the same index snapshot, twelve collection-scoped requests, four workers: **9.5 s → 162 ms**; per request 842 ms → 18 ms.

Also in here, each small and separately useful:

- **REST `/query` accepts `skipRerank: true`** as an alias for `rerank: false`. The SDK option is named `skipRerank`, so HTTP clients sent it and got the reranker they asked to skip, with nothing in the response to say so.
- **`rerankWindowChars`** (SDK, REST, `QMD_RERANK_WINDOW_CHARS`): how much of each candidate's best chunk the reranker reads, opened at the first query term. 40 whole 900-token chunks: 1.6 s; 40 windows of 600 chars: 0.5 s. Default 0 keeps whole chunks. (On a 20-query retrieval eval the 600-char window cost 0.02 MRR, so it is opt-in.)
- **`QMD_RERANK_PARALLELISM`** sizes the reranker context pool outright instead of the VRAM-derived count capped at 4 — sized from free VRAM at first use, a shared GPU gave it two.
- **`QMD_LLM_IDLE_TIMEOUT_MS`**: the 5-minute default meant a long-lived MCP daemon reloaded the embedding model (2.5 s) and reranker (3 s) on the first query after any quiet stretch. `0` keeps them resident.
- `searchVec` resolves chunks by `(hash, seq)` instead of a `hash || '_' || seq` expression that could not use the primary key (16 ms of a 19 ms lookup); bodies are loaded only for returned rows.
- A single-character FTS term no longer gets prefix expansion: `a*` walked and BM25-ranked every token starting with "a" — 759 ms for a query that took 12 ms without the stray letter.
- `test/mcp.test.ts`: the stateless `initialize` test asserted `application/json`, but the SDK's legacy fallback answers as a single SSE event (and 406s a client that will not accept SSE). The test now accepts either framing. It is under `skipIf(CI)`, which is why CI never saw it fail.

Tests: `vecindex.test.ts` (parity vs sqlite-vec, reload, cap), `daemon-knobs.test.ts`, `rerank-window.test.ts`, `fts-single-char.test.ts`; full suite green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
