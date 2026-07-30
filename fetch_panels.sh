#!/usr/bin/env bash
# Downloads the quarterly event images from Cloudinary into ./panels (at 870px).
# Keeps the repository small — the images live in your Cloudinary library.
set -e
mkdir -p panels
python3 - <<'PY'
import json, urllib.request, os
CLOUD = os.environ.get("CLOUD_NAME", "ln2nbbxz")
m = json.load(open("quarter_manifest.json"))
n = 0
for x in m:
    f = x["file"]
    url = f"https://res.cloudinary.com/{CLOUD}/image/upload/w_870,h_870,c_fill,f_png/raceimg/{f}.png"
    dst = f"panels/{f}.png"
    if os.path.exists(dst) and os.path.getsize(dst) > 5000:
        n += 1; continue
    urllib.request.urlretrieve(url, dst)
    n += 1
print("panels ready:", n)
PY
