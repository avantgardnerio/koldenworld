#!/usr/bin/env bash
# Runs the OSM splitter on a planet as an AWS Batch job (deploy/osm-batch.yml): builds SedonaDB's osm_cells example
# here (../sedona-db, or SEDONA_DB), puts it in an image (docker/osm-cells) tagged with both repos' commits, updates
# the stack to it, and submits a job. Each run writes to its own folder,
#   s3://koldenworld-data-2/osm/planet-<date>/runs/<UTC time>-<tag>/{raw,report}
# raw/ the cell files (point the game at them with CELLGEN_OSM_S3=<folder>/raw deploy/deploy.sh), report/ each
# stage's plan with metrics and the run's log.
#
#   deploy/osm-run.sh [planet date, default 261116]      then follow it with deploy/osm-logs.sh <job id>
#   OSM_MAX_VCPUS=64 deploy/osm-run.sh                   room for two runs at once (sticks until set again)
#
# Credentials as deploy.sh's. Always us-east-2.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_PROFILE="${AWS_PROFILE-koldenworld}"
[ -n "$AWS_PROFILE" ] || unset AWS_PROFILE
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2

planet="${1:-261116}"
sedona="${SEDONA_DB:-../sedona-db}"
pbf="s3://osm-planet-us-west-2/planet/pbf/20${planet:0:2}/planet-$planet.osm.pbf"
bucket=koldenworld-data-2

output() {  # key
  aws cloudformation describe-stacks --stack-name koldenworld-osm \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
commit() {  # repo → its short commit, with -dirty when it has uncommitted changes
  local sha
  sha="$(git -C "$1" rev-parse --short=12 HEAD)"
  git -C "$1" diff --quiet HEAD -- || sha="$sha-dirty"
  echo "$sha"
}

echo "osm_cells ($sedona)"
cargo build --manifest-path "$sedona/Cargo.toml" -p sedona --profile release-nonlto \
  --no-default-features --features aws --example osm_cells

# Immutable tags: both commits, and a timestamp when either tree has uncommitted changes.
tag="game-$(commit .)-sedona-$(commit "$sedona")"
case "$tag" in *dirty*) tag="$tag-$(date -u +%Y%m%d%H%M%S)" ;; esac
account="$(aws sts get-caller-identity --query Account --output text)"
repo="$account.dkr.ecr.$AWS_REGION.amazonaws.com/koldenworld-osm-cells"

echo "stack, image $repo:$tag"
vpc="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
subnets="$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text | tr '\t' ,)"
aws cloudformation deploy --stack-name koldenworld-osm --template-file deploy/osm-batch.yml \
  --parameter-overrides "ImageUri=$repo:$tag" "VpcId=$vpc" "Subnets=$subnets" \
    ${OSM_MAX_VCPUS:+"MaxVcpus=$OSM_MAX_VCPUS"} \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset

aws ecr get-login-password | docker login --username AWS --password-stdin "${repo%%/*}"
docker build --build-context "sedona=$sedona/target/release-nonlto/examples" --build-arg "VERSION=$tag" \
  --tag "$repo:$tag" docker/osm-cells
docker push "$repo:$tag"

run="$(date -u +%Y%m%dT%H%M%SZ)-$tag"
out="s3://$bucket/osm/planet-$planet/runs/$run"
job="$(aws batch submit-job --job-name "osm-$planet-$(date -u +%Y%m%dT%H%M%S)" \
  --job-queue "$(output JobQueue)" --job-definition "$(output JobDefinition)" \
  --container-overrides "environment=[{name=PBF,value=$pbf},{name=OUT,value=$out}]" \
  --query jobId --output text)"
echo "job $job: $pbf → $out"
echo "follow: deploy/osm-logs.sh $job"
