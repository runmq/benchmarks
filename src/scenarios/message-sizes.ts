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

const TOTAL_MESSAGES = 50_000;
const BATCH_SIZE = 500;
const SIZES = [
  { label: '100B', bytes: 100 },
  { label: '1KB', bytes: 1_024 },
  { label: '10KB', bytes: 10_240 },
];

async function runPublish(
  adapter: QueueAdapter,
  sizeBytes: number,
  topicSuffix: string,
): Promise<number> {
  const topic = `bench-size-pub-${topicSuffix}-${sizeBytes}`;
  await adapter.purge(topic);

  const messages = Array.from({ length: TOTAL_MESSAGES }, () => generatePayload(sizeBytes));

  const start = performance.now();
  for (let i = 0; i < TOTAL_MESSAGES; i += BATCH_SIZE) {
    await adapter.publishBatch(topic, messages.slice(i, i + BATCH_SIZE));
  }
  const elapsed = performance.now() - start;

  await adapter.purge(topic);
  return (TOTAL_MESSAGES / elapsed) * 1000;
}

async function runConsume(
  adapter: QueueAdapter,
  sizeBytes: number,
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
    if (consumed >= TOTAL_MESSAGES) resolveDone();
  });

  await sleep(500);

  const messages = Array.from({ length: TOTAL_MESSAGES }, () => generatePayload(sizeBytes));
  for (let i = 0; i < TOTAL_MESSAGES; i += BATCH_SIZE) {
    await adapter.publishBatch(topic, messages.slice(i, i + BATCH_SIZE));
  }

  const timeout = setTimeout(() => {
    console.log(`    WARNING: Only consumed ${consumed}/${TOTAL_MESSAGES}`);
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

  for (const { label, bytes } of SIZES) {
    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} publish — RunMQ...`);
    const runmqPub = await runPublish(runmq, bytes, 'runmq');

    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} publish — BullMQ...`);
    const bullmqPub = await runPublish(bullmq, bytes, 'bullmq');

    metrics[`Publish ${label}`] = {
      runmq: { value: Math.round(runmqPub), unit: 'msg/s' },
      bullmq: { value: Math.round(bullmqPub), unit: 'msg/s' },
    };

    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} consume — RunMQ...`);
    const runmqCon = await runConsume(runmq, bytes, 'runmq');

    forceGC();
    await sleep(1000);
    console.log(`  [message-sizes] ${label} consume — BullMQ...`);
    const bullmqCon = await runConsume(bullmq, bytes, 'bullmq');

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
