// ============================================================================
// Benchmark Runner — Orchestrator
// ============================================================================
// Runs each scenario multiple times, computes mean ± stddev, and generates
// an HTML report. The first run is discarded as warmup.
//
// Run with: node --expose-gc dist/runner.js
// ============================================================================

import { RunMQAdapter } from './adapters/runmq.js';
import { BullMQAdapter } from './adapters/bullmq.js';
import { getConfig, sleep, forceGC, mean, stddev } from './types.js';
import type { ScenarioResult, MetricGroup } from './types.js';
import { generateReport } from './report.js';

import * as publishThroughput from './scenarios/publish-throughput.js';
import * as consumeThroughput from './scenarios/consume-throughput.js';
import * as e2eLatency from './scenarios/e2e-latency.js';
import * as concurrentConsumers from './scenarios/concurrent-consumers.js';
import * as messageSizes from './scenarios/message-sizes.js';
import * as reliability from './scenarios/reliability.js';

const TOTAL_RUNS = 4;    // 1 warmup + 3 measured
const WARMUP_RUNS = 1;   // First N runs discarded

function aggregateResults(runs: ScenarioResult[]): ScenarioResult {
  const measured = runs.slice(WARMUP_RUNS);
  const metrics: Record<string, MetricGroup> = {};
  const metricNames = Object.keys(measured[0].metrics);

  for (const name of metricNames) {
    const runmqValues = measured.map(r => r.metrics[name].runmq.value);
    const bullmqValues = measured.map(r => r.metrics[name].bullmq.value);

    metrics[name] = {
      runmq: {
        value: parseFloat(mean(runmqValues).toFixed(2)),
        unit: measured[0].metrics[name].runmq.unit,
        stddev: parseFloat(stddev(runmqValues).toFixed(2)),
      },
      bullmq: {
        value: parseFloat(mean(bullmqValues).toFixed(2)),
        unit: measured[0].metrics[name].bullmq.unit,
        stddev: parseFloat(stddev(bullmqValues).toFixed(2)),
      },
    };
  }

  return {
    scenario: runs[0].scenario,
    description: `${runs[0].description} (mean of ${measured.length} runs, first run discarded as warmup)`,
    metrics,
  };
}

async function main() {
  const config = getConfig();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     RunMQ vs BullMQ Benchmark Suite      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`RabbitMQ: ${config.rabbitmqUrl}`);
  console.log(`Redis:    ${config.redisHost}:${config.redisPort}`);
  console.log(`GC:       ${global.gc ? 'enabled (--expose-gc)' : 'DISABLED — results may be less accurate'}`);
  console.log(`Runs:     ${TOTAL_RUNS} per scenario (first ${WARMUP_RUNS} discarded as warmup)`);
  console.log('');

  const runmq = new RunMQAdapter(config.rabbitmqUrl);
  const bullmq = new BullMQAdapter(config.redisHost, config.redisPort);

  await runmq.setup();
  await bullmq.setup();

  const results: ScenarioResult[] = [];

  const scenarios = [
    { name: 'Publish Throughput', fn: () => publishThroughput.run(runmq, bullmq) },
    { name: 'Consume Throughput', fn: () => consumeThroughput.run(runmq, bullmq) },
    { name: 'End-to-End Latency', fn: () => e2eLatency.run(runmq, bullmq) },
    { name: 'Concurrent Consumers', fn: () => concurrentConsumers.run(runmq, bullmq) },
    { name: 'Message Sizes', fn: () => messageSizes.run(runmq, bullmq) },
    { name: 'Reliability Overhead', fn: () => reliability.run(runmq, bullmq, config) },
  ];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const runResults: ScenarioResult[] = [];

    for (let r = 0; r < TOTAL_RUNS; r++) {
      const label = r < WARMUP_RUNS ? 'warmup' : `run ${r - WARMUP_RUNS + 1}/${TOTAL_RUNS - WARMUP_RUNS}`;
      console.log(`[${i + 1}/${scenarios.length}] ${s.name} — ${label}`);
      try {
        const result = await s.fn();
        runResults.push(result);

        for (const [metric, group] of Object.entries(result.metrics)) {
          console.log(
            `    ${metric}: RunMQ=${group.runmq.value.toLocaleString()} ${group.runmq.unit}  BullMQ=${group.bullmq.value.toLocaleString()} ${group.bullmq.unit}`,
          );
        }
      } catch (err) {
        console.error(`  ERROR in ${s.name} ${label}:`, err);
      }

      forceGC();
      await sleep(2000);
    }

    if (runResults.length > WARMUP_RUNS) {
      const aggregated = aggregateResults(runResults);
      results.push(aggregated);

      console.log(`  === ${s.name} AVERAGE ===`);
      for (const [metric, group] of Object.entries(aggregated.metrics)) {
        console.log(
          `    ${metric}: RunMQ=${group.runmq.value.toLocaleString()} ±${group.runmq.stddev} ${group.runmq.unit}  BullMQ=${group.bullmq.value.toLocaleString()} ±${group.bullmq.stddev} ${group.bullmq.unit}`,
        );
      }
    }

    console.log('');
  }

  // Teardown
  try { await runmq.teardown(); } catch { /* ignore */ }
  try { await bullmq.teardown(); } catch { /* ignore */ }

  // Generate report
  console.log('Generating HTML report...');
  const reportPath = generateReport(results);
  console.log(`Report saved to: ${reportPath}`);
  console.log('Done!');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
