# Benchmarks

**These numbers measure the rebuild in `~/lamatic-engine`, not Lamatic's production backend.** Each comparison is between two configurations of the same engine, with LLM latency simulated by a seeded RNG. They show what a design choice is worth. Whether Lamatic already does it is an open question to check in the repo (see the architecture findings, §6).

## Environment

| | |
|---|---|
| Date | 2026-10-13 |
| Machine | Snapdragon X X126100 (Oryon, 8 cores, ARM64), 17 GB RAM, Windows 11 (10.0.26200) |
| Runtime | Node v24.19.0, TypeScript executed via Node type stripping |
| LLM latency | MockLLMProvider, uniform 15–35 ms per call, seed 42 (throughput: seed 7) |
| Samples | 100 runs per cell after 3 warm-up runs (overhead: 150; throughput: 300 runs from 50 concurrent clients) |
| Raw data | `bench/results/latest.json` |
| Reproduce | `npm run bench` (full, about 2 min) or `node bench/run.ts --quick` |

Laptop numbers, so single-digit-percent differences are noise. The p99 of 100 samples is the second-highest sample; treat it as indicative.

## 1. Scheduling: sequential vs. parallel ready-set

`concurrency: 1` runs one node at a time, in dependency order: the baseline. `concurrency: 8` runs any node whose inputs are ready.

| Flow shape | Mode | p50 ms | p95 ms | p99 ms | mean ms |
|---|---|---|---|---|---|
| chain-5 (prompt chain, no independent work) | sequential | 166.4 | 187.8 | 201.6 | 165.3 |
| | parallel | 159.0 | 186.9 | 204.3 | 165.7 |
| fanout-6 (6 independent LLM calls, then merge) | sequential | 201.8 | 231.2 | 250.0 | 201.1 |
| | parallel | **46.5** | **48.5** | **49.0** | 43.6 |
| branches-3x2 (3 independent 2-step pipelines, then join) | sequential | 201.2 | 222.1 | 233.6 | 199.5 |
| | parallel | **77.4** | **93.0** | **94.5** | 74.5 |

- **Fan-out:** 4.3× faster at p50 and 5.1× at p99.
- **Branches:** 2.6× faster at p50.
- **Chain:** no change. The means are equal (165.3 vs 165.7 ms), as expected when nothing can overlap, so parallel scheduling costs nothing when it can't help.
- **Why the tail shrinks:** with fan-out, total time becomes the slowest of 6 calls instead of their sum.

## 2. Throughput under load (RunService, fanout-6, 50 concurrent clients, 300 runs)

| Per-run node concurrency | Runs/s | p50 ms | p95 ms | p99 ms | Heap growth over test |
|---|---|---|---|---|---|
| 1 (sequential) | 228.6 | 202.8 | 237.1 | 245.0 | 29.7 MB |
| 8 (parallel) | **859.7** | **55.0** | **80.1** | **95.8** | 69.4 MB |

- **Throughput:** 3.8× higher, with p99 down 61%.
- **Why it's mostly waiting:** the work is I/O-bound (simulated LLM calls), so throughput is limited by latency, not CPU.
- **Heap growth:** this is mostly retained run records and traces. `RunService` keeps up to 10,000 finished runs, so it measures retention, not a leak.

## 3. Engine overhead (zero-latency nodes; all time is scheduling, templating and tracing)

| Shape | Nodes | p50 ms | p95 ms | p99 ms | µs per node (p50) |
|---|---|---|---|---|---|
| chain | 12 | 0.19 | 0.71 | 1.04 | 16 |
| wide | 12 | 0.15 | 0.20 | 0.60 | 12 |
| chain | 52 | 0.65 | 1.00 | 1.16 | 13 |
| wide | 52 | 0.67 | 1.05 | 1.60 | 13 |
| chain | 202 | 2.49 | 3.25 | 3.34 | 12 |
| wide | 202 | 3.20 | 4.37 | 4.82 | 16 |

Overhead scales linearly at about 12–16 µs per node, which is negligible next to any LLM or HTTP call.

## 4. Compilation and the compile-once cache

| Nodes | Cold compile p50 / p99 ms | Unchanged redeploy p50 / p99 ms | Compiles / cache hits |
|---|---|---|---|
| 22 | 0.27 / 0.72 | 0.15 / 0.78 | 1 / 100 |
| 52 | 0.74 / 1.04 | 0.34 / 0.69 | 1 / 100 |
| 202 | 2.97 / 3.76 | 1.36 / 1.92 | 1 / 100 |

- **Compile cost:** compiling is already cheap here, and a cache hit still costs a schema parse plus a hash.
- **Where the cache pays off:** it skips the **publish** step for unchanged content. Lamatic documents deploy, meaning bundle build plus edge distribution, as "typically under a minute". So a redeploy of unchanged content (a GitHub sync, a double click) becomes a no-op instead of a rebuild. That publish time is Lamatic's documented figure, not something I measured.

## 5. Retry amplification

| | Provider calls for one node that always gets HTTP 503 |
|---|---|
| Rebuild (SDK `maxRetries: 0`; node policy of 3 attempts is the only retry layer) | **3 (measured)** |
| Layers stacked without coordination (arithmetic, not measured) | 3 SDK attempts × 3 node attempts × (1 + 5 flow-level retries) = **54** |

The 54 is an upper bound **if** Lamatic's layers multiply. The docs show node retries and flow-level retries (up to 5) exist; whether the provider client also retries internally is unknown. See finding F2.

## Not measured, and why

- **Real LLM latency or cost:** I made no paid calls. Simulated latency isolates the scheduler.
- **Lamatic's edge runtime:** I had no access, and production load testing was out of scope.
- **Memory per run at the 128 MB Worker limit:** this needs the real runtime.
- **CPU utilisation:** the workloads are I/O-bound; overhead per node is reported in §3 instead.
