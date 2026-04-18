# Latency Benchmark Suite Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run latency` to `benchmark-repo` — a two-phase latency analysis suite that isolates RunMQ's in-process overhead from AMQP/TCP cost, and measures how latency scales under burst load.

**Architecture:** Two independent phases run sequentially: Phase 1 (CPU micro-benchmarks, no network) pins down serialization/UUID/validation costs in nanoseconds; Phase 2 (burst concurrency sweep) runs RunMQ and raw amqplib side-by-side at 1/5/10/25/50 message bursts to isolate library overhead from broker cost. Results print to terminal and write to `results/latency-report.html`.

**Tech Stack:** TypeScript 5 (ESM, Node16 module resolution, `"module": "Node16"`, `esModuleInterop: true`), amqplib (direct AMQP for raw baseline), Chart.js 4 (CDN), existing `mean`/`stddev`/`percentile`/`sleep`/`forceGC` helpers from `src/types.ts`.

---

## Chunk 1: Foundation

### Task 1: Add amqplib dependency and latency script

**Files:**
- Modify: `benchmark-repo/package.json`
- Create: `benchmark-repo/src/latency.ts` (skeleton only)

- [ ] **Step 1: Install amqplib and its types**

```bash
cd /Users/fawzi.essam/Desktop/runmq/runmq-base/benchmark-repo
npm install amqplib
npm install --save-dev @types/amqplib
```

Expected: `package.json` shows `"amqplib"` in `dependencies` and `"@types/amqplib"` in `devDependencies`.

- [ ] **Step 2: Add the latency script to `package.json`**

Edit `scripts` in `package.json` to add one line:
```json
"latency": "node --expose-gc dist/latency.js"
```

Full scripts block after the edit:
```json
"scripts": {
  "build": "tsc",
  "start": "node --expose-gc dist/runner.js",
  "latency": "node --expose-gc dist/latency.js",
  "benchmark": "docker compose up --build --abort-on-container-exit benchmark && docker compose down"
}
```

- [ ] **Step 3: Create skeleton `src/latency.ts` to verify compilation**

```typescript
console.log('Latency suite — starting');
```

- [ ] **Step 4: Verify compilation**

```bash
npm run build
```

Expected: exits 0, `dist/latency.js` appears.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/latency.ts
git commit -m "feat: add amqplib dep and latency script scaffold"
```

---

### Task 2: Raw amqplib adapter

**Files:**
- Create: `benchmark-repo/src/latency/raw-amqplib-adapter.ts`

This is the key baseline fixture. It wraps amqplib directly with the absolute minimum code — no UUID generation, no `RunMQMessage` envelope, no processor chain, no schema validation. Implements `QueueAdapter` from `types.ts` so it can be passed to the same sweep function as `RunMQAdapter`.

Delta between RunMQ and this adapter = RunMQ's pure in-flight overhead.

- [ ] **Step 1: Create `src/latency/raw-amqplib-adapter.ts`**

```typescript
import amqp from 'amqplib';
import type { Connection, Channel } from 'amqplib';
import type { QueueAdapter } from '../types.js';

const EXCHANGE = 'latency-raw-exchange';

export class RawAmqplibAdapter implements QueueAdapter {
  readonly name = 'Raw AMQP';
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async setup(): Promise<void> {
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(EXCHANGE, 'direct', { durable: false });
  }

  async teardown(): Promise<void> {
    if (this.channel) {
      try { await this.channel.close(); } catch { /* ignore */ }
      this.channel = null;
    }
    if (this.connection) {
      try { await this.connection.close(); } catch { /* ignore */ }
      this.connection = null;
    }
  }

  /**
   * Minimal publish: Buffer.from(JSON.stringify(message)) only.
   * No UUID, no RunMQMessage envelope, no correlationId headers.
   */
  publish(topic: string, message: Record<string, unknown>): void {
    this.channel!.publish(EXCHANGE, topic, Buffer.from(JSON.stringify(message)));
  }

  async publishBatch(topic: string, messages: Record<string, unknown>[]): Promise<void> {
    for (const msg of messages) this.publish(topic, msg);
  }

