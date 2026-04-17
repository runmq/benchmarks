// ============================================================================
// Scenario: Publish Throughput
// ============================================================================
// Measures how many messages each library can publish per second using its
// optimal bulk publishing mechanism:
//   RunMQ:  tight loop of sync publish() — amqplib batches into TCP writes
//   BullMQ: addBulk() — single Redis pipeline per batch
//
// Both libraries use their recommended high-throughput publishing pattern.
// Messages are published in batches of 500.
//
// CONFIG:
//   RunMQ:  loop of publish(), default durable exchange
//   BullMQ: addBulk() in batches of 500, removeOnComplete: true
//   Both:   100-byte JSON payload, 100-message warmup, GC before each run
// ============================================================================

import type { QueueAdapter, ScenarioResult } from '../types.js';
import { generatePayload, forceGC, sleep } from '../types.js';

const TOTAL_MESSAGES = 100_000;
const BATCH_SIZE = 500;
const WARMUP = 100;
const TOPIC = 'bench-publish';

async function runFor(adapter: QueueAdapter): Promise<number> {
  await adapter.purge(TOPIC);

  // Warmup
  const warmupMsgs = Array.from({ length: WARMUP }, () => generatePayload(100));
  await adapter.publishBatch(TOPIC, warmupMsgs);
  await sleep(500);
  forceGC();

  // Pre-generate all payloads so generation time doesn't affect measurement
  const messages = Array.from({ length: TOTAL_MESSAGES }, () => generatePayload(100));

  // Timed run — publish in batches
  const start = performance.now();
  for (let i = 0; i < TOTAL_MESSAGES; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    await adapter.publishBatch(TOPIC, batch);
  }
  const elapsed = performance.now() - start;

  await adapter.purge(TOPIC);
  return (TOTAL_MESSAGES / elapsed) * 1000;
}

export async function run(
  runmq: QueueAdapter,
  bullmq: QueueAdapter,
): Promise<ScenarioResult> {
  forceGC();
  await sleep(1000);
  console.log('  [publish-throughput] Running RunMQ...');
  const runmqResult = await runFor(runmq);

  forceGC();
  await sleep(1000);
  console.log('  [publish-throughput] Running BullMQ...');
  const bullmqResult = await runFor(bullmq);

  return {
    scenario: 'Publish Throughput',
    description: 'Messages published per second using each library\'s optimal bulk pattern. RunMQ: loop of sync publish() with TCP batching. BullMQ: addBulk() with Redis pipelines.',
    metrics: {
      'Messages/sec': {
        runmq: { value: Math.round(runmqResult), unit: 'msg/s' },
        bullmq: { value: Math.round(bullmqResult), unit: 'msg/s' },
      },
    },
  };
}
