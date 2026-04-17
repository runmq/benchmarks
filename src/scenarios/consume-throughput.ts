// ============================================================================
// Scenario: Consume Throughput
// ============================================================================
// Measures how many messages each library can consume per second with a
// single consumer and a no-op handler.
//
// Consumer is started BEFORE publishing (required for RabbitMQ queue binding).
// Throughput measured from first-consumed to last-consumed (excludes publish).
// Includes a 100-message warmup to prime consumer code paths.
//
// CONFIG:
//   RunMQ:  consumersCount=1, default prefetch, durable queue
//   BullMQ: concurrency=1, skipStalledCheck, skipLockRenewal, drainDelay=1
//   Both:   100-byte JSON payload, 10,000 messages
// ============================================================================

import type { QueueAdapter, ScenarioResult } from '../types.js';
import { generatePayload, forceGC, sleep } from '../types.js';

const TOTAL_MESSAGES = 100_000;
const WARMUP = 100;
const TOPIC_RUNMQ = 'bench-consume-runmq';
const TOPIC_BULLMQ = 'bench-consume-bullmq';

async function runFor(
  adapter: QueueAdapter,
  topic: string,
): Promise<number> {
  await adapter.purge(topic);

  // Warmup — prime consumer JIT and code paths
  let warmupCount = 0;
  let warmupDone: () => void = () => {};
  const warmupPromise = new Promise<void>((r) => { warmupDone = r; });

  await adapter.startConsumer(topic, 1, async () => {
    warmupCount++;
    if (warmupCount >= WARMUP) warmupDone();
  });
  await sleep(300);

  const warmupMsgs = Array.from({ length: WARMUP }, () => generatePayload(100));
  await adapter.publishBatch(topic, warmupMsgs);
  await warmupPromise;
  await adapter.stopConsumer();
  await adapter.purge(topic);

  // Actual measurement
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

  console.log(`    Publishing ${TOTAL_MESSAGES} messages...`);
  for (let i = 0; i < TOTAL_MESSAGES; i += 500) {
    const batch = Array.from({ length: Math.min(500, TOTAL_MESSAGES - i) }, () => generatePayload(100));
    await adapter.publishBatch(topic, batch);
  }

  const timeout = setTimeout(() => {
    console.log(`    WARNING: Only consumed ${consumed}/${TOTAL_MESSAGES}, proceeding...`);
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
  forceGC();
  await sleep(1000);
  console.log('  [consume-throughput] Running RunMQ...');
  const runmqResult = await runFor(runmq, TOPIC_RUNMQ);

  forceGC();
  await sleep(1000);
  console.log('  [consume-throughput] Running BullMQ...');
  const bullmqResult = await runFor(bullmq, TOPIC_BULLMQ);

  return {
    scenario: 'Consume Throughput',
    description: 'Messages consumed per second with a single no-op consumer. Measured from first to last message consumed (excludes publish time). Includes consumer warmup.',
    metrics: {
      'Messages/sec': {
        runmq: { value: Math.round(runmqResult), unit: 'msg/s' },
        bullmq: { value: Math.round(bullmqResult), unit: 'msg/s' },
      },
    },
  };
}
