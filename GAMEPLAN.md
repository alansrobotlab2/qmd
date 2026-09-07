# GAMEPLAN

Next steps for this fork, ordered by value per unit of risk. `WORKLOG.md` is
the backward half and holds the measurements these decisions rest on.

**Local to this clone; not for an upstream PR.**

> ## Item 0: closed 2026-09-07
>
> Branch `lloyd`: `7b4bafe` (all code) and `81ce937` (the local notes,
> force-added past the `*.md` ignore). `git clean -fdx` is no longer a threat.
> Worklog section 6.1.

The one-line summary: the engine is proven and the install is **blocked on a
one-line decision in the lloyd repo**, not on anything here. Worklog section
6 has the numbers; the short version is directly below.

---

## 1. Install the fork  ← blocked on the client, see below

**Done 2026-09-07:** built at `81ce937`, served from a snapshot beside
published 2.8.3 on a second snapshot, benchmarked, parity-checked, and run
through three arms of `eval/run_eval.py` with the corpus held still.

- The engine is correct: with reranking on, the fork reproduces 2.8.3
  **exactly** — 20/20 top-10 lists identical, MRR 0.484, NDCG@10 0.590.
- The engine is fast: twelve-way fan-out 162 ms at four workers against
  9.3 s live today (worklog 6.6); the single recall request 725 ms against
  2079 ms with reranking on, and the whole eval 1570 ms against 3027 ms.
- **But the client's `skipRerank: true` has never been honoured**, and the fork
  honours it. That arm scores MRR **0.323**, NDCG@10 **0.450** — a third of
  MRR gone, because the client has been receiving a reranker it asked to skip
  since the day it was written. The comment justifying the flag at
  `agent_mcp/vault.py:317` was measured against a daemon that ignored it.

So the acceptance test ("quality must not move") **fails for the fork as the
client calls it, and passes exactly once the client stops asking to skip**.
The decision is in `agent_mcp/vault.py`, not here:

- **Flip `_qmd_daemon_search`'s `skip_rerank` default to `False`** (or drop the
  key). Quality identical to today, recall path 3x faster, fan-out level. The
  fan-out reranks twelve times and only gets faster when the rerank itself is
  cheaper: `QMD_RERANK_WINDOW_CHARS=600` makes it 2.9 s and the recall request
  339 ms, for 0.02 MRR (worklog 6.5–6.6). That is a second, separate decision.
- **Or accept the regression** for the speed. Nothing measured supports that.

Deploy recipe once decided (unchanged from before): point
`agent-services/supervisor/conf.d/agent-qmd-daemon.conf` at
`/home/alansrobotlab/lloyd/qmd/dist/cli/qmd.js`, add
`QMD_LLM_IDLE_TIMEOUT_MS=0` and `QMD_RERANK_PARALLELISM=4` to its
`environment=`, `supervisorctl reread && update`. The published package stays
installed; reverting is that one line back. The watcher keeps using the
published CLI for `update`/`embed` — the daemon reloads its index on the next
search after any foreign write (~0.5 s), so that split is fine.

Re-verify after deploy against worklog 6.3 and 6.5, not against the old
section-4 numbers.

## 2. Schedule `qmd cleanup`

Orphans returned to 2% within an hour of a cleanup that removed 67% of stored
vectors. Published 2.8.3 scans every stored vector, so orphans are a direct tax
on every query.

- A weekly or nightly `qmd cleanup` is the whole change.
- The watcher already runs (`agent-services/scripts/qmd-watcher.sh`); that is
  the natural home.
- Cheap, reversible, and independent of item 1.

## 3. The four-wide concurrency ceiling — closed 2026-09-07

It was the reranker pool, capped at 4, and it ran on every request because
published 2.8.3 ignores `skipRerank`. Worklog 6.4 shows it directly: on 2.8.3,
`skipRerank: true` and `rerank: false` return different result lists for 132
of 132 non-empty cases. The gameplan's caveat ("no latency difference between
the flags") was true for the wrong reason — the flag changed nothing.

The fork removes the ceiling for non-reranked requests (fan-out flat at
~165 ms from 4 to 12 workers, per-request 18 ms) and makes the pool size
explicit for reranked ones. `max_workers=4` in the client is no longer
load-bearing but costs nothing.

## 4. Fix the client's empty `facts` collection

In the lloyd repo, not here. `VAULT_SEGMENTS` names `facts`, qmd's `facts`
collection points at an empty `~/obsidian/facts`, and the real fact tree is
`_pipeline/vault-derived/facts`. One of every twelve requests is a round trip
for nothing.

Two honest options, and they are different decisions:

- **Drop `facts` from `VAULT_SEGMENTS`.** Saves 1/12 of every query. Safe.
- **Index the real fact tree.** 23,604 entity dirs, 61,011 files, 281 MB. That
  is roughly triple the current live index, and facts already reach retrieval
  through the graph and fact layer rather than through qmd. The risk is that
  61k short, formulaic derived files crowd out the source documents they were
  derived from.

Do not guess between them. lloyd's pinned-corpus harness makes this a
measurable A/B, and the doc-side metrics are the ones that would move.

## 5. Decide `searchPartitioned`

Delete it or call it, but do not re-benchmark it. It is not a performance gap;
`scores()` already memoises across the recursion. See worklog section 3 for the
numbers, so nobody repeats the experiment.

## 6. The upstream MCP test failure

`test/mcp.test.ts`, stateless `initialize`, expects `application/json` and gets
`text/event-stream`. Reproduced on clean `dbfd0b4`, so it is upstream's.

- Either fix it and send it upstream, or pin it as a known failure so the suite
  has a clean baseline. A suite with one permanent red is a suite people stop
  reading.

## 7. Upstreaming

The vector index in particular is a general fix with issue numbers attached
(#791, #803, #775, #799) and its own tests. If it is going upstream, do it
before the fork drifts further from `dbfd0b4`.

Three local things must not go with it:

- `WORKLOG.md` and `GAMEPLAN.md`. Untracked and hidden by upstream's `*.md`
  rule, so they will not follow by accident, but check.
- The **local section prepended to `CLAUDE.md`**, which is the one tracked file
  these notes modify. `git checkout CLAUDE.md` removes it cleanly. It is
  delimited by HTML comments naming itself, so it is hard to miss on review.

---

## Things already settled, so nobody relitigates them

- **qmd is GPU-accelerated.** 3.6 GB on GPU 0, 93% during a vector leg.
- **A different search engine is not the answer.** ANN indexes earn their
  approximation at millions of vectors; there are about 21,000 live ones, where
  an exact dot product over a Float32 matrix is already ~12 ms. The lexical side
  is ~7.5 ms per request. Neither has speed left to buy.
- **The twelve-way fan-out is not waste.** Collapsing it to one request is 3x
  faster and returns 40 documents instead of 213, a strict subset. It is buying
  recall.
- **The client's `max_workers=4` was correct** for 2.8.3 and is harmless on
  the fork. Item 3 is closed; there is no ceiling left to raise for
  non-reranked requests.
- **The reranker is worth 0.16 MRR on `vault_recall`.** Measured 2026-09-07 with
  the corpus pinned (worklog 6.5). Do not remove it for speed.
- **Speed may not be the binding constraint anyway.** Retrieval quality sits at
  mrr_doc 0.47 and ndcg10 0.56, and lloyd's backlog #380 concluded the binding
  constraint is candidate generation. A faster engine returning the same
  documents does not make the assistant better. Item 1's acceptance test is
  deliberately "quality must not move"; improving it is a separate project.
