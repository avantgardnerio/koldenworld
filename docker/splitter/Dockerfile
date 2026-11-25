# The area splitter: osmium assembles OSM shapes, DuckDB tags them with S2 areas and writes them out.
# Build from this folder so data/ isn't sent as context:
#   docker build -t koldenworld-splitter docker/splitter
# Run with the data folder mounted, as yourself so outputs aren't root's:
#   docker run --rm --memory 64g -u "$(id -u):$(id -g)" -v "$PWD/data:/data" koldenworld-splitter duckdb
FROM debian:trixie-slim

ARG DUCKDB_VERSION=1.5.5

RUN apt-get update \
    && apt-get install -y --no-install-recommends osmium-tool awscli ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Debian's architecture names (amd64, arm64) are also DuckDB's.
RUN curl -fsSL -o /tmp/duckdb.zip \
        "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-$(dpkg --print-architecture).zip" \
    && unzip /tmp/duckdb.zip -d /opt/duckdb \
    && rm /tmp/duckdb.zip

# Extensions are baked in, not fetched on first use, in a fixed folder so any user id finds them.
RUN /opt/duckdb/duckdb -c "SET extension_directory = '/opt/duckdb/extensions'; \
        INSTALL spatial; INSTALL httpfs; INSTALL geography FROM community;" \
    && chmod -R a+rX /opt/duckdb

RUN printf '#!/bin/sh\nexec /opt/duckdb/duckdb -cmd "SET extension_directory = '"'"'/opt/duckdb/extensions'"'"'; SET autoinstall_known_extensions = false;" "$@"\n' \
        > /usr/local/bin/duckdb \
    && chmod +x /usr/local/bin/duckdb

# Closed ways are lines only for these tags (else a building outline would come out as both a line and an area).
COPY osm-export.json /opt/splitter/osm-export.json
COPY split-osm.sh merge-split.sh /usr/local/bin/

WORKDIR /data
