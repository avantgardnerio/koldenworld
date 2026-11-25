#!/bin/sh
# Merges per-continent splits (from split-osm.sh) into one set of level-6 cell files.
#   merge-split.sh <out dir> <split dir>...
# Geofabrik's continent extracts overlap at their borders, so a cell near one is in two splits, and shapes
# near the border are in both. Such a cell is rewritten keeping one row per OSM id (the copy with the most
# points, in case one extract only had part of a relation) and sorted by cell again. A cell in one split only
# is hard-linked, so the merge costs nothing away from borders.
set -eu

out=$1
shift
MEM=${MEM:-50GB}

mkdir -p "$out"

for token in $(for d in "$@"; do ls "$d"; done | sort | uniq); do
    files=""
    for d in "$@"; do
        if [ -f "$d/$token/data_0.parquet" ]; then
            files="$files${files:+, }'$d/$token/data_0.parquet'"
        fi
    done
    mkdir -p "$out/$token"
    case "$files" in
    *,*)
        echo "merging $token"
        duckdb -c "
SET memory_limit = '$MEM';
LOAD spatial;
COPY (
    SELECT * EXCLUDE (coarse) FROM read_parquet([$files], hive_partitioning = true)
    QUALIFY row_number() OVER (PARTITION BY id ORDER BY ST_NPoints(geom) DESC) = 1
    ORDER BY cell
) TO '$out/$token/data_0.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2000);
"
        ;;
    *)
        ln -f "$(echo "$files" | tr -d "'")" "$out/$token/data_0.parquet"
        ;;
    esac
done
