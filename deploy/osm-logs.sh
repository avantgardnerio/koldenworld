#!/usr/bin/env bash
# Follows a splitter job (deploy/osm-run.sh): its state until it starts, then its log (the run's progress and
# monitor.sh's machine stats, a line a minute each) until it ends, then where its report is.
#
#   deploy/osm-logs.sh <job id>
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE-koldenworld}"
[ -n "$AWS_PROFILE" ] || unset AWS_PROFILE
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2
# The CLI is Python: unbuffered, or a followed log sits in its buffer when piped.
export PYTHONUNBUFFERED=1
job="${1:?job id}"

describe() { aws batch describe-jobs --jobs "$job" --query "jobs[0].$1" --output text; }

state=""
while :; do
  now="$(describe status)"
  [ "$now" = "$state" ] || echo "$(date -u +%H:%M:%S) $now"
  state="$now"
  case "$state" in RUNNING | SUCCEEDED | FAILED) break ;; esac
  sleep 15
done

stream="$(describe container.logStreamName)"
if [ "$state" = RUNNING ]; then
  # Until the job ends; tail --follow never returns by itself.
  aws logs tail /koldenworld/osm-cells --log-stream-names "$stream" --follow --format short &
  tail=$!
  while [ "$(describe status)" = RUNNING ]; do sleep 30; done
  sleep 10
  kill "$tail"
else
  aws logs tail /koldenworld/osm-cells --log-stream-names "$stream" --since 1d --format short
fi
echo "$(describe status): $(describe statusReason)"
out="$(aws batch describe-jobs --jobs "$job" \
  --query "jobs[0].container.environment[?name=='OUT'].value | [0]" --output text)"
echo "report: aws s3 ls $out/report/"
