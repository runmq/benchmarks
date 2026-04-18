import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MicroResult } from './micro.js';
import type { ConcurrencySweepResult } from './concurrency.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function generateLatencyReport(
  micro: MicroResult[],
  sweep: ConcurrencySweepResult,
  timestamp: string,
): string {
  const microJson = JSON.stringify(micro);
  const sweepJson = JSON.stringify(sweep);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RunMQ Latency Analysis</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {
    --runmq: #6366f1;
    --raw: #10b981;
    --delta: #f59e0b;
    --bg: #0f172a;
    --card: #1e293b;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --border: #334155;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
  }
  .header { text-align: center; margin-bottom: 3rem; }
  .header h1 {
    font-size: 2.2rem;
    font-weight: 800;
    background: linear-gradient(135deg, var(--runmq), var(--raw));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }
  .header p { color: var(--muted); font-size: 0.9rem; }
  .section-title {
    text-align: center;
    font-size: 1.4rem;
    font-weight: 700;
    margin: 2.5rem 0 1.5rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    max-width: 960px;
    margin: 0 auto 1.5rem;
  }
  .card h2 { font-size: 1.1rem; margin-bottom: 0.25rem; }
  .card .desc { color: var(--muted); font-size: 0.8rem; margin-bottom: 1.25rem; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .combined { font-weight: 700; color: var(--runmq); }
  .chart-container { position: relative; height: 380px; }
  .legend {
    display: flex; justify-content: center; gap: 2rem;
    margin-bottom: 1.5rem; flex-wrap: wrap;
  }
  .legend-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; font-weight: 600; }
  .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
  .insight {
    max-width: 960px; margin: 2rem auto 0;
    padding: 1.25rem 1.5rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    font-size: 0.85rem;
    color: var(--muted);
    line-height: 1.7;
  }
  .insight h3 { color: var(--text); margin-bottom: 0.5rem; font-size: 1rem; }
  .insight ul { padding-left: 1.5rem; margin-top: 0.5rem; }
  .insight li { margin-bottom: 0.25rem; }
</style>
</head>
<body>

<div class="header">
  <h1>RunMQ Latency Analysis</h1>
  <p>Generated ${timestamp}</p>
</div>

<!-- ═══ Phase 1 ═══ -->
<h2 class="section-title">Phase 1 — In-Process Overhead (CPU only, no network)</h2>

<div class="card">
  <h2>Micro-benchmark Results</h2>
  <div class="desc">
    Each operation: 10,000 iterations (500 warmup discarded), timed in batches of 100 to stay
    above <code>performance.now()</code> clock resolution. Payload: 100-byte JSON envelope
    matching the e2e latency scenario. ★ rows are pipeline totals.
  </div>
  <table>
    <thead>
      <tr>
        <th>Operation</th>
        <th class="num">Mean (ns)</th>
        <th class="num">± Stddev (ns)</th>
      </tr>
    </thead>
    <tbody id="micro-body"></tbody>
  </table>
</div>

<!-- ═══ Phase 2 ═══ -->
<h2 class="section-title">Phase 2 — Burst Concurrency Sweep</h2>

<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:var(--runmq)"></div>RunMQ (mean)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--runmq);opacity:.4"></div>RunMQ (p99)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--raw)"></div>Raw AMQP (mean)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--raw);opacity:.4"></div>Raw AMQP (p99)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--delta)"></div>Delta (RunMQ overhead)</div>
</div>

<div class="card">
  <h2>Latency vs Burst Size</h2>
  <div class="desc">
    Burst size N = messages published before any consumer ack arrives — models queue buildup.
    200 bursts per level (5 warmup discarded). Latency measured per-message.
    Delta = RunMQ mean − Raw AMQP mean = pure library overhead.
  </div>
  <div class="chart-container">
    <canvas id="sweep-chart"></canvas>
  </div>
</div>

<div class="card">
  <h2>Concurrency Sweep — Detailed Table</h2>
  <div class="desc">Mean ± stddev, p50, p95, p99, and RunMQ overhead delta for all burst levels.</div>
  <table>
    <thead>
      <tr>
        <th>Burst</th>
        <th class="num">RunMQ mean ± σ</th>
        <th class="num">p50</th>
        <th class="num">p95</th>
        <th class="num">p99</th>
        <th class="num">Raw mean ± σ</th>
        <th class="num">Raw p99</th>
        <th class="num">Delta (overhead)</th>
      </tr>
    </thead>
    <tbody id="sweep-body"></tbody>
  </table>
</div>

