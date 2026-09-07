# GAMEPLAN

Next steps for this fork, ordered by value per unit of risk. `WORKLOG.md` is
the backward half and holds the measurements these decisions rest on.

**Local to this clone; not for an upstream PR.**

> ## ⚠ Item 0: none of this work is committed
>
> `src/vecindex.ts` and the four new test files are **untracked**, and every
> other change is **unstaged**. About 640 new lines and 287 changed, none of it
> in git. A single `git clean -fd` in this directory destroys the whole thing,
> and `git status` will not warn you, because upstream's `.gitignore` also
> hides `*.md` so these notes vanish with it.
>
> Commit it to a branch before touching anything else on this list. It costs
> one command and it is the only irreversible risk here.

The one-line summary: the work is done and unshipped. Everything in section 1
of the worklog is inert until the daemon runs it, and the daemon runs published
2.8.3.

---

## 1. Install the fork  ← start here

Nothing else on this list matters first. The vector index, the idle timeout,
the rerank knobs and the `skipRerank` fix are all written, tested and reaching
nothing.

- Build it and point the supervisord program at this tree rather than the bun
  global package. The daemon is `agent-qmd-daemon` in
  `agent-services/supervisor/conf.d/`, currently
  `node .../@tobilu/qmd/dist/cli/qmd.js mcp --http --port 8181`.
- Keep a way back. The published package stays installed, so reverting is a
  one-line conf change plus a restart.
- **Verify against the worklog's baseline numbers**, not against a feeling:
  first-request-after-idle should stop being 3.7 s, and a twelve-collection
  fan-out should drop below its current 3.0 s at four workers.

Acceptance: `/query` answers, `qmd status` is sane, and one full
`eval/run_eval.py` in the lloyd repo produces the same metric values as before.
Retrieval *quality* must not move. If it does, that is a bug in the fork, not
an improvement.

## 2. Schedule `qmd cleanup`

Orphans returned to 2% within an hour of a cleanup that removed 67% of stored
vectors. Published 2.8.3 scans every stored vector, so orphans are a direct tax
on every query.

- A weekly or nightly `qmd cleanup` is the whole change.
- The watcher already runs (`agent-services/scripts/qmd-watcher.sh`); that is
  the natural home.
- Cheap, reversible, and independent of item 1.

## 3. Identify the four-wide concurrency ceiling

Still unexplained, and it bounds every fan-out the client does.

Ruled out by measurement: libuv's threadpool (`UV_THREADPOOL_SIZE=16`, no
change), the embedding context pool (`QMD_EMBED_PARALLELISM=8`, no change, and
lex-only shows the same ceiling with no embedding involved).

**Leading hypothesis, untested.** The fork's own changelog says
`QMD_RERANK_PARALLELISM` replaces "the VRAM-derived count **capped at 4**" for
the *reranker*. Four is exactly the ceiling measured. And published 2.8.3's
REST endpoint does not honour `skipRerank`, which is the flag the lloyd client
sends on every request, so every query may be reranking despite asking not to.
Those two facts fit the observation precisely.

If that is right, item 1 fixes it twice over, since the fork both honours
`skipRerank` and lets the pool be sized. Test it after installing: re-run the
worker-scaling measurement in the worklog and see whether it goes past 4x.

Caveat: I measured no latency difference between `skipRerank: true`,
`rerank: false` and no flag at all on the live daemon, which argues the
reranker was not running. That does not fit the hypothesis, so it is genuinely
open.

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
- **The client's `max_workers=4` is correct** for the current daemon. Revisit
  only if item 3 raises the ceiling.
- **Speed may not be the binding constraint anyway.** Retrieval quality sits at
  mrr_doc 0.47 and ndcg10 0.56, and lloyd's backlog #380 concluded the binding
  constraint is candidate generation. A faster engine returning the same
  documents does not make the assistant better. Item 1's acceptance test is
  deliberately "quality must not move"; improving it is a separate project.
