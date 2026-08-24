#!/usr/bin/env python3
"""
Upload a finished Market Marathon render straight to YouTube as a PRIVATE video.

Runs on the GitHub Actions runner at the end of a render, so the master mp4
never has to be downloaded to review it. Stdlib only, no pip install.

Credentials come from the environment (set them as GitHub repository secrets):
    YT_CLIENT_ID
    YT_CLIENT_SECRET
    YT_REFRESH_TOKEN

Usage:
    python3 yt_upload.py --file master.mp4 --title "..." [--desc-file desc.txt]
                         [--tags "a,b,c"] [--privacy private] [--category 25]
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = ("https://www.googleapis.com/upload/youtube/v3/videos"
              "?uploadType=resumable&part=snippet,status")
CHUNK = 8 * 1024 * 1024  # 8 MB


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def get_access_token():
    for key in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"):
        if not os.environ.get(key):
            die(f"{key} is not set. Add it as a GitHub repository secret and "
                f"pass it into this step's env block.")
    body = urllib.parse.urlencode({
        "client_id": os.environ["YT_CLIENT_ID"],
        "client_secret": os.environ["YT_CLIENT_SECRET"],
        "refresh_token": os.environ["YT_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            tok = json.load(r).get("access_token")
    except urllib.error.HTTPError as e:
        die(f"token refresh failed ({e.code}): {e.read().decode(errors='replace')}")
    if not tok:
        die("token refresh returned no access_token")
    print("Access token obtained.")
    return tok


def start_session(token, meta):
    data = json.dumps(meta).encode()
    req = urllib.request.Request(UPLOAD_URL, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json; charset=UTF-8")
    req.add_header("X-Upload-Content-Type", "video/*")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            loc = r.headers.get("Location")
    except urllib.error.HTTPError as e:
        die(f"could not open upload session ({e.code}): "
            f"{e.read().decode(errors='replace')}")
    if not loc:
        die("upload session returned no Location header")
    return loc


def upload(session_url, path):
    """Chunked resumable upload with retry on the transient 5xx codes."""
    total = os.path.getsize(path)
    sent = 0
    attempts = 0
    with open(path, "rb") as fh:
        while sent < total:
            fh.seek(sent)
            block = fh.read(CHUNK)
            end = sent + len(block) - 1
            req = urllib.request.Request(session_url, data=block, method="PUT")
            req.add_header("Content-Length", str(len(block)))
            req.add_header("Content-Range", f"bytes {sent}-{end}/{total}")
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    payload = json.load(r)
                    print(f"Upload complete: {total / 1e6:.1f} MB")
                    return payload
            except urllib.error.HTTPError as e:
                if e.code == 308:  # incomplete, carry on
                    rng = e.headers.get("Range")
                    sent = int(rng.split("-")[1]) + 1 if rng else sent + len(block)
                    attempts = 0
                    pct = 100.0 * sent / total
                    print(f"  {sent / 1e6:8.1f} / {total / 1e6:.1f} MB  ({pct:5.1f}%)")
                    continue
                if e.code in (500, 502, 503, 504) and attempts < 6:
                    attempts += 1
                    wait = 2 ** attempts
                    print(f"  transient {e.code}, retry {attempts} in {wait}s")
                    time.sleep(wait)
                    continue
                die(f"upload failed ({e.code}): {e.read().decode(errors='replace')}")
            except (urllib.error.URLError, TimeoutError) as e:
                if attempts < 6:
                    attempts += 1
                    wait = 2 ** attempts
                    print(f"  network error ({e}), retry {attempts} in {wait}s")
                    time.sleep(wait)
                    continue
                die(f"upload failed after retries: {e}")
    die("upload loop ended without a response from YouTube")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--desc-file")
    p.add_argument("--desc", default="")
    p.add_argument("--tags", default="")
    p.add_argument("--privacy", default="private",
                   choices=["private", "unlisted", "public"])
    p.add_argument("--category", default="25")  # 25 = News & Politics
    p.add_argument("--language", default="en")
    a = p.parse_args()

    if not os.path.isfile(a.file):
        die(f"{a.file} not found")

    desc = a.desc
    if a.desc_file:
        if not os.path.isfile(a.desc_file):
            die(f"{a.desc_file} not found")
        with open(a.desc_file, encoding="utf-8") as fh:
            desc = fh.read()

    meta = {
        "snippet": {
            "title": a.title[:100],
            "description": desc[:5000],
            "tags": [t.strip() for t in a.tags.split(",") if t.strip()],
            "categoryId": a.category,
            "defaultLanguage": a.language,
            "defaultAudioLanguage": a.language,
        },
        "status": {
            "privacyStatus": a.privacy,
            "selfDeclaredMadeForKids": False,
            "embeddable": True,
        },
    }

    size = os.path.getsize(a.file) / 1e6
    print(f"Uploading {a.file} ({size:.1f} MB) as {a.privacy}: {a.title}")

    token = get_access_token()
    session_url = start_session(token, meta)
    result = upload(session_url, a.file)

    vid = result.get("id")
    if not vid:
        die(f"no video id in response: {json.dumps(result)[:500]}")
    watch = f"https://www.youtube.com/watch?v={vid}"
    studio = f"https://studio.youtube.com/video/{vid}/edit"
    print(f"\nVideo id: {vid}\nWatch:    {watch}\nStudio:   {studio}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"### Private upload ready\n\n"
                     f"- **Watch:** {watch}\n"
                     f"- **Edit in Studio:** {studio}\n"
                     f"- Privacy: `{a.privacy}` — nothing is public until you change it.\n")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"video_id={vid}\nwatch_url={watch}\n")


if __name__ == "__main__":
    main()
