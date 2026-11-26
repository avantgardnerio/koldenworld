#!/usr/bin/env bash
# Deploys the game: the image repository (deploy/repo.yml), the arm64 image (Dockerfile) tagged with the commit,
# then the function behind CloudFront (deploy/app.yml), and clears CloudFront's cache. The same steps a pipeline
# will run. Once the certificate (deploy/cert.sh) is issued, the distribution answers koldenworld.squarelabs.net too.
#
#   deploy/deploy.sh
#
# Credentials: the AWS CLI's usual ones (AWS_PROFILE=koldenworld by default, after `aws sso login`). Always us-east-2,
# where the bucket is, whatever AWS_REGION says.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_PROFILE="${AWS_PROFILE-koldenworld}"
[ -n "$AWS_PROFILE" ] || unset AWS_PROFILE  # AWS_PROFILE= (empty): the environment's credentials, as in CI
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2

output() {  # stack, output key[, region]
  aws cloudformation describe-stacks --stack-name "$1" ${3:+--region "$3"} \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true
}

# Immutable tags: the commit, and a timestamp when the tree has uncommitted changes.
tag="$(git rev-parse --short=12 HEAD)"
git diff --quiet HEAD -- || tag="$tag-dirty-$(date +%Y%m%d%H%M%S)"

echo "repository"
aws cloudformation deploy --stack-name koldenworld-repo --template-file deploy/repo.yml --no-fail-on-empty-changeset
repo="$(output koldenworld-repo RepositoryUri)"

echo "image $repo:$tag"
aws ecr get-login-password | docker login --username AWS --password-stdin "${repo%%/*}"
# One platform, no attestations: Lambda takes a single image manifest.
docker buildx build --platform linux/arm64 --provenance=false --tag "$repo:$tag" --push .

# The certificate, once issued (its stack completes when ACM sees the validation record).
cert=""
if [ "$(aws cloudformation describe-stacks --stack-name koldenworld-cert --region us-east-1 \
        --query 'Stacks[0].StackStatus' --output text 2>/dev/null)" = CREATE_COMPLETE ]; then
  cert="$(output koldenworld-cert CertificateArn us-east-1)"
fi
echo "function and distribution${cert:+ (with the domain)}"
aws cloudformation deploy --stack-name koldenworld --template-file deploy/app.yml \
  --parameter-overrides "ImageUri=$repo:$tag" "CertificateArn=$cert" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset

# New code may answer differently for the same paths: clear CloudFront's copies.
aws cloudfront create-invalidation --distribution-id "$(output koldenworld DistributionId)" --paths '/*' \
  --query Invalidation.Id --output text >/dev/null
echo "$(output koldenworld Url)  (CloudFront: $(output koldenworld DistributionDomain))"
