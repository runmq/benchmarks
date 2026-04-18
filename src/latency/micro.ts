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
