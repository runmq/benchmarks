// ============================================================================
// Shared types, utilities, and fairness helpers for the benchmark suite.
// ============================================================================

export interface QueueAdapter {
  readonly name: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;

  /**
   * Publish a single message.
   */
  publish(topic: string, message: Record<string, unknown>): Promise<void> | void;

  /**
   * Publish a batch of messages using each library's optimal bulk mechanism.
   *   RunMQ:  tight loop of sync publish() — amqplib batches into TCP writes
   *   BullMQ: queue.addBulk() — single Redis pipeline for the entire batch
   */
  publishBatch(topic: string, messages: Record<string, unknown>[]): Promise<void>;

  startConsumer(
    topic: string,
    concurrency: number,
    onMessage: (msg: unknown) => Promise<void>,
  ): Promise<void>;
  stopConsumer(): Promise<void>;

  /** Remove all messages from a topic so the next scenario starts clean. */
  purge(topic: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  scenario: string;
  description: string;
  metrics: Record<string, MetricGroup>;
}

export interface MetricGroup {
  runmq: MetricValue;
  bullmq: MetricValue;
}

export interface MetricValue {
  value: number;
  unit: string;
  stddev?: number;
}

export interface BenchmarkConfig {
  rabbitmqUrl: string;
  redisHost: string;
  redisPort: number;
}

export function getConfig(): BenchmarkConfig {
  return {
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  };
}

// ---------------------------------------------------------------------------
// Payload generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic JSON payload of approximately `sizeBytes`.
 * Both libraries receive byte-identical payloads.
 */
export function generatePayload(sizeBytes: number): Record<string, unknown> {
  const base = { ts: Date.now(), id: Math.random().toString(36).slice(2) };
  const baseSize = Buffer.byteLength(JSON.stringify(base));
  const remaining = Math.max(0, sizeBytes - baseSize - 15);
  return { ...base, pad: 'x'.repeat(remaining) };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stddev(values: number[]): number {
  const avg = mean(values);
  const squareDiffs = values.map(v => (v - avg) ** 2);
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Fairness utilities
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Force a full garbage collection cycle.
 * Requires Node.js to be started with --expose-gc.
 *
 * Called before EACH library's run so both start with a clean heap.
 */
export function forceGC(): void {
  if (global.gc) {
    global.gc();
    global.gc();
  }
}
