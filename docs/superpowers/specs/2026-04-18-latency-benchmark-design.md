# Latency Benchmark Suite — Design

**Date:** 2026-04-18
**Branch:** 001-nestjs-module
**Scope:** `benchmark-repo` sub-command for deep latency analysis

---

## Background

The existing benchmark suite (`npm run benchmark`) reports RunMQ e2e latency at ~9.5ms (±0.04ms stddev) vs BullMQ ~0.63ms. The stability of the 9.5ms figure (extremely tight stddev) suggests a systematic source rather than noise. A reviewer asked whether the latency stays flat under higher concurrency — that's the key diagnostic question.

This suite answers two questions:
1. Of the 9.5ms, how much is RunMQ in-process overhead vs pure AMQP/TCP cost?
2. Does latency climb under burst load, and which component drives that climb?

---

## Architecture

New entry point added to `benchmark-repo`. Invoked via:

```
npm run latency   →   node --expose-gc dist/latency.js
```

Added to `package.json`:
```json
"latency": "node --expose-gc dist/latency.js"
```

### File structure

```
benchmark-repo/src/
  latency.ts                    ← orchestrator entry point
  latency/
    micro.ts                    ← Phase 1: CPU-only micro-benchmarks
    concurrency.ts              ← Phase 2: burst concurrency sweep
    raw-amqplib-adapter.ts      ← minimal amqplib wrapper (baseline)
    latency-report.ts           ← HTML report generator
```

---

## Phase 1 — Micro-benchmarks (CPU only, no network)

Each operation runs **500 warmup iterations** (discarded) then **10,000 measured iterations**, reporting **mean ± stddev in nanoseconds**. Uses `performance.now()` with sub-microsecond resolution.

Operations measured in isolation, then combined:

| Operation | What it pins down |
|---|---|
| `crypto.randomUUID()` × 2 | UUID generation (called twice per publish) |
| `JSON.stringify(runMQMessage)` | Serialization cost |
| `Buffer.from(serialized)` | Publish-side buffer copy |
| **Combined publish pipeline** | Total in-process cost before `channel.publish()` |
| `msg.content.toString()` | Consume-side buffer→string conversion |
| `JSON.parse(data)` | Deserialization cost |
| `RunMQMessage.isValid(parsed)` | Struct validation (8 field checks) |
| **Combined consume pipeline** | Total in-process cost before handler fires |
| **Total in-process overhead** | Sum of publish + consume pipeline |

"Combined" rows use real representative payload (100-byte JSON, matching the e2e benchmark) to capture realistic GC pressure — not just the sum of individual operations.

**Expected outcome:** Total in-process overhead will be < 0.5ms, immediately narrowing the 9.5ms attribution to AMQP/TCP.

---

## Phase 2 — Concurrency (burst) sweep

### Concurrency model

**Burst size N**: N messages published in rapid succession before any consumer ack arrives, then wait for all N to be consumed. This directly models queue buildup — the scenario the reviewer asked about.

- Burst levels: **1, 5, 10, 25, 50**
- Bursts per level: **200** (after 5 warmup bursts discarded)
- Latency measured **per message** individually (`sentAt` before publish, `receivedAt` in handler)

### Baselines

Each burst level runs on **both**:
- **Full RunMQ** — standard `RunMQAdapter` (existing)
- **Raw amqplib** — new minimal wrapper with no RunMQ overhead

### Raw amqplib adapter

The thinnest possible publish/consume loop over amqplib directly:
- Publish: `channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)))`
- Consume: `msg.content.toString()` → handler
- No UUID generation, no `RunMQMessage` envelope, no processor chain, no schema validation

**Delta = RunMQ latency − raw amqplib latency = pure RunMQ overhead**

### Metrics per burst level

| Metric | Meaning |
|---|---|
| mean ± stddev | Central tendency and run stability |
| p50, p95, p99 | Tail behavior under burst load |
| delta (RunMQ − raw) | Library overhead, isolated from TCP/broker |

