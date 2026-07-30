# Market Marathon — Bar Chart Race renderer (one-click cloud render)

This folder builds the **full-length bar chart race video** for you on GitHub's free servers.
You don't need to install anything. It renders at 1920×1080, sharp, with the music, event
images, logos and Subscribe/Like/Comment outro all built in.

---

## How to render the video (about 4 clicks)

1. **Create a free GitHub account** at https://github.com (skip if you have one).

2. **Create a new repository:**
   - Click the **+** (top-right) → **New repository**.
   - Name it e.g. `market-marathon-uk`, set it to **Private**, click **Create repository**.

3. **Upload these files:**
   - On the new repo page click **uploading an existing file**.
   - Drag in **everything inside this folder** (including the `.github`, `fonts`, `company_logos`
     folders). Wait for them to finish, then click **Commit changes**.

4. **Run the render:**
   - Click the **Actions** tab → if prompted, click **"I understand my workflows, enable them"**.
   - Click **Render bar chart race** (left) → **Run workflow** → **Run workflow**.
   - It now builds the video (roughly **1–2 hours** — you can close the tab).

5. **Download the finished video:**
   - When the run has a green tick, go to the **Releases** section of the repo (right-hand side of
     the main repo page, or the "Releases" link) and download **`master.mp4`**.

That's it. 🎬

---

## Making a different country / channel later

Everything is driven by three things, so a new video only needs new inputs:

- **`uk_race.json`** — the data (labels, sub-sectors, colours, yearly values).
- **`config.json`** — the title, subtitle, currency, music file, and `file_prefix`
  (e.g. change `"UK"` → `"FR"` and the event images `FR_1996_Q1.png` … will be pulled instead).
- The **event images** are pulled automatically from your Cloudinary library by `fetch_panels.sh`
  (folder `raceimg/`), so nothing large is stored here.

Swap those, commit, and Run workflow again.

## Settings you might tweak in `config.json`

- `year_sec` — seconds per year (80 = 20s per quarter, the current pace). Lower = shorter video.
- `fps` — 30 (default, smooth at this pace) or 60 (smoother, ~2× render time).
- `crf` — quality (lower = higher quality/bigger file; 16 is high quality).
- `music` — the filename of the background track in this folder.

## What's in here

- `racekit_full.js` — the renderer (Node + resvg + ffmpeg).
- `config.json`, `uk_race.json`, `quarter_manifest.json` — settings + data.
- `fonts/`, `company_logos/`, `logo.png`, `logos.json`, `subsector_icons.json`, `Emotional.mp3` — assets.
- `.github/workflows/render.yml` — the one-click cloud render job.
