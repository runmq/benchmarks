// ============================================================================
// Benchmark Runner — Orchestrator
// ============================================================================
// Runs each scenario multiple times, computes mean ± stddev, and generates
// an HTML report. The first run is discarded as warmup.
//
// Run with: node --expose-gc dist/runner.js [options]
//
// Options (CLI flags or env vars):
//   --scenarios=<list>   SCENARIOS=<list>   comma-separated keys; default: all
//                        keys: publish, consume, e2e, concurrent, sizes, reliability
//   --runs=<n>           RUNS=<n>           runs per scenario (default 3)
//   --list                                  list scenarios and exit
//
// Examples:
//   node --expose-gc dist/runner.js --scenarios=e2e,publish --runs=5
//   SCENARIOS=publish RUNS=10 node --expose-gc dist/runner.js
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

const WARMUP_RUNS = 0;

type ScenarioDef = { key: string; name: string; fn: (cfg: ReturnType<typeof getConfig>, runmq: RunMQAdapter, bullmq: BullMQAdapter) => Promise<ScenarioResult> };

const ALL_SCENARIOS: ScenarioDef[] = [
  { key: 'publish',     name: 'Publish Throughput',    fn: (_c, r, b) => publishThroughput.run(r, b) },
  { key: 'consume',     name: 'Consume Throughput',    fn: (_c, r, b) => consumeThroughput.run(r, b) },
  { key: 'e2e',         name: 'End-to-End Latency',    fn: (_c, r, b) => e2eLatency.run(r, b) },
  { key: 'concurrent',  name: 'Concurrent Consumers',  fn: (_c, r, b) => concurrentConsumers.run(r, b) },
  { key: 'sizes',       name: 'Message Sizes',         fn: (_c, r, b) => messageSizes.run(r, b) },
  { key: 'reliability', name: 'Reliability Overhead',  fn: (c, r, b) => reliability.run(r, b, c) },
];

function parseArgs(argv: string[]): { scenarios?: string; runs?: string; list?: boolean } {
  const out: { scenarios?: string; runs?: string; list?: boolean } = {};
  for (const arg of argv) {
    if (arg === '--list') out.list = true;
    else if (arg.startsWith('--scenarios=')) out.scenarios = arg.slice('--scenarios='.length);
    else if (arg.startsWith('--scenario=')) out.scenarios = arg.slice('--scenario='.length);
    else if (arg.startsWith('--runs=')) out.runs = arg.slice('--runs='.length);
  }
  return out;
}

function selectScenarios(spec: string | undefined): ScenarioDef[] {
  if (!spec || spec.trim() === '' || spec.trim().toLowerCase() === 'all') return ALL_SCENARIOS;
  const keys = spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const selected: ScenarioDef[] = [];
  for (const k of keys) {
    const found = ALL_SCENARIOS.find(s => s.key === k);
    if (!found) {
      console.error(`Unknown scenario: "${k}". Valid keys: ${ALL_SCENARIOS.map(s => s.key).join(', ')}`);
      process.exit(2);
      throw new Error('unreachable');
    }
    selected.push(found);
  }
  return selected;
}

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
    description: `${runs[0].description} (mean of ${measured.length} runs)`,
    metrics,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log('Available scenarios:');
    for (const s of ALL_SCENARIOS) console.log(`  ${s.key.padEnd(12)} ${s.name}`);
    return;
  }

  const scenarios = selectScenarios(args.scenarios ?? process.env.SCENARIOS);
  const runsRaw = args.runs ?? process.env.RUNS;
  const totalRuns = runsRaw ? Math.max(1, parseInt(runsRaw, 10)) : 3;
  if (runsRaw && Number.isNaN(parseInt(runsRaw, 10))) {
    console.error(`Invalid --runs value: "${runsRaw}"`);
    process.exit(2);
  }

  const config = getConfig();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     RunMQ vs BullMQ Benchmark Suite      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`RabbitMQ:  ${config.rabbitmqUrl}`);
  console.log(`Redis:     ${config.redisHost}:${config.redisPort}`);
  console.log(`GC:        ${global.gc ? 'enabled (--expose-gc)' : 'DISABLED — results may be less accurate'}`);
  console.log(`Runs:      ${totalRuns} per scenario`);
  console.log(`Scenarios: ${scenarios.map(s => s.key).join(', ')}`);
  console.log('');

  const runmq = new RunMQAdapter(config.rabbitmqUrl);
  const bullmq = new BullMQAdapter(config.redisHost, config.redisPort);

  await runmq.setup();
  await bullmq.setup();

  const results: ScenarioResult[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const runResults: ScenarioResult[] = [];

    for (let r = 0; r < totalRuns; r++) {
      console.log(`[${i + 1}/${scenarios.length}] ${s.name} — run ${r + 1}/${totalRuns}`);
      try {
        const result = await s.fn(config, runmq, bullmq);
        runResults.push(result);

        for (const [metric, group] of Object.entries(result.metrics)) {
          console.log(
            `    ${metric}: RunMQ=${group.runmq.value.toLocaleString()} ${group.runmq.unit}  BullMQ=${group.bullmq.value.toLocaleString()} ${group.bullmq.unit}`,
          );
        }
      } catch (err) {
        console.error(`  ERROR in ${s.name} run ${r + 1}:`, err);
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
