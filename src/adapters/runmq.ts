// ============================================================================
// RunMQ Adapter
// ============================================================================
// Wraps RunMQ (RabbitMQ / AMQP) behind the QueueAdapter interface.
//
// Configuration:
//   - Silent logger to isolate queue throughput from I/O overhead.
//   - Default durable exchanges/queues (production-like).
//   - Default prefetch (set in RunMQ's constants).
// ============================================================================

import { RunMQ } from 'runmq';
import type { QueueAdapter } from '../types.js';

const noop = () => {};
const silentLogger = {
  log: noop, error: noop, warn: noop, info: noop, debug: noop, verbose: noop,
};

export class RunMQAdapter implements QueueAdapter {
  readonly name = 'RunMQ';
  private instance: RunMQ | null = null;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async setup(): Promise<void> {
    this.instance = await RunMQ.start({
      url: this.url,
      maxReconnectAttempts: 5,
      reconnectDelay: 2000,
    }, silentLogger);
  }

  async teardown(): Promise<void> {
    if (this.instance) {
      await this.instance.disconnect();
      this.instance = null;
    }
  }

  /**
   * Single-message publish — synchronous, writes to AMQP channel buffer.
   */
  publish(topic: string, message: Record<string, unknown>): void {
    this.instance!.publish(topic, message);
  }

  /**
   * Batch publish — tight loop of sync publish() calls.
   * amqplib automatically batches these into TCP writes.
   */
  async publishBatch(topic: string, messages: Record<string, unknown>[]): Promise<void> {
    for (const msg of messages) {
      this.instance!.publish(topic, msg);
    }
  }

  async startConsumer(
    topic: string,
    concurrency: number,
    onMessage: (msg: unknown) => Promise<void>,
  ): Promise<void> {
    await this.instance!.process(topic, {
      name: `bench-${topic}`,
      consumersCount: concurrency,
    }, async (content) => {
      await onMessage(content.message);
    });
  }

  async stopConsumer(): Promise<void> {
    await this.teardown();
    await this.setup();
  }

  async purge(_topic: string): Promise<void> {
    await this.teardown();
    await this.setup();
  }
}
