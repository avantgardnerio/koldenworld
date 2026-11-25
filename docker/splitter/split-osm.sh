#!/bin/bash
# Splits an OSM extract into one GeoParquet file per level-6 S2 cell (~140 km), in three steps:
#   1. shapes: osmium assembles shapes and writes them to a pipe; DuckDB tags each with its cells and streams
#      them into plain Parquet files, 2 GB each, in input order. Nothing is grouped, so memory stays low.
#   2. partition: DuckDB regroups those files by level-6 cell, unsorted, with osmium gone and all the memory.
#   3. sort: each cell's rows are sorted on their own, several cells at once; each sort fits in memory.
#   split-osm.sh <in.osm.pbf> <out dir>
# Output: <out>/coarse=<level-6 token>/data_0.parquet, rows sorted by the S2 leaf cell of each shape's centroid,
# so an area's rows are contiguous and readers fetch them by row-group statistics on `cell` or `bbox`.
# A shape crossing a level-6 edge is written whole into each cell it touches; nothing is clipped.
#
# Why step 1 doesn't partition: DuckDB's partitioned COPY holds every partition until its input ends, then
# writes them all. Fed straight from osmium, that is the whole planet in DuckDB while osmium's node index is
# still resident; the first planet run died there, after 93 minutes, at the final flush.
#
# Memory: osmium's node index is 8 bytes per node id up to the highest one (~108 GB for the planet). By default
# it's an anonymous memory map, so it needs that much RAM; on a smaller machine set
# INDEX=dense_file_array,<path> to keep it in a file the OS can page out. SHAPES_MEM bounds DuckDB beside
# osmium in step 1, PARTITION_MEM bounds step 2, and SORT_MEM/JOBS each sort in step 3; all spill to TMP.
#
# If osmium dies, the pipe just ends and DuckDB would write what it got as if complete; pipefail makes that an
# error. Step 1's files are marked done only when it succeeded, and a rerun with the same TMP skips step 1 if
# they are. The output is renamed into place only once every step succeeded, with as many rows as step 1 wrote.
#
# With UPLOAD=s3://bucket/prefix, step 1's shapes are copied to <prefix>/shapes/ as a checkpoint, and each
# sorted cell goes to <prefix>/cells/ as soon as it's written.
set -euo pipefail

in=$1
out=$2
# A row group is held in memory until it's written, so it's capped in bytes too: near the end of the input,
# 100,000 rows of large areas were tens of GB, and the first try at step 1 ran out at 40 GB.
SHAPES_MEM=${SHAPES_MEM:-90GB}
PARTITION_MEM=${PARTITION_MEM:-200GB}
SORT_MEM=${SORT_MEM:-160}
JOBS=${JOBS:-$(($(nproc) / 2))}
TMP=${TMP:-$out.tmp}
INDEX=${INDEX:-dense_mmap_array}
# Step 2 keeps a file open per cell it has seen; the planet has thousands. DuckDB's default of 100 would keep
# closing and reopening them, leaving each cell in many small pieces.
OPEN_FILES=${OPEN_FILES:-20000}
UPLOAD=${UPLOAD:-}
export AWS_MAX_ATTEMPTS=20 AWS_RETRY_MODE=adaptive

main() {
    ulimit -n $((OPEN_FILES + 1000))
    rm -rf "$out.partial" "$TMP/cells"
    mkdir -p "$out.partial" "$TMP"

    if [ -f "$TMP/shapes.done" ]; then
        echo "$(date +%T) step 1: shapes already done, skipping"
    else
        rm -rf "$TMP/shapes"
        echo "$(date +%T) step 1: shapes"
        shapes
        touch "$TMP/shapes.done"
    fi
    local rows
    rows=$(count_rows "$TMP/shapes/*.parquet")
    echo "$(date +%T) step 1 done: $rows rows"
    if [ -n "$UPLOAD" ]; then
        echo "$(date +%T) checkpoint: uploading shapes"
        aws s3 sync --only-show-errors "$TMP/shapes" "$UPLOAD/shapes"
        echo "$(date +%T) checkpoint done"
    fi

    echo "$(date +%T) step 2: partition"
    partition
    local partitioned
    partitioned=$(count_rows "$TMP/cells/*/*.parquet")
    check_rows "$rows" "$partitioned" partition
    echo "$(date +%T) step 2 done: $partitioned rows in $(ls "$TMP/cells" | wc -l) cells"

    echo "$(date +%T) step 3: sort each cell, $JOBS at a time"
    export -f sort_cell
    export out TMP SORT_MEM JOBS UPLOAD
    ls "$TMP/cells" | xargs -P "$JOBS" -I{} bash -c 'sort_cell "$1"' _ {}
    local sorted
    sorted=$(count_rows "$out.partial/*/*.parquet")
    check_rows "$rows" "$sorted" sort
    echo "$(date +%T) step 3 done: $sorted rows"

    largest_shapes
    rm -rf "$TMP" "$out"
    mv "$out.partial" "$out"
}

