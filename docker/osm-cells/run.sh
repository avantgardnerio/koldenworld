#!/usr/bin/env bash
# One splitter run: the planet in PBF (an s3:// URL, downloaded to the instance's NVMe at /scratch) to raw level-6
# cell files under OUT/raw, and the run's plans with metrics and its log under OUT/report. monitor.sh prints the
# machine's CPU, memory, disk and network alongside. Settings as the manual planet run's (docs/serverless-plan.md).
set -euo pipefail
: "${PBF:?PBF, the planet's s3:// URL}" "${OUT:?OUT, the run's s3:// folder}"

mkdir -p /scratch/work /scratch/spill
export SEDONA_WORK_DIR=/scratch/work SEDONA_SPILL_DIR=/scratch/spill
export SEDONA_MEMORY_LIMIT_GB="${SEDONA_MEMORY_LIMIT_GB:-200}"
export SEDONA_SPILL_COMPRESSION="${SEDONA_SPILL_COMPRESSION:-lz4_frame}"
export SEDONA_PROGRESS_SECS="${SEDONA_PROGRESS_SECS:-60}"
# The node array's size and the sketched cuts, without every crate's chatter.
export RUST_LOG="${RUST_LOG:-warn,sedona=info}"

/usr/local/bin/monitor.sh &
monitor=$!
trap 'kill $monitor 2>/dev/null' EXIT
/usr/local/bin/osm_cells "$PBF" "$OUT/raw" "$OUT/report"