<div class="insight">
  <h3>How to read the results</h3>
  <ul>
    <li><strong>Phase 1 total</strong>: the sum of combined publish + consume pipeline is RunMQ's pure CPU cost per message. Anything left in the e2e latency is AMQP/TCP/broker time.</li>
    <li><strong>Delta stays flat</strong>: RunMQ overhead is constant; tail growth under bursts is pure broker queuing — the library is not the bottleneck.</li>
    <li><strong>Delta grows with burst size</strong>: RunMQ's processing chain (6-layer processor stack, deserialization, validation) becomes a bottleneck under concurrency.</li>
    <li><strong>Highest-impact optimization</strong>: if Phase 1 shows &lt;0.5ms total CPU overhead, the 9.5ms is almost entirely AMQP/TCP. Passing <code>{ noDelay: true }</code> to <code>amqp.connect()</code> (disabling Nagle's algorithm) is the single highest-leverage change.</li>
  </ul>
</div>

<script>
const micro = ${microJson};
const sweep = ${sweepJson};

// ── Phase 1 table ──
const microBody = document.getElementById('micro-body');
const combinedNames = ['Combined publish pipeline', 'Combined consume pipeline'];
let totalMeanNs = 0;

for (const row of micro) {
  const isCombined = combinedNames.includes(row.name);
  if (isCombined) totalMeanNs += row.meanNs;
  microBody.innerHTML += \`
    <tr>
      <td class="\${isCombined ? 'combined' : ''}">\${row.name}\${isCombined ? ' ★' : ''}</td>
      <td class="num \${isCombined ? 'combined' : ''}">\${row.meanNs.toFixed(1)}</td>
      <td class="num">\${row.stddevNs.toFixed(1)}</td>
    </tr>
  \`;
}

microBody.innerHTML += \`
  <tr style="border-top:2px solid var(--border)">
    <td class="combined">Total in-process overhead (publish ★ + consume ★)</td>
    <td class="num combined">\${totalMeanNs.toFixed(1)}</td>
    <td class="num combined">\${(totalMeanNs / 1_000_000).toFixed(4)} ms</td>
  </tr>
\`;

// ── Phase 2 chart ──
const labels = sweep.runmq.levels.map(l => \`burst=\${l.burstSize}\`);
const runmqMean = sweep.runmq.levels.map(l => l.meanMs);
const runmqP99  = sweep.runmq.levels.map(l => l.p99Ms);
const rawMean   = sweep.raw.levels.map(l => l.meanMs);
const rawP99    = sweep.raw.levels.map(l => l.p99Ms);
const delta     = sweep.runmq.levels.map((l, i) =>
  parseFloat((l.meanMs - sweep.raw.levels[i].meanMs).toFixed(3))
);

const ctx = document.getElementById('sweep-chart').getContext('2d');
new Chart(ctx, {
  type: 'line',
  data: {
    labels,
    datasets: [
      { label: 'RunMQ mean',    data: runmqMean, borderColor: '#6366f1', backgroundColor: '#6366f122', borderWidth: 2, tension: 0.3, pointRadius: 5, fill: false },
      { label: 'RunMQ p99',     data: runmqP99,  borderColor: '#6366f1', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], tension: 0.3, pointRadius: 4, fill: false },
      { label: 'Raw AMQP mean', data: rawMean,   borderColor: '#10b981', backgroundColor: '#10b98122', borderWidth: 2, tension: 0.3, pointRadius: 5, fill: false },
      { label: 'Raw AMQP p99',  data: rawP99,    borderColor: '#10b981', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], tension: 0.3, pointRadius: 4, fill: false },
      { label: 'Delta (RunMQ − Raw)', data: delta, borderColor: '#f59e0b', backgroundColor: '#f59e0b22', borderWidth: 2, tension: 0.3, pointRadius: 5, fill: true },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, labels: { color: '#94a3b8', usePointStyle: true } },
      tooltip: {
        callbacks: { label: (ctx) => \`\${ctx.dataset.label}: \${ctx.parsed.y} ms\` },
      },
    },
    scales: {
      x: { ticks: { color: '#94a3b8' }, grid: { color: '#33415522' } },
      y: {
        beginAtZero: true,
        ticks: { color: '#94a3b8', callback: (v) => v + ' ms' },
        grid: { color: '#33415522' },
      },
    },
  },
});

// ── Phase 2 table ──
const sweepBody = document.getElementById('sweep-body');
sweep.runmq.levels.forEach((r, i) => {
  const raw = sweep.raw.levels[i];
  const d = (r.meanMs - raw.meanMs).toFixed(3);
  sweepBody.innerHTML += \`
    <tr>
      <td>\${r.burstSize}</td>
      <td class="num">\${r.meanMs} ±\${r.stddevMs} ms</td>
      <td class="num">\${r.p50Ms} ms</td>
      <td class="num">\${r.p95Ms} ms</td>
      <td class="num">\${r.p99Ms} ms</td>
      <td class="num">\${raw.meanMs} ±\${raw.stddevMs} ms</td>
      <td class="num">\${raw.p99Ms} ms</td>
      <td class="num" style="color:var(--delta);font-weight:600">\${d} ms</td>
    </tr>
  \`;
});
</script>
</body>
</html>`;

  const outDir = join(__dirname, '..', '..', 'results');
  try { mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
  const outPath = join(outDir, 'latency-report.html');
  writeFileSync(outPath, html, 'utf-8');
  return outPath;
}
