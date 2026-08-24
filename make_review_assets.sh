#!/usr/bin/env bash
# Build the small review files that let Luke check a render without touching
# the full master: a 720p low-bitrate copy and a contact sheet of stills,
# one frame per quarter of the race.
#
# Usage: ./make_review_assets.sh master.mp4 [seconds_per_quarter] [out_dir]
set -euo pipefail

MASTER="${1:?usage: make_review_assets.sh master.mp4 [seconds_per_quarter] [out_dir]}"
SPQ="${2:-20}"          # RaceKit pace: 20 seconds per quarter
OUT="${3:-review}"

[ -f "$MASTER" ] || { echo "ERROR: $MASTER not found" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not on PATH" >&2; exit 1; }

mkdir -p "$OUT"

echo "== 720p review copy =="
# ultrafast because the runner has 2 cores and the master is already the slow part.
# crf 30 with a hard cap keeps a 40 minute race at roughly 80-150 MB.
ffmpeg -y -hide_banner -loglevel warning -i "$MASTER" \
  -vf "scale=1280:720:flags=fast_bilinear" \
  -c:v libx264 -preset ultrafast -crf 30 -maxrate 700k -bufsize 1400k -g 250 \
  -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart \
  "$OUT/review_720p.mp4"

echo "== contact sheet, one frame per quarter =="
# fps=1/SPQ lands one still in each quarter; 24 stills per page at 480x270.
ffmpeg -y -hide_banner -loglevel warning -i "$MASTER" \
  -vf "fps=1/${SPQ},scale=480:270,tile=4x6:padding=4:margin=8:color=0x0F1420" \
  -an "$OUT/frames_page_%02d.png"

echo
echo "== review files =="
ls -lh "$OUT" | awk 'NR>1 {print "  " $9 "  " $5}'
echo
echo "Master:      $(du -h "$MASTER" | cut -f1)"
echo "Review copy: $(du -h "$OUT/review_720p.mp4" | cut -f1)"