---

## Output

### Terminal

Printed as each phase completes:

```
Phase 1: Micro-benchmarks (CPU only, no network)
─────────────────────────────────────────────────
  crypto.randomUUID() ×2        142 ±  8 ns
  JSON.stringify                 61 ± 12 ns
  Buffer.from                    18 ±  4 ns
  Combined publish pipeline     231 ± 19 ns
  msg.content.toString()         14 ±  3 ns
  JSON.parse                     54 ±  9 ns
  RunMQMessage.isValid           11 ±  2 ns
  Combined consume pipeline      88 ± 11 ns
  ─────────────────────────────────────────
  Total in-process overhead     319 ± 22 ns

Phase 2: Concurrency sweep (RunMQ vs raw amqplib)
──────────────────────────────────────────────────
  Burst │ RunMQ mean±σ  │  p99  │ raw amqplib  │  p99  │ delta
  ──────┼───────────────┼───────┼──────────────┼───────┼───────
      1 │   9.5 ±0.3 ms │ 12 ms │  9.2 ±0.3 ms │ 11 ms │ 0.3 ms
     ...
```

### HTML report

Saved to `results/latency-report.html`. Two sections:
1. **Micro-benchmark table** — same data as terminal, styled consistently with the main report
2. **Concurrency sweep chart** — line chart: latency (mean + p99) vs burst level, two lines per metric (RunMQ + raw amqplib), plus a "delta" series showing library overhead across burst levels

Reuses existing `report.ts` CSS and structure for visual consistency.

---

## Code analysis: Optimization hypotheses

Based on reading the RunMQ source, these are the most likely optimization opportunities (ranked by expected impact). The benchmark will confirm which actually matter:

### 1. TCP_NODELAY (highest expected impact on latency)
`RabbitMQClientAdapter` calls `amqp.connect(url)` without socket options. Nagle's algorithm is enabled by default — it coalesces small TCP packets, adding up to ~40ms delay when there's unacknowledged data on the wire.

Fix: pass `{noDelay: true}` as the second argument to `amqp.connect()`.
This is a single-line change and could dramatically reduce p99 latency.

### 2. UUID generation (minor, measurable)
`crypto.randomUUID()` is called **twice per publish** — once for `correlationId` (in `RunMQ.publish()`) and once for `messageId` (in `RunMQMessageProperties`). For throughput-sensitive paths, pre-generating UUID batches or using a faster ID generator (e.g., nanoid, or incrementing counter for non-production use) reduces crypto overhead.

### 3. Processor chain flattening (minor)
The consume path traverses 6 nested async decorator processors (`RunMQExceptionLoggerProcessor` → `RunMQSucceededMessageAcknowledgerProcessor` → ... → `RunMQBaseProcessor`). Each is an `async` function boundary. A flat array-based pipeline would reduce stack depth and promise allocation overhead, though the saving is likely < 0.05ms per message.

### 4. Allocation reduction (micro-optimization)
Every message allocates: `RunMQMessage`, `RunMQMessageMeta`, `RabbitMQMessage`, the serialized string, and the Buffer. At very high throughput these create GC pressure. Object pooling or reuse is possible but adds complexity — only worthwhile at > 50k msg/s.

### 5. Custom binary serializer (low priority)
`DefaultSerializer` uses `JSON.stringify`. MessagePack or protobuf would produce smaller payloads (less TCP data) and parse faster. But Phase 1 will show that serialization is < 0.1ms — the TCP round-trip dominates. This is low ROI unless message sizes are large.

---

## Success criteria

- `npm run latency` completes without error with RabbitMQ running
- Phase 1 prints per-operation nanosecond breakdown with stddev
- Phase 2 prints latency table for all 5 burst levels × 2 adapters
- `results/latency-report.html` is written and viewable
- Delta column clearly shows where RunMQ overhead lives vs pure AMQP cost
