# The game as one container (docs/serverless-plan.md, step 2): cellgen serve with the viewer's release build at /,
# cells at /ground/ (built from S3 on a miss, kept in S3) and live air traffic at /aircraft. The same image runs
# locally and on Lambda (the Lambda Web Adapter turns invocations into HTTP requests; elsewhere it's idle); only the
# credentials differ.
#
# Builds for any platform without emulation: the build stages run natively and cellgen is cross-compiled for the
# target (amd64 or arm64); the final stage only copies files in. Build from the repo root (.dockerignore keeps data/
# and build outputs out of the context):
#   docker build -t koldenworld .                                   # this machine's platform, to run locally
#   docker buildx build --platform linux/arm64 ...                  # for Lambda (deploy/deploy.sh does this)
# Run locally against S3 with your AWS SSO session (`aws sso login --profile koldenworld` first):
#   docker run --rm -p 8080:8080 -v ~/.aws:/root/.aws:ro -e AWS_PROFILE=koldenworld koldenworld
# then open http://localhost:8080/.

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS viewer
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund --ignore-scripts
RUN npx vite build packages/viewer

FROM --platform=$BUILDPLATFORM rust:1.99-bookworm AS server
ARG TARGETARCH
# aws-lc-sys (the SDK's TLS crypto) builds C, for the target too.
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake clang ca-certificates gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++ \
    AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
WORKDIR /src
COPY crates/cellgen ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    case "$TARGETARCH" in \
      arm64) target=aarch64-unknown-linux-gnu ;; \
      amd64) target=x86_64-unknown-linux-gnu ;; \
      *) echo "no Rust target for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && cargo build --release --locked --target "$target" \
    && cp "target/$target/release/cellgen" /usr/local/bin/cellgen

FROM debian:bookworm-slim
# TLS roots, from the build stage: nothing runs in this stage, so it builds for any platform without emulation.
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
COPY --from=server /usr/local/bin/cellgen /usr/local/bin/cellgen
COPY --from=viewer /src/packages/viewer/dist /site
# The cell build recurses deeply on big cells. PORT is where the server listens, and where the adapter sends requests.
ENV RUST_MIN_STACK=104857600 PORT=8080
EXPOSE 8080
CMD ["cellgen", "serve", "--host", "0.0.0.0", "--static", "/site"]
