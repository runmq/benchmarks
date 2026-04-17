// ============================================================================
// Scenario: Reliability Overhead
// ============================================================================
// Measures performance cost of enabling retries (3 attempts, 100ms delay).
// Uses raw APIs to configure retry-specific options.
// No messages are intentionally failed — measures configuration overhead only.
//
// CONFIG:
//   RunMQ:  consumersCount=1, attempts=3, attemptsDelay=100ms
//   BullMQ: concurrency=1, attempts=3, backoff=fixed/100ms, all optimizations
//   Both:   100-byte JSON payload, 5,000 messages
// ============================================================================

import { RunMQ } from 'runmq';
import { Queue, Worker } from 'bullmq';
import type { ScenarioResult, BenchmarkConfig } from '../types.js';
import { generatePayload, forceGC, sleep } from '../types.js';

const TOTAL_MESSAGES = 50_000;
const noop = () => {};
const silentLogger = {
  log: noop, error: noop, warn: noop, info: noop, debug: noop, verbose: noop,
};

async function runRunMQ(
  config: BenchmarkConfig,
  topic: string,
  processorConfig: { name: string; consumersCount: number; attempts?: number; attemptsDelay?: number },
): Promise<number> {
  const instance = await RunMQ.start({ url: config.rabbitmqUrl }, silentLogger);

  let consumed = 0;
  let firstAt = 0;
  let lastAt = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  await instance.process(topic, processorConfig, async () => {
    const now = performance.now();
    if (consumed === 0) firstAt = now;
    consumed++;
    lastAt = now;
    if (consumed >= TOTAL_MESSAGES) resolveDone();
  });

  await sleep(500);

  for (let i = 0; i < TOTAL_MESSAGES; i++) {
    instance.publish(topic, generatePayload(100));
  }

  const timeout = setTimeout(() => resolveDone(), 120_000);
  await done;
  clearTimeout(timeout);

  const elapsed = lastAt - firstAt;
  await instance.disconnect();
  return elapsed > 0 ? (TOTAL_MESSAGES / elapsed) * 1000 : 0;
}

async function runBullMQ(
  config: BenchmarkConfig,
  topic: string,
  jobOpts: { attempts?: number; backoff?: { type: string; delay: number } },
): Promise<number> {
  const conn = { host: config.redisHost, port: config.redisPort };

  const queue = new Queue(topic, {
    connection: conn,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
  await queue.obliterate({ force: true }).catch(() => {});

  let consumed = 0;
  let firstAt = 0;
  let lastAt = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  const worker = new Worker(topic, async () => {
    const now = performance.now();
    if (consumed === 0) firstAt = now;
    consumed++;
    lastAt = now;
    if (consumed >= TOTAL_MESSAGES) resolveDone();
  }, {
    connection: conn,
    concurrency: 1,
    skipStalledCheck: true,
    skipLockRenewal: true,
    drainDelay: 1,
  });

  await worker.waitUntilReady();

  // Use addBulk for batch publishing
  const messages = Array.from({ length: TOTAL_MESSAGES }, () => generatePayload(100));
  const BATCH = 500;
  for (let i = 0; i < TOTAL_MESSAGES; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    await queue.addBulk(batch.map(data => ({ name: topic, data, opts: { ...jobOpts } })));
  }

  const timeout = setTimeout(() => resolveDone(), 120_000);
  await done;
  clearTimeout(timeout);

  const elapsed = lastAt - firstAt;
  await worker.close();
  await queue.close();
  return elapsed > 0 ? (TOTAL_MESSAGES / elapsed) * 1000 : 0;
}

export async function run(
  _runmq: unknown,
  _bullmq: unknown,
  config: BenchmarkConfig,
): Promise<ScenarioResult> {
  forceGC();
  await sleep(1000);
  console.log('  [reliability] RunMQ basic...');
  const runmqBasic = await runRunMQ(config, 'bench-rel-rmq-basic', {
    name: 'bench-basic', consumersCount: 1,
  });

  forceGC();
  await sleep(1000);
  console.log('  [reliability] RunMQ with retries...');
  const runmqRetry = await runRunMQ(config, 'bench-rel-rmq-retry', {
    name: 'bench-retry', consumersCount: 1, attempts: 3, attemptsDelay: 100,
  });

  forceGC();
  await sleep(1000);
  console.log('  [reliability] BullMQ basic...');
  const bullmqBasic = await runBullMQ(config, 'bench-rel-bmq-basic', {});

  forceGC();
  await sleep(1000);
  console.log('  [reliability] BullMQ with retries...');
  const bullmqRetry = await runBullMQ(config, 'bench-rel-bmq-retry', {
    attempts: 3, backoff: { type: 'fixed', delay: 100 },
  });

  return {
    scenario: 'Reliability Overhead',
    description: 'Performance cost of enabling retries (3 attempts, 100ms delay). No messages intentionally failed — measures configuration overhead only.',
    metrics: {
      'Basic (no retries)': {
        runmq: { value: Math.round(runmqBasic), unit: 'msg/s' },
        bullmq: { value: Math.round(bullmqBasic), unit: 'msg/s' },
      },
      'With Retries (3 attempts)': {
        runmq: { value: Math.round(runmqRetry), unit: 'msg/s' },
        bullmq: { value: Math.round(bullmqRetry), unit: 'msg/s' },
      },
    },
  };
}
