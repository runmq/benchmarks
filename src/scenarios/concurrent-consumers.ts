// ============================================================================
// Scenario: Concurrent Consumers
// ============================================================================
// Measures how consumption throughput scales with 1, 2, 4, 8 consumers.
// Each handler does a 1ms async delay to simulate minimal work.
//
// CONFIG:
//   RunMQ:  consumersCount=N (N AMQP channels)
//   BullMQ: concurrency=N (N concurrent processors)
//   Both:   100-byte JSON payload, 5,000 messages per level, 1ms simulated work
// ============================================================================

import type { QueueAdapter, ScenarioResult } from '../types.js';
import { generatePayload, forceGC, sleep } from '../types.js';

const TOTAL_MESSAGES = 10_000;
const CONCURRENCY_LEVELS = [1, 2, 4, 8];

async function runFor(
  adapter: QueueAdapter,
  concurrency: number,
  topicSuffix: string,
): Promise<number> {
  const topic = `bench-concurrent-${topicSuffix}-c${concurrency}`;
  await adapter.purge(topic);

  let consumed = 0;
  let firstConsumedAt = 0;
  let lastConsumedAt = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  await adapter.startConsumer(topic, concurrency, async () => {
    await new Promise((r) => setTimeout(r, 1));
    const now = performance.now();
    if (consumed === 0) firstConsumedAt = now;
    consumed++;
    lastConsumedAt = now;
    if (consumed >= TOTAL_MESSAGES) resolveDone();
  });

  await sleep(500);

  const messages = Array.from({ length: TOTAL_MESSAGES }, () => generatePayload(100));
  for (let i = 0; i < TOTAL_MESSAGES; i += 500) {
    await adapter.publishBatch(topic, messages.slice(i, i + 500));
  }

  const timeout = setTimeout(() => {
    console.log(`    WARNING: Only consumed ${consumed}/${TOTAL_MESSAGES} at concurrency=${concurrency}`);
    resolveDone();
  }, 120_000);
  await done;
  clearTimeout(timeout);

  const elapsed = lastConsumedAt - firstConsumedAt;
  await adapter.stopConsumer();
  await adapter.purge(topic);

  return elapsed > 0 ? (TOTAL_MESSAGES / elapsed) * 1000 : 0;
}

export async function run(
  runmq: QueueAdapter,
  bullmq: QueueAdapter,
): Promise<ScenarioResult> {
  const metrics: ScenarioResult['metrics'] = {};

  for (const c of CONCURRENCY_LEVELS) {
    forceGC();
    await sleep(1000);
    console.log(`  [concurrent-consumers] Concurrency=${c} — RunMQ...`);
    const runmqResult = await runFor(runmq, c, 'runmq');

    forceGC();
    await sleep(1000);
    console.log(`  [concurrent-consumers] Concurrency=${c} — BullMQ...`);
    const bullmqResult = await runFor(bullmq, c, 'bullmq');

    metrics[`${c} Consumer${c > 1 ? 's' : ''}`] = {
      runmq: { value: Math.round(runmqResult), unit: 'msg/s' },
      bullmq: { value: Math.round(bullmqResult), unit: 'msg/s' },
    };
  }

  return {
    scenario: 'Concurrent Consumers',
    description: 'Consumption throughput scaling with 1, 2, 4, 8 concurrent consumers. Each handler simulates 1ms of work.',
    metrics,
  };
}
