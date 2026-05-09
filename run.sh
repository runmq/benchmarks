#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== RunMQ vs BullMQ Benchmark ==="
echo ""
echo "Scenarios: ${SCENARIOS:-all}    Runs: ${RUNS:-3}"
echo "Starting benchmark (this may take several minutes)..."
echo ""

# SCENARIOS / RUNS env vars are passed through to the container via
# docker-compose.yml. Example:
#   SCENARIOS=publish,e2e RUNS=5 ./run.sh
SCENARIOS="${SCENARIOS:-}" RUNS="${RUNS:-}" \
  docker compose up --build --abort-on-container-exit benchmark

echo ""

REPORT="$SCRIPT_DIR/results/report.html"
if [ -f "$REPORT" ]; then
  echo "Report generated: $REPORT"
  # Open in browser on macOS
  if command -v open &> /dev/null; then
    open "$REPORT"
  # Open in browser on Linux
  elif command -v xdg-open &> /dev/null; then
    xdg-open "$REPORT"
  fi
else
  echo "Warning: Report not found at $REPORT"
fi

# Clean up containers
docker compose down
