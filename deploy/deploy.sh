#!/usr/bin/env bash
# Deploys the game: the image repository (deploy/repo.yml), the arm64 image (Dockerfile) tagged with the commit,
# then the function behind CloudFront (deploy/app.yml), applies the database's migrations, and clears CloudFront's
# cache. The same steps a pipeline will run. Once the certificate (deploy/cert.sh) is issued, the distribution answers
# koldenworld.squarelabs.net too.
#
# Sign-in with Google is on once SSM has the OAuth client: /koldenworld/google-client-id (String) and
# /koldenworld/google-client-secret (SecureString), put there by hand once. The key that signs CloudFront cookies is
# made here the first time, straight into SSM (/koldenworld/cloudfront-key).
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

# Sign-in: the client's id, if it's there, and the cookie key's public half (the key made once, never on disk).
client_id="$(aws ssm get-parameter --name /koldenworld/google-client-id --query Parameter.Value --output text \
  2>/dev/null || true)"
public_key=""
if [ -n "$client_id" ]; then
  if ! aws ssm get-parameter --name /koldenworld/cloudfront-key >/dev/null 2>&1; then
    echo "making the CloudFront cookie key"
    openssl genrsa -traditional 2048 2>/dev/null |
      aws ssm put-parameter --name /koldenworld/cloudfront-key --type SecureString --value file:///dev/stdin >/dev/null
  fi
  public_key="$(aws ssm get-parameter --name /koldenworld/cloudfront-key --with-decryption \
    --query Parameter.Value --output text | openssl rsa -pubout 2>/dev/null)"
fi

echo "function and distribution${cert:+ (with the domain)}${client_id:+ (with sign-in)}"
aws cloudformation deploy --stack-name koldenworld --template-file deploy/app.yml \
  --parameter-overrides "ImageUri=$repo:$tag" "CertificateArn=$cert" \
    "GoogleClientId=$client_id" "CloudFrontPublicKey=$public_key" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset

echo "database"
cargo run --quiet --manifest-path crates/cellgen/Cargo.toml -- migrate \
  "$(output koldenworld DatabaseEndpoint)" "$(output koldenworld RoleArn)"

# New code may answer differently for the same paths: clear CloudFront's copies.
aws cloudfront create-invalidation --distribution-id "$(output koldenworld DistributionId)" --paths '/*' \
  --query Invalidation.Id --output text >/dev/null
echo "$(output koldenworld Url)  (CloudFront: $(output koldenworld DistributionDomain))"
