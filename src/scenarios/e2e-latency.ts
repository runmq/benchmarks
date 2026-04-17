// ============================================================================
// Scenario: End-to-End Latency
// ============================================================================
// Measures user-observable latency: time from calling the publish API to the
// consumer handler firing.
//
// The "sent" timestamp is captured BEFORE the publish call for both libraries.
// This is the only symmetric measurement point — both are measured identically:
//   sentAt = performance.now()
//   await adapter.publish(...)
//   ... broker delivers ...
//   receivedAt = performance.now()   // in consumer handler
//   latency = receivedAt - sentAt
//
// What this includes for each library:
//   RunMQ:  publish buffer write (~0ms) + TCP transit + broker routing + push
//   BullMQ: Redis write round-trip (~0.5ms) + worker BRPOP pickup
//
// Both include their full delivery cost. This is the latency a user actually
// experiences when calling each library's API.
//
// Messages are published one at a time with 5ms inter-message delay to
// avoid burst-queueing effects. Both libraries get the same delay.
//
// CONFIG:
//   RunMQ:  consumersCount=1, default prefetch
//   BullMQ: concurrency=1, skipStalledCheck, skipLockRenewal
//   Both:   100-byte JSON payload, 1,000 messages, 5ms inter-message delay
// ============================================================================

import type { QueueAdapter, ScenarioResult } from '../types.js';
import { generatePayload, percentile, forceGC, sleep } from '../types.js';

const TOTAL_MESSAGES = 1_000;
const INTER_MESSAGE_DELAY_MS = 5;
const TOPIC_RUNMQ = 'bench-latency-runmq';
const TOPIC_BULLMQ = 'bench-latency-bullmq';

interface LatencyResult {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

async function runFor(
  adapter: QueueAdapter,
  topic: string,
): Promise<LatencyResult> {
  await adapter.purge(topic);
  const latencies: number[] = [];
  const sentTimestamps: number[] = [];
  let consumed = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  // Start consumer first
  await adapter.startConsumer(topic, 1, async (msg) => {
    const received = performance.now();
    const data = msg as Record<string, unknown>;
    const idx = data._benchIdx as number;
    if (typeof idx === 'number' && sentTimestamps[idx] !== undefined) {
      latencies.push(received - sentTimestamps[idx]);
    }
    consumed++;
    if (consumed >= TOTAL_MESSAGES) resolveDone();
  });

  await sleep(500);

  // Publish with index — timestamp captured BEFORE publish call (symmetric)
  for (let i = 0; i < TOTAL_MESSAGES; i++) {
    const payload = { ...generatePayload(100), _benchIdx: i };
    sentTimestamps.push(performance.now());
    await adapter.publish(topic, payload);
    await sleep(INTER_MESSAGE_DELAY_MS);
  }

  const timeout = setTimeout(() => {
    console.log(`    WARNING: Only consumed ${consumed}/${TOTAL_MESSAGES}`);
    resolveDone();
  }, 60_000);
  await done;
  clearTimeout(timeout);

  await adapter.stopConsumer();
  await adapter.purge(topic);

  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    mean: latencies.length > 0 ? sum / latencies.length : 0,
    p50: latencies.length > 0 ? percentile(latencies, 50) : 0,
    p95: latencies.length > 0 ? percentile(latencies, 95) : 0,
    p99: latencies.length > 0 ? percentile(latencies, 99) : 0,
  };
}

export async function run(
  runmq: QueueAdapter,
  bullmq: QueueAdapter,
): Promise<ScenarioResult> {
  forceGC();
  await sleep(1000);
  console.log('  [e2e-latency] Running RunMQ...');
  const runmqResult = await runFor(runmq, TOPIC_RUNMQ);

  forceGC();
  await sleep(1000);
  console.log('  [e2e-latency] Running BullMQ...');
  const bullmqResult = await runFor(bullmq, TOPIC_BULLMQ);

  return {
    scenario: 'End-to-End Latency',
    description: 'User-observable latency: time from calling publish API to consumer handler firing. Both measured identically — timestamp before publish call. Lower is better.',
    metrics: {
      'Mean Latency': {
        runmq: { value: parseFloat(runmqResult.mean.toFixed(2)), unit: 'ms' },
        bullmq: { value: parseFloat(bullmqResult.mean.toFixed(2)), unit: 'ms' },
      },
      'P50 Latency': {
        runmq: { value: parseFloat(runmqResult.p50.toFixed(2)), unit: 'ms' },
        bullmq: { value: parseFloat(bullmqResult.p50.toFixed(2)), unit: 'ms' },
      },
      'P95 Latency': {
        runmq: { value: parseFloat(runmqResult.p95.toFixed(2)), unit: 'ms' },
        bullmq: { value: parseFloat(bullmqResult.p95.toFixed(2)), unit: 'ms' },
      },
      'P99 Latency': {
        runmq: { value: parseFloat(runmqResult.p99.toFixed(2)), unit: 'ms' },
        bullmq: { value: parseFloat(bullmqResult.p99.toFixed(2)), unit: 'ms' },
      },
    },
  };
}
