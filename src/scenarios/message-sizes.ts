// ============================================================================
// Scenario: Message Sizes
// ============================================================================
// Measures how payload size affects publish and consume throughput.
// Tests 100B, 1KB, 10KB. Both libraries receive byte-identical payloads.
// Publish uses publishBatch (addBulk for BullMQ, loop for RunMQ).
//
// CONFIG:
//   Both: 5,000 messages per size, concurrency=1, batch size=500
// ============================================================================

import type { QueueAdapter, ScenarioResult } from '../types.js';
import { generatePayload, forceGC, sleep } from '../types.js';

const BATCH_SIZE = 500;
const SIZES = [
  { label: '100B', bytes: 100, pubCount: 500_000, conCount: 100_000 },
  { label: '1KB', bytes: 1_024, pubCount: 500_000, conCount: 100_000 },
  { label: '10KB', bytes: 10_240, pubCount: 150_000, conCount: 50_000 },
];

async function runPublish(
  adapter: QueueAdapter,
  sizeBytes: number,
  totalMessages: number,
  topicSuffix: string,
): Promise<number> {
  const topic = `bench-size-pub-${topicSuffix}-${sizeBytes}`;
  await adapter.purge(topic);

  // Generate per-batch to avoid OOM on large payloads
  const start = performance.now();
  for (let i = 0; i < totalMessages; i += BATCH_SIZE) {
    const batch = Array.from({ length: Math.min(BATCH_SIZE, totalMessages - i) }, () => generatePayload(sizeBytes));
    await adapter.publishBatch(topic, batch);
  }
  const elapsed = performance.now() - start;

  await adapter.purge(topic);
  return (totalMessages / elapsed) * 1000;
}

async function runConsume(
  adapter: QueueAdapter,
  sizeBytes: number,
  totalMessages: number,
  topicSuffix: string,
): Promise<number> {
  const topic = `bench-size-con-${topicSuffix}-${sizeBytes}`;
  await adapter.purge(topic);

  let consumed = 0;
  let firstConsumedAt = 0;
  let lastConsumedAt = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  await adapter.startConsumer(topic, 1, async () => {
    const now = performance.now();
    if (consumed === 0) firstConsumedAt = now;
    consumed++;
    lastConsumedAt = now;
    if (consumed >= totalMessages) resolveDone();
  });

  await sleep(500);

  for (let i = 0; i < totalMessages; i += BATCH_SIZE) {
    const batch = Array.from({ length: Math.min(BATCH_SIZE, totalMessages - i) }, () => generatePayload(sizeBytes));
    await adapter.publishBatch(topic, batch);
  }

  const timeout = setTimeout(() => {
    console.log(`    WARNING: Only consumed ${consumed}/${totalMessages}`);
    resolveDone();
  }, 120_000);
  await done;
  clearTimeout(timeout);

  const elapsed = lastConsumedAt - firstConsumedAt;
  await adapter.stopConsumer();
  await adapter.purge(topic);

  return elapsed > 0 ? (consumed / elapsed) * 1000 : 0;
}

export async function run(
  runmq: QueueAdapter,
  bullmq: QueueAdapter,
): Promise<ScenarioResult> {
  const metrics: ScenarioResult['metrics'] = {};

  for (const { label, bytes, pubCount, conCount } of SIZES) {
    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} publish (${pubCount.toLocaleString()} msgs) — RunMQ...`);
    const runmqPub = await runPublish(runmq, bytes, pubCount, 'runmq');

    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} publish (${pubCount.toLocaleString()} msgs) — BullMQ...`);
    const bullmqPub = await runPublish(bullmq, bytes, pubCount, 'bullmq');

    metrics[`Publish ${label}`] = {
      runmq: { value: Math.round(runmqPub), unit: 'msg/s' },
      bullmq: { value: Math.round(bullmqPub), unit: 'msg/s' },
    };

    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} consume (${conCount.toLocaleString()} msgs) — RunMQ...`);
    const runmqCon = await runConsume(runmq, bytes, conCount, 'runmq');

    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} consume (${conCount.toLocaleString()} msgs) — BullMQ...`);
    const bullmqCon = await runConsume(bullmq, bytes, conCount, 'bullmq');

    metrics[`Consume ${label}`] = {
      runmq: { value: Math.round(runmqCon), unit: 'msg/s' },
      bullmq: { value: Math.round(bullmqCon), unit: 'msg/s' },
    };
  }

  return {
    scenario: 'Message Sizes',
    description: 'Publish and consume throughput across different payload sizes (100B, 1KB, 10KB). Both use batch publishing.',
    metrics,
  };
}
