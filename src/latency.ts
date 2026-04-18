import { runMicro } from './latency/micro.js';
import type { MicroResult } from './latency/micro.js';

function printMicro(results: MicroResult[]): void {
  console.log('');
  console.log('Phase 1: Micro-benchmarks (CPU only, no network)');
  console.log('─'.repeat(60));
  for (const r of results) {
    const name = r.name.padEnd(40);
    const m = `${r.meanNs.toFixed(1).padStart(8)} ns`;
    const sd = `± ${r.stddevNs.toFixed(1).padStart(7)} ns`;
    console.log(`  ${name} ${m}  ${sd}`);
  }
  const pub = results.find(r => r.name === 'Combined publish pipeline');
  const con = results.find(r => r.name === 'Combined consume pipeline');
  if (pub && con) {
    const total = pub.meanNs + con.meanNs;
    console.log('─'.repeat(60));
    console.log(`  ${'Total in-process overhead'.padEnd(40)} ${total.toFixed(1).padStart(8)} ns`);
    console.log(`  → ${(total / 1_000_000).toFixed(4)} ms of the e2e latency is pure RunMQ CPU work`);
  }
  console.log('');
}

const micro = runMicro();
printMicro(micro);
