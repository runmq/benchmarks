# RunMQ vs BullMQ — Benchmark Suite

A fair, reproducible benchmark comparing [RunMQ](https://github.com/runmq/queue) (RabbitMQ) and [BullMQ](https://github.com/taskforcesh/bullmq) (Redis) across six performance dimensions.

> **Transparency notice:** This benchmark was created by the RunMQ maintainer. The entire benchmark framework — every line of code, the Dockerfile, the HTML report generator, and this README — was written by Claude (Anthropic). The RunMQ maintainer wrote zero lines of benchmark code and asked Claude to optimize BullMQ to the maximum.
>
> While every effort was made to ensure fairness (equal Docker resources, both libraries tuned for max performance, `addBulk()` for BullMQ, documented methodology, multi-run averaging with stddev), the two systems have fundamentally different architectures that make perfect apples-to-apples comparison impossible. See [Known Limitations](#known-limitations) for details.
>
> We encourage the community to review the source, run the benchmark themselves, and report any bias.

## Results Summary

Tested on MacBook Pro M4 Max, Docker Desktop, mean of 3 runs ± stddev.

| Scenario | RunMQ | BullMQ | Ratio |
|---|---|---|---|
| **Publish Throughput** | 248,770 ±5,970 msg/s | 54,555 ±735 msg/s | **4.6x faster** |
| **Consume Throughput** | 31,590 ±369 msg/s | 8,433 ±61 msg/s | **3.7x faster** |
| **E2E Latency (mean)** | 9.53 ±0.04 ms | 0.63 ±0.02 ms | **BullMQ 15x lower** |
| **E2E Latency (p99)** | 19.41 ±0.12 ms | 2.20 ±0.24 ms | **BullMQ 8.8x lower** |
| **1 Consumer** | 9,925 ±160 msg/s | 585 ±2 msg/s | **17x faster** |
| **8 Consumers** | 36,122 ±4,707 msg/s | 3,956 ±35 msg/s | **9.1x faster** |
| **Publish 100B** | 296,648 ±10,277 msg/s | 53,264 ±1,320 msg/s | **5.6x faster** |
| **Publish 1KB** | 176,180 ±3,230 msg/s | 42,708 ±107 msg/s | **4.1x faster** |
| **Publish 10KB** | 48,425 ±595 msg/s | 16,757 ±206 msg/s | **2.9x faster** |
| **Consume 100B** | 32,833 ±910 msg/s | 8,456 ±92 msg/s | **3.9x faster** |
| **Consume 1KB** | 30,395 ±1,030 msg/s | 8,009 ±45 msg/s | **3.8x faster** |
| **Consume 10KB** | 16,545 ±721 msg/s | 5,581 ±60 msg/s | **3.0x faster** |
| **Reliability (basic)** | 32,615 ±405 msg/s | 8,643 ±58 msg/s | **3.8x faster** |
| **Reliability (retries)** | 33,271 ±1,150 msg/s | 8,530 ±41 msg/s | **3.9x faster** |

RunMQ wins on throughput across all scenarios. BullMQ wins on latency (in-memory Redis vs disk-backed RabbitMQ). See [Known Limitations](#known-limitations) for important caveats about what these numbers represent.

## Quick Start

```bash
# Requires Docker and Docker Compose
./run.sh
```

This builds the Docker images, runs all benchmarks, generates an HTML report at `results/report.html`, and opens it in your browser.

### Manual Run

```bash
docker compose up --build --abort-on-container-exit benchmark
# Report: results/report.html
# Raw data: results/results.json
docker compose down
```

## What's Tested

Each scenario runs **3 times**. Results show **mean ± standard deviation**. Message counts are calibrated per scenario to ensure each test runs for at least 3 seconds, avoiding rate extrapolation from short bursts.

| Scenario | Messages per run | What It Measures |
|---|---|---|
| **Publish Throughput** | 1,000,000 | Batch publish rate using each library's optimal bulk mechanism |
| **Consume Throughput** | 100,000 | Messages consumed per second with a single no-op consumer |
| **End-to-End Latency** | 1,000 | User-observable latency from publish API call to consumer handler (p50/p95/p99) |
| **Concurrent Consumers** | 50,000 x4 | Throughput scaling at 1, 2, 4, 8 concurrent consumers |
| **Message Sizes** | 500K (100B), 500K (1KB), 150K pub / 50K consume (10KB) | Impact of payload size on publish and consume |
| **Reliability Overhead** | 100,000 x2 | Cost of enabling retries (3 attempts, 100ms delay) |

## Statistical Methodology

- **3 runs per scenario**: All runs are measured and averaged.
- **Mean ± stddev**: All results report the arithmetic mean and standard deviation across runs.
- **No extrapolation**: Message counts are sized so each test runs for 3+ seconds at the fastest library's rate, preventing inflated msg/s from sub-second bursts.
- **Per-batch payload generation**: Payloads are generated in batches of 500 to prevent OOM at high message counts (e.g., 1M publish).
- **GC isolation**: `global.gc()` (double-pass) is forced before every library run across all iterations.
- **Equal settling time**: Both libraries get identical 1000ms sleep before each run.

## Configuration Per Scenario

### Publish Throughput

| Setting | RunMQ | BullMQ |
|---|---|---|
| API | loop of `publish()` — amqplib TCP-batches automatically | `addBulk()` — single Redis pipeline per batch |
| Batch size | 500 (TCP auto-batched) | 500 (explicit `addBulk()`) |
| Durability | Durable exchange (default) | Default Redis persistence |
| Payload | 100-byte JSON | 100-byte JSON |
| Warmup | 100 messages | 100 messages |

### Consume Throughput

| Setting | RunMQ | BullMQ |
|---|---|---|
| Concurrency | `consumersCount: 1` | `concurrency: 1` |
| Stall detection | N/A | Disabled (`skipStalledCheck: true`) |
| Lock renewal | N/A | Disabled (`skipLockRenewal: true`) |
| Drain delay | N/A | 1ms (minimum allowed) |
| Job cleanup | Messages acked (removed from queue) | `removeOnComplete: true, removeOnFail: true` |
| Handler | `async () => {}` (no-op) | `async () => {}` (no-op) |
| Warmup | 100 messages consumed before measurement | 100 messages consumed before measurement |
| Measurement | first-consumed → last-consumed | first-consumed → last-consumed |

### End-to-End Latency

| Setting | RunMQ | BullMQ |
|---|---|---|
| Concurrency | `consumersCount: 1` | `concurrency: 1` |
| Inter-message delay | 5ms | 5ms |
| Timestamp | `performance.now()` BEFORE `publish()` call | `performance.now()` BEFORE `add()` call |
| Measures | buffer write + TCP transit + broker routing + push to consumer | Redis write round-trip + worker BRPOP pickup |

### Concurrent Consumers

| Setting | RunMQ | BullMQ |
|---|---|---|
| Concurrency levels | 1, 2, 4, 8 | 1, 2, 4, 8 |
| Implementation | N AMQP consumers on N channels | N concurrent processors in 1 worker |
| Simulated work | 1ms async delay per message | 1ms async delay per message |

### Message Sizes

| Setting | RunMQ | BullMQ |
|---|---|---|
| Payload sizes | 100B, 1KB, 10KB | 100B, 1KB, 10KB |
| Serialization | JSON → Buffer (AMQP body) | JSON → Redis string |
| Publish method | `publishBatch()` — TCP auto-batched | `addBulk()` — Redis pipeline |
| Both | Identical JSON generated by `generatePayload()` | Identical JSON generated by `generatePayload()` |

### Reliability Overhead

| Setting | RunMQ | BullMQ |
|---|---|---|
| Basic | No retry config | No retry config |
| With retries | `attempts: 3, attemptsDelay: 100` | `attempts: 3, backoff: { type: 'fixed', delay: 100 }` |
| Mechanism | Dead-letter exchange + TTL requeue | Redis delayed set |
| Note | No messages intentionally failed | No messages intentionally failed |

## How Fairness Is Ensured

### Infrastructure

- **Equal Docker resources**: Both RabbitMQ and Redis receive identical limits — 2 CPUs and 4 GB RAM. The benchmark runner gets 2 CPUs and 8 GB.
- **No management overhead**: RabbitMQ uses the base `rabbitmq:3-alpine` image (no management plugin HTTP server). Redis uses `redis:7-alpine`.
- **No host port mapping**: Brokers communicate over Docker's internal network only.

### Maximum Performance Tuning

Both libraries are tuned for maximum throughput:

**RunMQ:**
- Default prefetch — allows RabbitMQ to pipeline multiple messages to the consumer without waiting for individual acks.
- Silent logger — eliminates I/O overhead from console logging.

**BullMQ:**
- `addBulk()` for publishing — single Redis pipeline per batch instead of one round-trip per message. This is BullMQ's recommended high-throughput pattern.
- `skipStalledCheck: true` — disables background Redis polling timer.
- `skipLockRenewal: true` — disables lock renewal timer (jobs complete in <1ms).
- `removeOnComplete: true` / `removeOnFail: true` — immediate cleanup, reduces Redis memory pressure.
- `drainDelay: 1` — minimum idle poll delay (1ms, the lowest BullMQ allows).

### Execution

- **Multi-run averaging**: Each scenario runs 3 times. Results are mean ± stddev.
- **Sequential runs**: Only one library is tested at a time. No resource contention.
- **GC before each run**: `global.gc()` is called (double-pass) before each library's run in every iteration.
- **Equal settling time**: Both libraries get identical 1000ms sleep before each run.
- **Consumer warmup**: Consume-throughput scenario includes 100-message warmup for both.
- **Publish warmup**: Publish-throughput scenario includes 100-message warmup for both.
- **Unique topics**: Each scenario uses unique topic/queue names to prevent stale data.
- **Timeouts**: All scenarios have 120-second timeouts.

### Measurement

- **Identical payloads**: The same `generatePayload(sizeBytes)` function generates byte-identical JSON for both libraries.
- **Batch publishing fairness**: Both libraries use their optimal bulk mechanism — RunMQ gets TCP auto-batching, BullMQ gets `addBulk()` Redis pipelines.
- **Consume timing**: Throughput is measured from **first message consumed** to **last message consumed**, excluding the publish phase.
- **Latency timing**: Sent timestamp is captured BEFORE `publish()`/`add()` is called — the same measurement point for both. This measures user-observable latency: total time from calling the API to the consumer handler firing. Both include their full delivery cost (RunMQ: buffer + transit + routing; BullMQ: Redis write + worker pickup).
- **Adapter pattern**: Both libraries implement the same `QueueAdapter` interface.

### What's NOT Equalized (by design)

These are genuine architectural differences between the two systems:

| Difference | RunMQ (RabbitMQ) | BullMQ (Redis) |
|---|---|---|
| **Broker persistence** | Durable queues/exchanges by default. Messages survive broker restarts. | In-memory by default. Durability requires AOF/RDB config. |
| **Message routing** | Exchange → queue binding with routing keys. | Direct list/stream operations. |
| **Consumer model** | Push-based: broker pushes messages via AMQP channels. | Poll-based: worker polls Redis for new jobs. |

## Understanding the Results

- **Higher msg/s = better** for throughput scenarios
- **Lower ms = better** for latency scenarios
- Results show **mean ± standard deviation** across 3 runs
- The HTML report shows percentage differences in the summary table
- Raw JSON data is saved to `results/results.json` for further analysis

## Customizing

To change message counts, edit the `TOTAL_MESSAGES` constant in each scenario file under `src/scenarios/`.

To change the number of runs, edit `TOTAL_RUNS` in `src/runner.ts`.

Rebuild with:

```bash
docker compose build --no-cache benchmark
docker compose up --abort-on-container-exit benchmark
```

To change Docker resource limits, edit `docker-compose.yml`.

## Known Limitations

These are inherent limitations that cannot be fully resolved due to architectural differences between the two systems:

1. **Publish throughput compares different guarantees.** RunMQ's `publish()` is synchronous — it writes to an in-process AMQP channel buffer without network confirmation. BullMQ's `addBulk()` awaits a Redis pipeline round-trip with confirmation. Even though both use their optimal bulk pattern, RunMQ is measuring "buffer write speed" while BullMQ is measuring "confirmed persistence speed." There is no way to equalize this without RunMQ supporting publisher confirms, which it currently does not.

2. **Redis is in-memory, RabbitMQ is disk-backed.** RabbitMQ persists messages to durable queues by default. Redis operates entirely in-memory. This fundamentally affects latency comparisons and will always favor BullMQ on E2E latency. This is a deliberate design tradeoff — not a benchmark flaw.

3. **Execution ordering is fixed.** RunMQ always runs first in every scenario. The first library to run pays a JIT cold-start cost. This slightly disadvantages RunMQ, not BullMQ. Proper mitigation would be to alternate or randomize order across runs.

4. **1ms simulated work in concurrent consumers.** At 1ms work duration, the per-message fetch overhead is a significant percentage of total processing time, which favors RunMQ's push-based model over BullMQ's poll-based model. With more realistic work durations (10-100ms), the throughput difference between the two would narrow.

5. **RunMQ's internal processor chain.** RunMQ allocates 6 processor objects per consumed message (deserializer, retries checker, acknowledger, etc.). This overhead is included in RunMQ's consume numbers, making RunMQ look slightly worse than a more optimized implementation could achieve. This is a bias *against* RunMQ.

If you find additional bias in either direction, please open an issue.

## Requirements

- Docker Engine 20+
- Docker Compose V2
- ~16 GB free memory (4 GB per broker + 8 GB for runner)