shapes() {
    osmium export "$in" -c /opt/splitter/osm-export.json -i "$INDEX" -f pg -x tags_type=json --add-unique-id=type_id -o - |
    duckdb -c "
SET memory_limit = '$SHAPES_MEM';
SET temp_directory = '$TMP';
SET preserve_insertion_order = false;
LOAD spatial;
LOAD geography;

COPY (
    WITH shapes AS (
        SELECT
            id,
            ST_GeomFromHEXEWKB(wkb) AS geom,
            -- osmium's pg format escapes backslashes for COPY; undo that to get plain JSON
            replace(tags, '\\\\', '\\')::JSON AS tags
        FROM read_csv('/dev/stdin', auto_detect = false, delim = '\t', quote = '', escape = '', header = false,
            max_line_size = 500000000, columns = {'id': 'VARCHAR', 'wkb': 'VARCHAR', 'tags': 'VARCHAR'})
    ),
    kept AS (
        -- administrative boundaries cover whole states and countries; nothing in a cell needs them
        SELECT * FROM shapes
        WHERE json_extract_string(tags, 'boundary') IS NULL
           OR json_extract_string(tags, 'boundary') IN ('national_park', 'protected_area', 'aboriginal_lands', 'forest')
           OR coalesce(json_extract_string(tags, 'natural'), json_extract_string(tags, 'waterway'),
                       json_extract_string(tags, 'highway'), json_extract_string(tags, 'landuse')) IS NOT NULL
    )
    SELECT
        -- as plain integers: Parquet doesn't keep the geography extension's S2_CELL type
        s2_covering_fixed_level(s2_geogfromwkb_novalidate(ST_AsWKB(geom)), 6)::S2_CELL[]::UBIGINT[] AS coarse,
        s2_cellfromwkb(ST_AsWKB(ST_Centroid(geom)))::UBIGINT AS cell,
        id,
        {'xmin': ST_XMin(geom), 'ymin': ST_YMin(geom), 'xmax': ST_XMax(geom), 'ymax': ST_YMax(geom)} AS bbox,
        tags,
        geom
    FROM kept
) TO '$TMP/shapes' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000, ROW_GROUP_SIZE_BYTES '256MB',
    FILE_SIZE_BYTES '2GB');
"
}

# One row per (shape, cell it touches), grouped into a folder per cell.
partition() {
    duckdb -c "
SET memory_limit = '$PARTITION_MEM';
SET temp_directory = '$TMP';
SET preserve_insertion_order = false;
SET partitioned_write_max_open_files = $OPEN_FILES;
LOAD spatial;
LOAD geography;

COPY (
    SELECT s2_cell_token(u.coarse::S2_CELL) AS coarse, cell, id, bbox, tags, geom
    FROM read_parquet('$TMP/shapes/*.parquet'), unnest(coarse) AS u(coarse)
) TO '$TMP/cells' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2000, PARTITION_BY (coarse), OVERWRITE_OR_IGNORE);
"
}

# Sorts one cell's unsorted pieces into its final file, then deletes the pieces.
sort_cell() {
    local dir=$1
    mkdir -p "$out.partial/$dir"
    duckdb -c "
SET memory_limit = '$((SORT_MEM / JOBS))GB';
SET temp_directory = '$TMP/sort-$dir';
SET threads = 2;
LOAD spatial;
COPY (
    SELECT * FROM read_parquet('$TMP/cells/$dir/*.parquet', hive_partitioning = false)
    ORDER BY cell
) TO '$out.partial/$dir/data_0.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2000);
"
    rm -rf "$TMP/cells/$dir" "$TMP/sort-$dir"
    if [ -n "$UPLOAD" ]; then
        aws s3 cp --only-show-errors "$out.partial/$dir/data_0.parquet" "$UPLOAD/cells/$dir/data_0.parquet"
    fi
}

count_rows() {
    duckdb -noheader -csv -c "SELECT sum(num_rows)::BIGINT FROM parquet_file_metadata('$1')"
}

# Step 1 has one row per shape and the later steps one per (shape, cell), so the expected count is the
# shapes' cells summed, not their rows.
check_rows() {
    local shapes=$1 got=$2 step=$3 expected
    expected=$(duckdb -noheader -csv -c "LOAD geography; SELECT sum(len(coarse))::BIGINT FROM read_parquet('$TMP/shapes/*.parquet')")
    if [ "$got" != "$expected" ]; then
        echo "row count changed in the $step: $expected (shape, cell) pairs from $shapes shapes, $got after" >&2
        exit 1
    fi
}

# Shapes copied into the most cells, to see whether giant polygons inflate the output.
largest_shapes() {
    echo "shapes in the most cells:"
    duckdb -c "
LOAD geography;
SELECT id, len(coarse) AS cells, json_extract_string(tags, 'name') AS name
FROM read_parquet('$TMP/shapes/*.parquet')
ORDER BY cells DESC LIMIT 20;
"
}

main
