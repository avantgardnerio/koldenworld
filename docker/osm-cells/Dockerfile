# The OSM splitter as a batch job (deploy/osm-batch.yml): SedonaDB's osm_cells example, built on the workstation
# (x86_64, Ubuntu 26.04, so the same glibc here) and copied in, with run.sh around it. deploy/osm-run.sh builds it:
#   docker build --build-context sedona=../sedona-db/target/release-nonlto/examples docker/osm-cells
FROM ubuntu:26.04
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sedona osm_cells /usr/local/bin/osm_cells
COPY run.sh monitor.sh /usr/local/bin/
ARG VERSION=unversioned
ENV OSM_CELLS_VERSION=$VERSION
ENTRYPOINT ["/usr/local/bin/run.sh"]
