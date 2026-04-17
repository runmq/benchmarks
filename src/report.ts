import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function generateReport(results: ScenarioResult[]): string {
  const timestamp = new Date().toISOString();
  const dataJson = JSON.stringify(results, null, 2);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RunMQ vs BullMQ — Benchmark Results</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {
    --runmq: #6366f1;
    --bullmq: #f59e0b;
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
  .header {
    text-align: center;
    margin-bottom: 3rem;
  }
  .header h1 {
    font-size: 2.5rem;
    font-weight: 800;
    background: linear-gradient(135deg, var(--runmq), var(--bullmq));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }
  .header p { color: var(--muted); font-size: 0.9rem; }
  .legend {
    display: flex;
    justify-content: center;
    gap: 2rem;
    margin-bottom: 2rem;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    font-size: 1rem;
  }
  .legend-dot {
    width: 14px;
    height: 14px;
    border-radius: 3px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(560px, 1fr));
    gap: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
  }
  .card h2 {
    font-size: 1.15rem;
    margin-bottom: 0.25rem;
    color: var(--text);
  }
  .card .desc {
    color: var(--muted);
    font-size: 0.8rem;
    margin-bottom: 1rem;
    line-height: 1.4;
  }
  .chart-container {
    position: relative;
    width: 100%;
    height: 320px;
  }
  .summary-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 2rem;
    max-width: 1400px;
    margin-left: auto;
    margin-right: auto;
  }
  .summary-table th, .summary-table td {
    padding: 0.75rem 1rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .summary-table th {
    color: var(--muted);
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .summary-table td { font-size: 0.95rem; }
  .faster { font-weight: 700; }
  .faster-runmq { color: var(--runmq); }
  .faster-bullmq { color: var(--bullmq); }
  .section-title {
    text-align: center;
    margin: 3rem 0 1.5rem;
    font-size: 1.5rem;
    font-weight: 700;
  }
  .fairness {
    max-width: 900px;
    margin: 3rem auto 0;
    padding: 1.5rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    font-size: 0.85rem;
    color: var(--muted);
    line-height: 1.7;
  }
  .fairness h3 {
    color: var(--text);
    margin-bottom: 0.75rem;
    font-size: 1rem;
  }
  .fairness ul { padding-left: 1.5rem; }
  .fairness li { margin-bottom: 0.25rem; }
</style>
</head>
<body>

<div class="header">
  <h1>RunMQ vs BullMQ</h1>
  <p>Benchmark Results &mdash; ${timestamp} &mdash; Mean of 3 runs (first run discarded as warmup)</p>
</div>

<div class="legend">
  <div class="legend-item">
    <div class="legend-dot" style="background: var(--runmq)"></div>
    RunMQ <span style="color: var(--muted); font-weight: 400; font-size: 0.85rem">(RabbitMQ)</span>
  </div>
  <div class="legend-item">
    <div class="legend-dot" style="background: var(--bullmq)"></div>
    BullMQ <span style="color: var(--muted); font-weight: 400; font-size: 0.85rem">(Redis)</span>
  </div>
</div>

<div class="grid" id="charts"></div>

<h2 class="section-title">Summary</h2>
<table class="summary-table" id="summary"></table>

<div class="fairness">
  <h3>Fairness Methodology</h3>
  <ul>
    <li><strong>Equal resources:</strong> Both brokers get identical Docker limits (2 CPUs, 1 GB RAM).</li>
    <li><strong>Identical payloads:</strong> Both libraries process byte-identical JSON payloads.</li>
    <li><strong>GC isolation:</strong> Garbage collection is forced before each library's run so both start with a clean heap.</li>
    <li><strong>Sequential execution:</strong> Only one library is active at a time to avoid resource contention.</li>
    <li><strong>Warm-up:</strong> Each scenario includes a warm-up phase to prime JIT, connections, and internal buffers.</li>
    <li><strong>Consume measurement:</strong> Throughput is measured from first-consumed to last-consumed, excluding publish time.</li>
  </ul>
  <h3 style="margin-top: 1rem;">Known Architectural Differences</h3>
  <ul>
    <li><strong>Publish semantics:</strong> RunMQ publish is synchronous (AMQP channel buffer); BullMQ add is async (awaits Redis confirmation). Publish throughput numbers reflect this fundamental design difference.</li>
    <li><strong>Broker persistence:</strong> RabbitMQ persists messages to disk by default; Redis operates in-memory. This is a deliberate design tradeoff of each system.</li>
    <li><strong>Consumer model:</strong> RunMQ creates N AMQP channels; BullMQ polls Redis with concurrency N. Both achieve N-way parallelism differently.</li>
  </ul>
</div>

<script>
const RUNMQ_COLOR = '#6366f1';
const BULLMQ_COLOR = '#f59e0b';
const results = ${dataJson};

const chartsEl = document.getElementById('charts');
const summaryEl = document.getElementById('summary');

function isLowerBetter(scenario, metric) {
  return scenario.includes('Latency') || metric.includes('Latency');
}

results.forEach((result, idx) => {
  const card = document.createElement('div');
  card.className = 'card';

  const labels = Object.keys(result.metrics);
  const runmqValues = labels.map(k => result.metrics[k].runmq.value);
  const bullmqValues = labels.map(k => result.metrics[k].bullmq.value);
  const unit = result.metrics[labels[0]].runmq.unit;

  const desc = result.description || '';

  card.innerHTML = \`
    <h2>\${result.scenario}</h2>
    <div class="desc">\${desc}</div>
    <div class="chart-container">
      <canvas id="chart-\${idx}"></canvas>
    </div>
  \`;
  chartsEl.appendChild(card);

  const useLineChart = labels.length > 3 && result.scenario.includes('Concurrent');
  const ctx = document.getElementById('chart-' + idx).getContext('2d');
  new Chart(ctx, {
    type: useLineChart ? 'line' : 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'RunMQ',
          data: runmqValues,
          backgroundColor: RUNMQ_COLOR + '99',
          borderColor: RUNMQ_COLOR,
          borderWidth: 2,
          borderRadius: 4,
          tension: 0.3,
          pointRadius: 5,
          pointHoverRadius: 7,
        },
        {
          label: 'BullMQ',
          data: bullmqValues,
          backgroundColor: BULLMQ_COLOR + '99',
          borderColor: BULLMQ_COLOR,
          borderWidth: 2,
          borderRadius: 4,
          tension: 0.3,
          pointRadius: 5,
          pointHoverRadius: 7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const dsIdx = ctx.datasetIndex;
              const dataIdx = ctx.dataIndex;
              const metricKey = labels[dataIdx];
              const lib = dsIdx === 0 ? 'runmq' : 'bullmq';
              const sd = result.metrics[metricKey][lib].stddev;
              const sdStr = sd ? \` ±\${sd.toLocaleString()}\` : '';
              return \`\${ctx.dataset.label}: \${ctx.parsed.y.toLocaleString()}\${sdStr} \${unit}\`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8' },
          grid: { color: '#33415522' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#94a3b8',
            callback: (v) => v.toLocaleString() + ' ' + unit,
          },
          grid: { color: '#33415522' },
        },
      },
    },
  });
});

// Calculate percentage difference: positive = RunMQ wins, negative = BullMQ wins
function pctDiff(runmqVal, bullmqVal, lowerBetter) {
  if (bullmqVal === 0 && runmqVal === 0) return { pct: 0, label: 'Tie' };
  let pct;
  if (lowerBetter) {
    // Lower is better: if RunMQ < BullMQ, RunMQ wins
    pct = bullmqVal === 0 ? 0 : ((bullmqVal - runmqVal) / bullmqVal) * 100;
  } else {
    // Higher is better: if RunMQ > BullMQ, RunMQ wins
    pct = bullmqVal === 0 ? 100 : ((runmqVal - bullmqVal) / bullmqVal) * 100;
  }
  const absPct = Math.abs(pct).toFixed(1);
  if (Math.abs(pct) < 1) return { pct: 0, label: 'Tie' };
  if (pct > 0) return { pct, label: \`RunMQ +\${absPct}%\` };
  return { pct, label: \`BullMQ +\${absPct}%\` };
}

// Summary table
let tableHTML = \`
  <thead>
    <tr>
      <th>Scenario</th>
      <th>Metric</th>
      <th>RunMQ</th>
      <th>BullMQ</th>
      <th>Difference</th>
      <th>Faster</th>
    </tr>
  </thead>
  <tbody>
\`;

results.forEach(result => {
  Object.entries(result.metrics).forEach(([metric, group]) => {
    const lowerBetter = isLowerBetter(result.scenario, metric);
    let faster;
    if (lowerBetter) {
      faster = group.runmq.value <= group.bullmq.value ? 'RunMQ' : 'BullMQ';
    } else {
      faster = group.runmq.value >= group.bullmq.value ? 'RunMQ' : 'BullMQ';
    }
    const fasterClass = faster === 'RunMQ' ? 'faster-runmq' : 'faster-bullmq';
    const rClass = faster === 'RunMQ' ? \`class="faster \${fasterClass}"\` : '';
    const bClass = faster === 'BullMQ' ? \`class="faster \${fasterClass}"\` : '';
    const diff = pctDiff(group.runmq.value, group.bullmq.value, lowerBetter);
    const diffClass = diff.pct > 0 ? 'faster-runmq' : diff.pct < 0 ? 'faster-bullmq' : '';

    const rSd = group.runmq.stddev ? \` <span style="color:var(--muted);font-weight:400">±\${group.runmq.stddev.toLocaleString()}</span>\` : '';
    const bSd = group.bullmq.stddev ? \` <span style="color:var(--muted);font-weight:400">±\${group.bullmq.stddev.toLocaleString()}</span>\` : '';

    tableHTML += \`
      <tr>
        <td>\${result.scenario}</td>
        <td>\${metric}\${lowerBetter ? ' (lower is better)' : ''}</td>
        <td \${rClass}>\${group.runmq.value.toLocaleString()} \${group.runmq.unit}\${rSd}</td>
        <td \${bClass}>\${group.bullmq.value.toLocaleString()} \${group.bullmq.unit}\${bSd}</td>
        <td class="faster \${diffClass}">\${diff.label}</td>
        <td class="faster \${fasterClass}">\${faster}</td>
      </tr>
    \`;
  });
});

tableHTML += '</tbody>';
summaryEl.innerHTML = tableHTML;
</script>

</body>
</html>`;

  const outDir = join(__dirname, '..', 'results');
  try { mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
  const outPath = join(outDir, 'report.html');
  writeFileSync(outPath, html, 'utf-8');

  // Also write raw JSON for downstream analysis
  writeFileSync(join(outDir, 'results.json'), dataJson, 'utf-8');

  return outPath;
}
