#!/usr/bin/env bash
# Starts the game's certificate (deploy/cert.yml, us-east-1) and prints the DNS record ACM needs to issue it: a CNAME to
# add at deSEC, where squarelabs.net's DNS is (the koldenhome session runs it). The stack completes once ACM sees the
# record; deploy/deploy.sh then puts the domain on the distribution. Run once.
#
#   deploy/cert.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_PROFILE="${AWS_PROFILE-koldenworld}"
[ -n "$AWS_PROFILE" ] || unset AWS_PROFILE
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1

if ! aws cloudformation describe-stacks --stack-name koldenworld-cert >/dev/null 2>&1; then
  aws cloudformation create-stack --stack-name koldenworld-cert --template-body file://deploy/cert.yml >/dev/null
fi
# The certificate exists (pending validation) a few seconds after the stack starts.
for _ in $(seq 60); do
  arn="$(aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED \
    --query "CertificateSummaryList[?DomainName=='koldenworld.squarelabs.net'].CertificateArn | [0]" --output text)"
  [ "$arn" != None ] && [ -n "$arn" ] && break
  sleep 5
done
for _ in $(seq 60); do
  record="$(aws acm describe-certificate --certificate-arn "$arn" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Type,Name,Value]' --output text)"
  [ "$record" != None ] && [ -n "$record" ] && break
  sleep 5
done
echo "certificate $arn: $(aws acm describe-certificate --certificate-arn "$arn" --query Certificate.Status --output text)"
echo "validation record (type, name, value): $record"
