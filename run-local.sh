#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Path to the local runmq package source. Override with RUNMQ_PATH=/some/path.
RUNMQ_PATH="${RUNMQ_PATH:-$SCRIPT_DIR/../queue}"

if [ ! -f "$RUNMQ_PATH/package.json" ]; then
  echo "Error: no package.json at $RUNMQ_PATH"
  echo "Set RUNMQ_PATH to the runmq source directory."
  exit 1
fi

echo "=== RunMQ vs BullMQ Benchmark (local build) ==="
echo "Using runmq from: $RUNMQ_PATH"
echo ""

# Build runmq and pack it into a tarball the benchmark image can install.
echo "Building local runmq..."
pushd "$RUNMQ_PATH" > /dev/null
if [ ! -d node_modules ]; then
  npm install
fi
npm run build
TARBALL=$(npm pack --silent)
mv "$TARBALL" "$SCRIPT_DIR/runmq-local.tgz"
popd > /dev/null

cleanup() {
  rm -f "$SCRIPT_DIR/runmq-local.tgz"
}
trap cleanup EXIT

echo ""
echo "Scenarios: ${SCENARIOS:-all}    Runs: ${RUNS:-3}"
echo "Starting benchmark (this may take several minutes)..."
echo ""

# Pass SCENARIOS / RUNS to the container. Example:
#   SCENARIOS=publish,e2e RUNS=5 ./run-local.sh
SCENARIOS="${SCENARIOS:-}" RUNS="${RUNS:-}" \
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.local.yml \
    up --build --abort-on-container-exit benchmark

echo ""

REPORT="$SCRIPT_DIR/results/report.html"
if [ -f "$REPORT" ]; then
  echo "Report generated: $REPORT"
  if command -v open &> /dev/null; then
    open "$REPORT"
  elif command -v xdg-open &> /dev/null; then
    xdg-open "$REPORT"
  fi
else
  echo "Warning: Report not found at $REPORT"
fi

docker compose -f docker-compose.yml -f docker-compose.local.yml down
