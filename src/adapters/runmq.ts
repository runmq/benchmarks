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
    const config = {
      url: this.url,
      maxReconnectAttempts: 5,
      reconnectDelay: 2000,
      ...(process.env.RUNMQ_PUBLISHER_CONFIRMS === 'true' ? { usePublisherConfirms: true } : {}),
    };
    this.instance = await RunMQ.start(config as Parameters<typeof RunMQ.start>[0], silentLogger);
  }

  async teardown(): Promise<void> {
    if (this.instance) {
      await this.instance.disconnect();
      this.instance = null;
    }
  }

  async publish(topic: string, message: Record<string, unknown>): Promise<void> {
    await this.instance!.publish(topic, message);
  }

  // Pipeline the batch: fire all publishes, then Promise.all. Matches what a
  // realistic high-throughput user would write — a tight `await` loop would
  // serialize on the async publish() signature and under-report the ceiling.
  async publishBatch(topic: string, messages: Record<string, unknown>[]): Promise<void> {
    const inst = this.instance!;
    const pending: Promise<void>[] = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) {
      pending[i] = Promise.resolve(inst.publish(topic, messages[i]));
    }
    await Promise.all(pending);
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