  async startConsumer(
    topic: string,
    _concurrency: number,
    onMessage: (msg: unknown) => Promise<void>,
  ): Promise<void> {
    await this.channel!.assertQueue(topic, { durable: false, autoDelete: true });
    await this.channel!.bindQueue(topic, EXCHANGE, topic);
    const result = await this.channel!.consume(topic, async (msg) => {
      if (msg) {
        // Minimal consume: toString + JSON.parse only — no RunMQ processing chain
        const data = JSON.parse(msg.content.toString()) as Record<string, unknown>;
        await onMessage(data);
        this.channel!.ack(msg);
      }
    });
    this.consumerTag = result.consumerTag;
  }

  async stopConsumer(): Promise<void> {
    if (this.consumerTag && this.channel) {
      try { await this.channel.cancel(this.consumerTag); } catch { /* ignore */ }
      this.consumerTag = null;
    }
    // Reconnect to get a clean channel (matching RunMQAdapter.stopConsumer behaviour)
    await this.teardown();
    await this.setup();
  }

  async purge(topic: string): Promise<void> {
    if (this.channel) {
      try { await this.channel.purgeQueue(topic); } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
npm run build
```

Expected: exits 0, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/latency/raw-amqplib-adapter.ts
git commit -m "feat: add raw amqplib adapter for latency baseline"
```

---

## Chunk 2: Benchmark phases

### Task 3: Phase 1 — CPU micro-benchmarks

**Files:**
- Create: `benchmark-repo/src/latency/micro.ts`
- Modify: `benchmark-repo/src/latency.ts` (smoke-test only, will be fully replaced in Task 6)

Measures each CPU-bound operation in RunMQ's publish/consume pipeline in isolation — **no network, no Docker required**. Uses batched timing (100 ops per `performance.now()` sample) to stay well above the clock's resolution floor on sub-microsecond operations.

`isValidEnvelope()` replicates `RunMQMessage.isValid()` exactly (all 8 field checks) without importing RunMQ internals.

- [ ] **Step 1: Create `src/latency/micro.ts`**

```typescript
import { randomUUID } from 'crypto';
import { mean, stddev } from '../types.js';

export interface MicroResult {
  name: string;
  meanNs: number;
  stddevNs: number;
}

const WARMUP = 500;
const ITERATIONS = 10_000;
const BATCH_SIZE = 100; // ops per timing sample — avoids perf.now() resolution floor

// Representative 100-byte JSON payload matching the e2e latency scenario
const PAYLOAD = { ts: Date.now(), id: 'abcdef123456', pad: 'x'.repeat(60) };
const ENVELOPE = {
  message: PAYLOAD,
  meta: {
    id: 'bench-id-fixed',
    correlationId: 'bench-corr-fixed',
    publishedAt: Date.now(),
  },
};
const SERIALIZED = JSON.stringify(ENVELOPE);
const BUFFER = Buffer.from(SERIALIZED);

/**
 * Measures mean ± stddev per operation in nanoseconds.
 * Runs WARMUP iterations first (discarded) then ITERATIONS/BATCH_SIZE batches.
 */
function measure(name: string, fn: () => unknown): MicroResult {
  for (let i = 0; i < WARMUP; i++) fn();

  const samples: number[] = [];
  const batches = Math.ceil(ITERATIONS / BATCH_SIZE);

  for (let b = 0; b < batches; b++) {
    const start = performance.now();
    for (let j = 0; j < BATCH_SIZE; j++) fn();
    const elapsed = performance.now() - start;
    samples.push((elapsed * 1_000_000) / BATCH_SIZE); // ms → ns per op
  }

  return { name, meanNs: mean(samples), stddevNs: stddev(samples) };
}

/**
 * Replicates RunMQMessage.isValid() exactly — same 8 field checks.
 * Defined here to avoid importing RunMQ internals and to match the
 * real cost of validation in the consume path.
 */
function isValidEnvelope(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (!('message' in o) || !('meta' in o)) return false;
  if (typeof o.message !== 'object' || o.message === null || Array.isArray(o.message)) return false;
  if (typeof o.meta !== 'object' || o.meta === null) return false;
  const meta = o.meta as Record<string, unknown>;
  return (
    'id' in meta &&
    'correlationId' in meta &&
    'publishedAt' in meta &&
    typeof meta.id === 'string' &&
    typeof meta.correlationId === 'string' &&
    typeof meta.publishedAt === 'number'
  );
}

export function runMicro(): MicroResult[] {
  const results: MicroResult[] = [];

  // ── Publish-side operations ──
  results.push(measure('crypto.randomUUID() ×2', () => {
    randomUUID(); randomUUID();
  }));

  results.push(measure('JSON.stringify (envelope)', () => {
    JSON.stringify(ENVELOPE);
  }));

  results.push(measure('Buffer.from (string→buffer)', () => {
    Buffer.from(SERIALIZED);
  }));

  // Combined: everything that happens before channel.publish()
  results.push(measure('Combined publish pipeline', () => {
    const id = randomUUID();
    const correlationId = randomUUID();
    const envelope = {
      message: PAYLOAD,
      meta: { id, correlationId, publishedAt: Date.now() },
    };
    const serialized = JSON.stringify(envelope);
    Buffer.from(serialized);
  }));

  // ── Consume-side operations ──
  results.push(measure('Buffer.toString (buffer→string)', () => {
    BUFFER.toString();
  }));

  results.push(measure('JSON.parse (deserialize)', () => {
    JSON.parse(SERIALIZED);
  }));

  results.push(measure('RunMQMessage.isValid (validate)', () => {
    isValidEnvelope(ENVELOPE);
  }));

  // Combined: everything that happens before the user handler fires
  results.push(measure('Combined consume pipeline', () => {
    const str = BUFFER.toString();
    const parsed = JSON.parse(str);
    isValidEnvelope(parsed);
  }));

  return results;
}
```

- [ ] **Step 2: Verify compilation**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 3: Smoke-test Phase 1 standalone (no Docker needed)**

Replace `src/latency.ts` with a temporary Phase-1-only runner:

```typescript
import { runMicro } from './latency/micro.js';
import type { MicroResult } from './latency/micro.js';

function printMicro(results: MicroResult[]): void {
  console.log('');
  console.log('Phase 1: Micro-benchmarks (CPU only, no network)');
  console.log('─'.repeat(60));
  for (const r of results) {
    const name = r.name.padEnd(40);
    const m = `${r.meanNs.toFixed(1).padStart(8)} ns`;
    const sd = `± ${r.stddevNs.toFixed(1).padStart(7)} ns`;
    console.log(`  ${name} ${m}  ${sd}`);
  }
  const pub = results.find(r => r.name === 'Combined publish pipeline');
  const con = results.find(r => r.name === 'Combined consume pipeline');
  if (pub && con) {
    const total = pub.meanNs + con.meanNs;
    console.log('─'.repeat(60));
    console.log(`  ${'Total in-process overhead'.padEnd(40)} ${total.toFixed(1).padStart(8)} ns`);
    console.log(`  → ${(total / 1_000_000).toFixed(4)} ms of the 9.5ms e2e is pure RunMQ CPU work`);
  }
  console.log('');
}

const micro = runMicro();
printMicro(micro);
```

Run it (no Docker required):
```bash
npm run build && node --expose-gc dist/latency.js
```

Expected: prints Phase 1 table, all `meanNs` values positive, combined publish pipeline likely 150–500 ns.

- [ ] **Step 4: Commit**

```bash
git add src/latency/micro.ts src/latency.ts
git commit -m "feat: add Phase 1 CPU micro-benchmarks"
```

---

### Task 4: Phase 2 — burst concurrency sweep

**Files:**
- Create: `benchmark-repo/src/latency/concurrency.ts`

Runs both RunMQ and raw amqplib at burst sizes `[1, 5, 10, 25, 50]`. Within each burst, N messages are published before any consumer ack arrives — modeling queue buildup. Latency is measured per-message via a `sentAt` map keyed by a global index embedded in the payload. 200 bursts per level (5 warmup discarded).

- [ ] **Step 1: Create `src/latency/concurrency.ts`**

```typescript
import { mean, stddev, percentile, sleep, forceGC } from '../types.js';
import type { QueueAdapter } from '../types.js';

export interface BurstLevelResult {
  burstSize: number;
  meanMs: number;
  stddevMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  sampleCount: number;
}

export interface AdapterConcurrencyResult {
  adapterName: string;
  levels: BurstLevelResult[];
}

export interface ConcurrencySweepResult {
  runmq: AdapterConcurrencyResult;
  raw: AdapterConcurrencyResult;
}

const BURST_LEVELS = [1, 5, 10, 25, 50] as const;
const NUM_BURSTS = 200;
const WARMUP_BURSTS = 5;

// Small representative payload (avoids empty-message optimizations by broker)
const PAYLOAD_PAD = 'x'.repeat(40);

async function runBurstLevel(
  adapter: QueueAdapter,
  topic: string,
  burstSize: number,
): Promise<BurstLevelResult> {
  const warmupMessages = WARMUP_BURSTS * burstSize;
  const sentAt = new Map<number, number>();
  const latencies: number[] = [];
  let globalIdx = 0;
  let consumed = 0;
  let resolveNext: (() => void) | null = null;
  let nextTarget = 0;

  await adapter.startConsumer(topic, 1, async (msg) => {
    const receivedAt = performance.now();
    const data = msg as Record<string, unknown>;
    const idx = typeof data._gidx === 'number' ? (data._gidx as number) : -1;

    // Only record latencies after warmup phase
    if (idx >= warmupMessages) {
      const sent = sentAt.get(idx);
      if (sent !== undefined) {
        latencies.push(receivedAt - sent);
        sentAt.delete(idx); // free memory as we go
      }
    }

    consumed++;
    if (consumed >= nextTarget) {
      resolveNext?.();
      resolveNext = null;
    }
  });

  await sleep(500); // allow consumer to register with broker before first burst

  const totalBursts = NUM_BURSTS + WARMUP_BURSTS;

  for (let burst = 0; burst < totalBursts; burst++) {
    nextTarget = (burst + 1) * burstSize;

    // Create completion promise BEFORE publishing to prevent race condition
    // where messages arrive before resolveNext is set
    const waitForBurst = new Promise<void>((r) => {
      if (consumed >= nextTarget) {
        r(); // already at target (defensive guard)
      } else {
        resolveNext = r;
      }
    });

    // Publish all N messages in the burst
    for (let i = 0; i < burstSize; i++) {
      const idx = globalIdx++;
      sentAt.set(idx, performance.now());
      adapter.publish(topic, { _gidx: idx, ts: Date.now(), pad: PAYLOAD_PAD });
    }

    const timeout = setTimeout(() => {
      console.log(`    WARN: burst ${burst} timed out (consumed=${consumed}, target=${nextTarget})`);
      resolveNext?.();
    }, 30_000);

    await waitForBurst;
    clearTimeout(timeout);
  }

  await adapter.stopConsumer();

  latencies.sort((a, b) => a - b);

  return {
    burstSize,
    meanMs: parseFloat(mean(latencies).toFixed(3)),
    stddevMs: parseFloat(stddev(latencies).toFixed(3)),
    p50Ms: parseFloat(percentile(latencies, 50).toFixed(3)),
    p95Ms: parseFloat(percentile(latencies, 95).toFixed(3)),
    p99Ms: parseFloat(percentile(latencies, 99).toFixed(3)),
    sampleCount: latencies.length,
  };
}

export async function runConcurrencySweep(
  runmqAdapter: QueueAdapter,
  rawAdapter: QueueAdapter,
): Promise<ConcurrencySweepResult> {
  const runmqLevels: BurstLevelResult[] = [];
  const rawLevels: BurstLevelResult[] = [];

  for (const burstSize of BURST_LEVELS) {
    forceGC();
    await sleep(500);
    console.log(`  [sweep] RunMQ  burst=${burstSize} (${NUM_BURSTS} bursts × ${burstSize} msgs)...`);
    const runmqResult = await runBurstLevel(
      runmqAdapter,
      `latency-runmq-b${burstSize}`,
      burstSize,
    );
    runmqLevels.push(runmqResult);
    console.log(`         mean=${runmqResult.meanMs}ms ±${runmqResult.stddevMs}  p99=${runmqResult.p99Ms}ms`);

    forceGC();
    await sleep(500);
    console.log(`  [sweep] RawAMQP burst=${burstSize}...`);
    const rawResult = await runBurstLevel(
      rawAdapter,
      `latency-raw-b${burstSize}`,
      burstSize,
    );
    rawLevels.push(rawResult);
    console.log(`         mean=${rawResult.meanMs}ms ±${rawResult.stddevMs}  p99=${rawResult.p99Ms}ms`);
    console.log(`         delta (RunMQ overhead): ${(runmqResult.meanMs - rawResult.meanMs).toFixed(3)}ms`);
    console.log('');
  }

  return {
    runmq: { adapterName: 'RunMQ', levels: runmqLevels },
    raw: { adapterName: 'Raw AMQP', levels: rawLevels },
  };
}
```

- [ ] **Step 2: Verify compilation**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/latency/concurrency.ts
git commit -m "feat: add Phase 2 burst concurrency sweep"
```

---

## Chunk 3: Output & orchestration

### Task 5: HTML report generator

**Files:**
- Create: `benchmark-repo/src/latency/latency-report.ts`

Reuses the dark-theme CSS variables and card/table structure from `report.ts`. Section 1: micro-benchmark table (highlighted combined rows, total row). Section 2: Chart.js line chart (mean + p99 for RunMQ and raw amqplib + delta series) plus a detailed table with all percentiles. Writes to `results/latency-report.html`.

- [ ] **Step 1: Create `src/latency/latency-report.ts`**

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MicroResult } from './micro.js';
import type { ConcurrencySweepResult } from './concurrency.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function generateLatencyReport(
  micro: MicroResult[],
  sweep: ConcurrencySweepResult,
  timestamp: string,
): string {
  const microJson = JSON.stringify(micro);
  const sweepJson = JSON.stringify(sweep);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RunMQ Latency Analysis</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {
    --runmq: #6366f1;
    --raw: #10b981;
    --delta: #f59e0b;
    --bg: #0f172a;
    --card: #1e293b;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --border: #334155;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
  }
  .header { text-align: center; margin-bottom: 3rem; }
  .header h1 {
    font-size: 2.2rem;
    font-weight: 800;
    background: linear-gradient(135deg, var(--runmq), var(--raw));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }
  .header p { color: var(--muted); font-size: 0.9rem; }
  .section-title {
    text-align: center;
    font-size: 1.4rem;
    font-weight: 700;
    margin: 2.5rem 0 1.5rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    max-width: 960px;
    margin: 0 auto 1.5rem;
  }
  .card h2 { font-size: 1.1rem; margin-bottom: 0.25rem; }
  .card .desc { color: var(--muted); font-size: 0.8rem; margin-bottom: 1.25rem; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .combined { font-weight: 700; color: var(--runmq); }
  .chart-container { position: relative; height: 380px; }
  .legend {
    display: flex; justify-content: center; gap: 2rem;
    margin-bottom: 1.5rem; flex-wrap: wrap;
  }
  .legend-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; font-weight: 600; }
  .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
  .insight {
    max-width: 960px; margin: 2rem auto 0;
    padding: 1.25rem 1.5rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    font-size: 0.85rem;
    color: var(--muted);
    line-height: 1.7;
  }
  .insight h3 { color: var(--text); margin-bottom: 0.5rem; font-size: 1rem; }
  .insight ul { padding-left: 1.5rem; margin-top: 0.5rem; }
  .insight li { margin-bottom: 0.25rem; }
</style>
</head>
<body>

<div class="header">
  <h1>RunMQ Latency Analysis</h1>
  <p>Generated ${timestamp}</p>
</div>

<!-- ═══ Phase 1 ═══ -->
<h2 class="section-title">Phase 1 — In-Process Overhead (CPU only, no network)</h2>

<div class="card">
  <h2>Micro-benchmark Results</h2>
  <div class="desc">
    Each operation: 10,000 iterations (500 warmup discarded), timed in batches of 100 to stay
    above <code>performance.now()</code> clock resolution. Payload: 100-byte JSON envelope
    matching the e2e latency scenario. ★ rows are pipeline totals.
  </div>
  <table>
    <thead>
      <tr>
        <th>Operation</th>
        <th class="num">Mean (ns)</th>
        <th class="num">± Stddev (ns)</th>
      </tr>
    </thead>
    <tbody id="micro-body"></tbody>
  </table>
</div>

<!-- ═══ Phase 2 ═══ -->
<h2 class="section-title">Phase 2 — Burst Concurrency Sweep</h2>

<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:var(--runmq)"></div>RunMQ (mean)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--runmq);opacity:.4"></div>RunMQ (p99)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--raw)"></div>Raw AMQP (mean)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--raw);opacity:.4"></div>Raw AMQP (p99)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--delta)"></div>Delta (RunMQ overhead)</div>
</div>

<div class="card">
  <h2>Latency vs Burst Size</h2>
  <div class="desc">
    Burst size N = messages published before any consumer ack arrives — models queue buildup.
    200 bursts per level (5 warmup discarded). Latency measured per-message.
    Delta = RunMQ mean − Raw AMQP mean = pure library overhead.
  </div>
  <div class="chart-container">
    <canvas id="sweep-chart"></canvas>
  </div>
</div>

<div class="card">
  <h2>Concurrency Sweep — Detailed Table</h2>
  <div class="desc">Mean ± stddev, p50, p95, p99, and RunMQ overhead delta for all burst levels.</div>
  <table>
    <thead>
      <tr>
        <th>Burst</th>
        <th class="num">RunMQ mean ± σ</th>
        <th class="num">p50</th>
        <th class="num">p95</th>
        <th class="num">p99</th>
        <th class="num">Raw mean ± σ</th>
        <th class="num">Raw p99</th>
        <th class="num">Delta (overhead)</th>
      </tr>
    </thead>
    <tbody id="sweep-body"></tbody>
  </table>
</div>

<div class="insight">
  <h3>How to read the results</h3>
  <ul>
    <li><strong>Phase 1 total</strong>: the sum of combined publish + consume pipeline is RunMQ's pure CPU cost per message. Anything left in the e2e latency is AMQP/TCP/broker time.</li>
    <li><strong>Delta stays flat</strong>: RunMQ overhead is constant; tail growth under bursts is pure broker queuing — the library is not the bottleneck.</li>
    <li><strong>Delta grows with burst size</strong>: RunMQ's processing chain (6-layer processor stack, deserialization, validation) becomes a bottleneck under concurrency.</li>
    <li><strong>Highest-impact optimization</strong>: if Phase 1 shows &lt;0.5ms total CPU overhead, the 9.5ms is almost entirely AMQP/TCP. Passing <code>{ noDelay: true }</code> to <code>amqp.connect()</code> (disabling Nagle's algorithm) is the single highest-leverage change.</li>
  </ul>
</div>

<script>
const micro = ${microJson};
const sweep = ${sweepJson};

// ── Phase 1 table ──
const microBody = document.getElementById('micro-body');
const combinedNames = ['Combined publish pipeline', 'Combined consume pipeline'];
let totalMeanNs = 0;

for (const row of micro) {
  const isCombined = combinedNames.includes(row.name);
  if (isCombined) totalMeanNs += row.meanNs;
  microBody.innerHTML += \`
    <tr>
      <td class="\${isCombined ? 'combined' : ''}">\${row.name}\${isCombined ? ' ★' : ''}</td>
      <td class="num \${isCombined ? 'combined' : ''}">\${row.meanNs.toFixed(1)}</td>
      <td class="num">\${row.stddevNs.toFixed(1)}</td>
    </tr>
  \`;
}

microBody.innerHTML += \`
  <tr style="border-top:2px solid var(--border)">
    <td class="combined">Total in-process overhead (publish ★ + consume ★)</td>
    <td class="num combined">\${totalMeanNs.toFixed(1)}</td>
    <td class="num combined">\${(totalMeanNs / 1_000_000).toFixed(4)} ms</td>
  </tr>
\`;

// ── Phase 2 chart ──
const labels = sweep.runmq.levels.map(l => \`burst=\${l.burstSize}\`);
const runmqMean = sweep.runmq.levels.map(l => l.meanMs);
const runmqP99  = sweep.runmq.levels.map(l => l.p99Ms);
const rawMean   = sweep.raw.levels.map(l => l.meanMs);
const rawP99    = sweep.raw.levels.map(l => l.p99Ms);
const delta     = sweep.runmq.levels.map((l, i) =>
  parseFloat((l.meanMs - sweep.raw.levels[i].meanMs).toFixed(3))
);

const ctx = document.getElementById('sweep-chart').getContext('2d');
new Chart(ctx, {
  type: 'line',
  data: {
    labels,
    datasets: [
      { label: 'RunMQ mean',    data: runmqMean, borderColor: '#6366f1', backgroundColor: '#6366f122', borderWidth: 2, tension: 0.3, pointRadius: 5, fill: false },
      { label: 'RunMQ p99',     data: runmqP99,  borderColor: '#6366f1', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], tension: 0.3, pointRadius: 4, fill: false },
      { label: 'Raw AMQP mean', data: rawMean,   borderColor: '#10b981', backgroundColor: '#10b98122', borderWidth: 2, tension: 0.3, pointRadius: 5, fill: false },
      { label: 'Raw AMQP p99',  data: rawP99,    borderColor: '#10b981', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], tension: 0.3, pointRadius: 4, fill: false },
      { label: 'Delta (RunMQ − Raw)', data: delta, borderColor: '#f59e0b', backgroundColor: '#f59e0b22', borderWidth: 2, tension: 0.3, pointRadius: 5, fill: true },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, labels: { color: '#94a3b8', usePointStyle: true } },
      tooltip: {
        callbacks: { label: (ctx) => \`\${ctx.dataset.label}: \${ctx.parsed.y} ms\` },
      },
    },
    scales: {
      x: { ticks: { color: '#94a3b8' }, grid: { color: '#33415522' } },
      y: {
        beginAtZero: true,
        ticks: { color: '#94a3b8', callback: (v) => v + ' ms' },
        grid: { color: '#33415522' },
      },
    },
  },
});

// ── Phase 2 table ──
const sweepBody = document.getElementById('sweep-body');
sweep.runmq.levels.forEach((r, i) => {
  const raw = sweep.raw.levels[i];
  const d = (r.meanMs - raw.meanMs).toFixed(3);
  sweepBody.innerHTML += \`
    <tr>
      <td>\${r.burstSize}</td>
      <td class="num">\${r.meanMs} ±\${r.stddevMs} ms</td>
      <td class="num">\${r.p50Ms} ms</td>
      <td class="num">\${r.p95Ms} ms</td>
      <td class="num">\${r.p99Ms} ms</td>
      <td class="num">\${raw.meanMs} ±\${raw.stddevMs} ms</td>
      <td class="num">\${raw.p99Ms} ms</td>
      <td class="num" style="color:var(--delta);font-weight:600">\${d} ms</td>
    </tr>
  \`;
});
</script>
</body>
</html>`;

  const outDir = join(__dirname, '..', '..', 'results');
  try { mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
  const outPath = join(outDir, 'latency-report.html');
  writeFileSync(outPath, html, 'utf-8');
  return outPath;
}
```

- [ ] **Step 2: Verify compilation**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/latency/latency-report.ts
git commit -m "feat: add latency HTML report generator"
```

---

### Task 6: Entry point orchestrator + integration test

**Files:**
- Modify: `benchmark-repo/src/latency.ts` (replace the Phase-1-only smoke-test from Task 3 with the full orchestrator)

Orchestrates: setup adapters → Phase 1 (no network) → Phase 2 (requires RabbitMQ) → generate report → teardown. Prints formatted terminal tables for both phases.

- [ ] **Step 1: Replace `src/latency.ts` with the full orchestrator**

```typescript
import { RunMQAdapter } from './adapters/runmq.js';
import { RawAmqplibAdapter } from './latency/raw-amqplib-adapter.js';
import { getConfig, forceGC, sleep } from './types.js';
import { runMicro } from './latency/micro.js';
import type { MicroResult } from './latency/micro.js';
import { runConcurrencySweep } from './latency/concurrency.js';
import type { ConcurrencySweepResult } from './latency/concurrency.js';
import { generateLatencyReport } from './latency/latency-report.js';

// ─────────────────────────────────────────
// Terminal formatters
// ─────────────────────────────────────────

function printMicro(results: MicroResult[]): void {
  console.log('');
  console.log('Phase 1: Micro-benchmarks (CPU only, no network)');
  console.log('─'.repeat(62));
  for (const r of results) {
    const name = r.name.padEnd(42);
    const m = `${r.meanNs.toFixed(1).padStart(8)} ns`;
    const sd = `± ${r.stddevNs.toFixed(1).padStart(7)} ns`;
    console.log(`  ${name} ${m}  ${sd}`);
  }
  const pub = results.find(r => r.name === 'Combined publish pipeline');
  const con = results.find(r => r.name === 'Combined consume pipeline');
  if (pub && con) {
    const total = pub.meanNs + con.meanNs;
    console.log('─'.repeat(62));
    console.log(`  ${'Total in-process overhead'.padEnd(42)} ${total.toFixed(1).padStart(8)} ns`);
    console.log(`  → ${(total / 1_000_000).toFixed(4)} ms of the e2e latency is pure RunMQ CPU work`);
  }
  console.log('');
}

function printSweep(sweep: ConcurrencySweepResult): void {
  console.log('Phase 2: Burst Concurrency Sweep (RunMQ vs Raw AMQP)');
  console.log('─'.repeat(78));
  console.log('  Burst │ RunMQ mean±σ           │  p99    │ Raw mean±σ             │  p99    │ Delta');
  console.log('  ──────┼───────────────────────┼─────────┼───────────────────────┼─────────┼──────');
  for (let i = 0; i < sweep.runmq.levels.length; i++) {
    const r = sweep.runmq.levels[i];
    const raw = sweep.raw.levels[i];
    const delta = (r.meanMs - raw.meanMs).toFixed(3);
    const runmqCell = `${r.meanMs}±${r.stddevMs} ms`.padEnd(21);
    const rawCell = `${raw.meanMs}±${raw.stddevMs} ms`.padEnd(21);
    console.log(
      `  ${String(r.burstSize).padStart(5)} │ ${runmqCell} │ ${String(r.p99Ms).padStart(7)} │ ${rawCell} │ ${String(raw.p99Ms).padStart(7)} │ ${delta} ms`,
    );
  }
  console.log('');
}

// ─────────────────────────────────────────
// Main
// ─────────────────────────────────────────

async function main(): Promise<void> {
  const config = getConfig();
  const timestamp = new Date().toISOString();

  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║       RunMQ Latency Analysis Suite            ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
  console.log(`RabbitMQ: ${config.rabbitmqUrl}`);
  console.log(`GC:       ${global.gc ? 'enabled (--expose-gc)' : 'DISABLED — results may be noisier'}`);
  console.log('');

  // ── Phase 1: CPU micro-benchmarks — no network required ──
  console.log('Running Phase 1 (no network required)...');
  forceGC();
  const micro = runMicro();
  printMicro(micro);

  // ── Phase 2: Burst concurrency sweep — requires RabbitMQ ──
  console.log('Running Phase 2 (requires RabbitMQ)...');
  const runmqAdapter = new RunMQAdapter(config.rabbitmqUrl);
  const rawAdapter = new RawAmqplibAdapter(config.rabbitmqUrl);

  await runmqAdapter.setup();
  await rawAdapter.setup();

  forceGC();
  await sleep(500);

  const sweep = await runConcurrencySweep(runmqAdapter, rawAdapter);
  printSweep(sweep);

  try { await runmqAdapter.teardown(); } catch { /* ignore */ }
  try { await rawAdapter.teardown(); } catch { /* ignore */ }

  // ── Report ──
  console.log('Generating latency report...');
  const reportPath = generateLatencyReport(micro, sweep, timestamp);
  console.log(`Report saved: ${reportPath}`);
  console.log('');
  console.log('Done!');
}

main().catch((err) => {
  console.error('Latency suite failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify full compilation**

```bash
npm run build
```

Expected: exits 0, `dist/latency.js` present.

- [ ] **Step 3: Integration test — run against Docker**

Start RabbitMQ:
```bash
docker run -d --rm --name rabbit-latency -p 5672:5672 rabbitmq:3-alpine
sleep 5
```

Run the full suite:
```bash
npm run latency
```

**Expected terminal output:**
- Header box prints
- Phase 1 table: 8 rows of ns values, all positive, combined publish pipeline likely 150–500 ns
- "Total in-process overhead X ns → Y ms of the e2e..."
- Phase 2: 5 burst levels × 2 adapters print progress lines
- Final summary table prints
- "Report saved: .../results/latency-report.html"

**Verify report renders:**
```bash
open results/latency-report.html
```
Expected: dark page loads, micro table visible with ★ combined rows, line chart renders 5 series.

Stop RabbitMQ:
```bash
docker stop rabbit-latency
```

- [ ] **Step 4: Commit**

```bash
git add src/latency.ts
git commit -m "feat: complete latency suite orchestrator and integration"
```
