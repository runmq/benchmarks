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
