#!/usr/bin/env bash
# The machine while a run goes, a line every MONITOR_SECS (60 by default; ~90 lines for 1.5 h): CPU used and how
# (user, system, waiting on disk), how many cores are over half busy (one busy core of 32 is a serial bottleneck),
# load, memory, disk and network rates, and /scratch used (the download and the spill).
#
#   [  1260 s] cpu 82% (usr 77 sys 4 iowait 1) busy 27/32 load 29.4 | mem 181/247 GB | disk r 120 w 880 MB/s |
#     net in 610 out 4 MB/s | scratch 412 GB
set -uo pipefail
secs="${MONITOR_SECS:-60}"
start=$(date +%s)

# cpu lines of /proc/stat as "name busy total"; the disks' sectors read and written (whole NVMe devices); bytes in
# and out of every interface but lo.
cpus() { awk '/^cpu/ { t = 0; for (i = 2; i <= 9; i++) t += $i; print $1, t - $5 - $6, t, $2 + $3, $4, $6 }' /proc/stat; }
disk() { awk '$3 ~ /^nvme[0-9]+n[0-9]+$/ { r += $6; w += $10 } END { print r + 0, w + 0 }' /proc/diskstats; }
net() { awk -F'[: ]+' 'NR > 2 && $2 != "lo" { i += $3; o += $11 } END { print i + 0, o + 0 }' /proc/net/dev; }

prev_cpus=$(cpus) prev_disk=$(disk) prev_net=$(net)
while sleep "$secs"; do
  now_cpus=$(cpus) now_disk=$(disk) now_net=$(net)
  cpu=$(paste -d' ' <(echo "$prev_cpus") <(echo "$now_cpus") | awk '
    # fields: name busy total usr+nice sys iowait, before then now
    { busy = $8 - $2; total = $9 - $3; if (total <= 0) next }
    $1 == "cpu" { printf "cpu %d%% (usr %d sys %d iowait %d)", 100 * busy / total, 100 * ($10 - $4) / total,
                    100 * ($11 - $5) / total, 100 * ($12 - $6) / total; next }
    { cores++; if (busy / total > 0.5) hot++ }
    END { printf " busy %d/%d", hot, cores }')
  read -r dr dw <<<"$(paste -d' ' <(echo "$prev_disk") <(echo "$now_disk") |
    awk -v s="$secs" '{ printf "%d %d", ($3 - $1) * 512 / 1e6 / s, ($4 - $2) * 512 / 1e6 / s }')"
  read -r ni no <<<"$(paste -d' ' <(echo "$prev_net") <(echo "$now_net") |
    awk -v s="$secs" '{ printf "%d %d", ($3 - $1) / 1e6 / s, ($4 - $2) / 1e6 / s }')"
  mem=$(awk '/^MemTotal/ { t = $2 } /^MemAvailable/ { a = $2 } END { printf "%d/%d GB", (t - a) / 1048576, t / 1048576 }' /proc/meminfo)
  scratch=$(df -BG --output=used /scratch 2>/dev/null | tail -1 | tr -d ' G')
  printf '[%6d s] %s load %s | mem %s | disk r %d w %d MB/s | net in %d out %d MB/s | scratch %s GB\n' \
    $(($(date +%s) - start)) "$cpu" "$(cut -d' ' -f1 /proc/loadavg)" "$mem" "$dr" "$dw" "$ni" "$no" "${scratch:-?}"
  prev_cpus=$now_cpus prev_disk=$now_disk prev_net=$now_net
done
