import { RunMQAdapter } from './adapters/runmq.js';
import { RawAmqplibAdapter } from './latency/raw-amqplib-adapter.js';
import { getConfig, forceGC, sleep } from './types.js';
import { runMicro } from './latency/micro.js';
import type { MicroResult } from './latency/micro.js';
import { runConcurrencySweep } from './latency/concurrency.js';
import type { ConcurrencySweepResult } from './latency/concurrency.js';
import { generateLatencyReport } from './latency/latency-report.js';

// ─────────────────────────────────────────
// Terminal formatters
// ─────────────────────────────────────────

function printMicro(results: MicroResult[]): void {
  console.log('');
  console.log('Phase 1: Micro-benchmarks (CPU only, no network)');
  console.log('─'.repeat(62));
  for (const r of results) {
    const name = r.name.padEnd(42);
    const m = `${r.meanNs.toFixed(1).padStart(8)} ns`;
    const sd = `± ${r.stddevNs.toFixed(1).padStart(7)} ns`;
    console.log(`  ${name} ${m}  ${sd}`);
  }
  const pub = results.find(r => r.name === 'Combined publish pipeline');
  const con = results.find(r => r.name === 'Combined consume pipeline');
  if (pub && con) {
    const total = pub.meanNs + con.meanNs;
    console.log('─'.repeat(62));
    console.log(`  ${'Total in-process overhead'.padEnd(42)} ${total.toFixed(1).padStart(8)} ns`);
    console.log(`  → ${(total / 1_000_000).toFixed(4)} ms of the e2e latency is pure RunMQ CPU work`);
  }
  console.log('');
}

function printSweep(sweep: ConcurrencySweepResult): void {
  console.log('Phase 2: Burst Concurrency Sweep (RunMQ vs Raw AMQP)');
  console.log('─'.repeat(78));
  console.log('  Burst │ RunMQ mean±σ           │  p99    │ Raw mean±σ             │  p99    │ Delta');
  console.log('  ──────┼───────────────────────┼─────────┼───────────────────────┼─────────┼──────');
  for (let i = 0; i < sweep.runmq.levels.length; i++) {
    const r = sweep.runmq.levels[i];
    const raw = sweep.raw.levels[i];
    const delta = (r.meanMs - raw.meanMs).toFixed(3);
    const runmqCell = `${r.meanMs}±${r.stddevMs} ms`.padEnd(21);
    const rawCell = `${raw.meanMs}±${raw.stddevMs} ms`.padEnd(21);
    console.log(
      `  ${String(r.burstSize).padStart(5)} │ ${runmqCell} │ ${String(r.p99Ms).padStart(7)} │ ${rawCell} │ ${String(raw.p99Ms).padStart(7)} │ ${delta} ms`,
    );
  }
  console.log('');
}

// ─────────────────────────────────────────
// Main
// ─────────────────────────────────────────

async function main(): Promise<void> {
  const config = getConfig();
  const timestamp = new Date().toISOString();

  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║       RunMQ Latency Analysis Suite            ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
  console.log(`RabbitMQ: ${config.rabbitmqUrl}`);
  console.log(`GC:       ${global.gc ? 'enabled (--expose-gc)' : 'DISABLED — results may be noisier'}`);
  console.log('');

  // ── Phase 1: CPU micro-benchmarks — no network required ──
  console.log('Running Phase 1 (no network required)...');
  forceGC();
  const micro = runMicro();
  printMicro(micro);

  // ── Phase 2: Burst concurrency sweep — requires RabbitMQ ──
  console.log('Running Phase 2 (requires RabbitMQ)...');
  const runmqAdapter = new RunMQAdapter(config.rabbitmqUrl);
  const rawAdapter = new RawAmqplibAdapter(config.rabbitmqUrl);

  await runmqAdapter.setup();
  await rawAdapter.setup();

  forceGC();
  await sleep(500);

  const sweep = await runConcurrencySweep(runmqAdapter, rawAdapter);
  printSweep(sweep);

  try { await runmqAdapter.teardown(); } catch { /* ignore */ }
  try { await rawAdapter.teardown(); } catch { /* ignore */ }

  // ── Report ──
  console.log('Generating latency report...');
  const reportPath = generateLatencyReport(micro, sweep, timestamp);
  console.log(`Report saved: ${reportPath}`);
  console.log('');
  console.log('Done!');
}

main().catch((err) => {
  console.error('Latency suite failed:', err);
  process.exit(1);
});
