# The game as one container (docs/serverless-plan.md, step 2): cellgen serve with the viewer's release build at /,
# cells at /ground/ (built from S3 on a miss, kept in S3) and live air traffic at /aircraft. The same image runs
# locally and on Lambda; only the credentials differ.
#
# Build from the repo root (.dockerignore keeps data/ and build outputs out of the context):
#   docker build -t koldenworld .
# Run locally against S3 with your AWS SSO session (`aws sso login --profile koldenworld` first):
#   docker run --rm -p 8080:8080 -v ~/.aws:/root/.aws:ro -e AWS_PROFILE=koldenworld koldenworld
# then open http://localhost:8080/.

FROM node:24-bookworm-slim AS viewer
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund --ignore-scripts
RUN npx vite build packages/viewer

FROM rust:1.99-bookworm AS server
# aws-lc-sys (the SDK's TLS crypto) builds C.
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake clang \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY crates/cellgen ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
    && cp target/release/cellgen /usr/local/bin/cellgen

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /usr/local/bin/cellgen /usr/local/bin/cellgen
COPY --from=viewer /src/packages/viewer/dist /site
# The cell build recurses deeply on big cells.
ENV RUST_MIN_STACK=104857600 PORT=8080
EXPOSE 8080
CMD ["cellgen", "serve", "--host", "0.0.0.0", "--static", "/site"]
