import amqp from 'amqplib';
import type { ChannelModel, Channel } from 'amqplib';
import type { QueueAdapter } from '../types.js';

const EXCHANGE = 'latency-raw-exchange';

export class RawAmqplibAdapter implements QueueAdapter {
  readonly name = 'Raw AMQP';
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async setup(): Promise<void> {
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(EXCHANGE, 'direct', { durable: false });
  }

  async teardown(): Promise<void> {
    if (this.channel) {
      try { await this.channel.close(); } catch { /* ignore */ }
      this.channel = null;
    }
    if (this.connection) {
      try { await this.connection.close(); } catch { /* ignore */ }
      this.connection = null;
    }
  }

  /**
   * Minimal publish: Buffer.from(JSON.stringify(message)) only.
   * No UUID, no RunMQMessage envelope, no correlationId headers.
   */
  publish(topic: string, message: Record<string, unknown>): void {
    this.channel!.publish(EXCHANGE, topic, Buffer.from(JSON.stringify(message)));
  }

  async publishBatch(topic: string, messages: Record<string, unknown>[]): Promise<void> {
    for (const msg of messages) this.publish(topic, msg);
  }

  async startConsumer(
    topic: string,
    _concurrency: number,
    onMessage: (msg: unknown) => Promise<void>,
  ): Promise<void> {
    await this.channel!.assertQueue(topic, { durable: false, autoDelete: true });
    await this.channel!.bindQueue(topic, EXCHANGE, topic);
    const result = await this.channel!.consume(topic, async (msg) => {
      if (msg) {
        // Minimal consume: toString + JSON.parse only — no RunMQ processing chain
        const data = JSON.parse(msg.content.toString()) as Record<string, unknown>;
        await onMessage(data);
        this.channel!.ack(msg);
      }
    });
    this.consumerTag = result.consumerTag;
  }

  async stopConsumer(): Promise<void> {
    this.consumerTag = null;
    // Reconnect to get a clean channel (matching RunMQAdapter.stopConsumer behaviour)
    await this.teardown();
    await this.setup();
  }

  async purge(topic: string): Promise<void> {
    if (this.channel) {
      try { await this.channel.purgeQueue(topic); } catch { /* ignore */ }
    }
  }
}
