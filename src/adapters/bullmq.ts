// ============================================================================
// BullMQ Adapter — Maximum Performance Configuration
// ============================================================================
// Wraps BullMQ (Redis-backed) behind the QueueAdapter interface.
//
// Optimizations applied:
//   - skipStalledCheck: true — disables background Redis polling timer.
//   - skipLockRenewal: true — disables lock renewal timer (jobs complete <1ms).
//   - removeOnComplete/removeOnFail: true — immediate cleanup, reduces Redis
//     memory pressure. Equivalent to RunMQ's message ack removing from queue.
//   - drainDelay: 1 — minimum idle poll delay (0 not allowed by BullMQ).
//   - addBulk() used for batch publishing — single Redis pipeline per batch.
// ============================================================================

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { QueueAdapter } from '../types.js';

export class BullMQAdapter implements QueueAdapter {
  readonly name = 'BullMQ';
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly connection: ConnectionOptions;

  constructor(host: string, port: number) {
    this.connection = { host, port };
  }

  async setup(): Promise<void> {}

  async teardown(): Promise<void> {
    await this.stopConsumer();
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }

  private ensureQueue(topic: string): Queue {
    if (!this.queue) {
      this.queue = new Queue(topic, {
        connection: this.connection,
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: true,
        },
      });
    }
    return this.queue;
  }

  /**
   * Single-message publish — awaits Redis MULTI/EXEC confirmation.
   */
  async publish(topic: string, message: Record<string, unknown>): Promise<void> {
    await this.ensureQueue(topic).add(topic, message);
  }

  /**
   * Batch publish — uses addBulk() for a single Redis pipeline.
   * This is BullMQ's recommended pattern for high-throughput publishing,
   * equivalent to RunMQ's implicit TCP batching via amqplib.
   */
  async publishBatch(topic: string, messages: Record<string, unknown>[]): Promise<void> {
    const queue = this.ensureQueue(topic);
    await queue.addBulk(messages.map(data => ({ name: topic, data })));
  }

  async startConsumer(
    topic: string,
    concurrency: number,
    onMessage: (msg: unknown) => Promise<void>,
  ): Promise<void> {
    this.worker = new Worker(
      topic,
      async (job) => {
        await onMessage(job.data);
      },
      {
        connection: this.connection,
        concurrency,
        skipStalledCheck: true,
        skipLockRenewal: true,
        maxStalledCount: 0,
        drainDelay: 1,
      },
    );

    await this.worker.waitUntilReady();
  }

  async stopConsumer(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }

  async purge(topic: string): Promise<void> {
    const tempQueue = new Queue(topic, { connection: this.connection });
    await tempQueue.obliterate({ force: true }).catch(() => {});
    await tempQueue.close();

    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}
