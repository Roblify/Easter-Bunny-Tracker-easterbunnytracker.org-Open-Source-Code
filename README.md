# 🐰 Easter Bunny Tracker

The official open-source codebase for [easterbunnytracker.org](https://easterbunnytracker.org) — a real-time, interactive map experience that follows the Easter Bunny as he delivers eggs and baskets around the world.

> **2026** marks the first official year of live Easter Bunny tracking. Development began in 2025.

---

## ✨ Features

- **Live Tracking** — The Easter Bunny's position is interpolated in real time between route stops using precise Unix timestamps
- **HUD Stats** — Live updates for status, speed (MPH or KM/H), eggs delivered, carrots eaten, and arrival estimates
- **City Info Panel** — Displays local time, population, elevation, Wikipedia link, and travel direction for the current city
- **Basket Markers** — Dropped on the map at each stop the Bunny has already visited
- **Egg Animation** — A floating egg FX follows the Bunny while he is delivering
- **Cinematic Camera** — Optional side-tracking camera angle with adjustable offset and zoom
- **2D / 3D Map** — Toggle between a flat Mercator map and a 3D globe with atmosphere and star effects
- **Map Styles** — Switch between Standard and Satellite map styles
- **Streamer Mode** — Hides the viewer arrival estimate to prevent location inference on streams
- **Background Music** — Looping Easter-themed audio with autoplay fallback handling
- **Persistent Settings** — All user preferences are saved to `localStorage` automatically

---

## 🗂️ Project Structure

```
/
├── assets/
│   ├── audio/          # Background music
│   └── img/            # Bunny, Basket, and Egg images
├── css/
│   ├── style.css       # Main tracker styles
│   └── countdown.css   # Countdown page styles
├── data/
│   └── route.json      # The Easter Bunny's full route data
├── js/
│   ├── config.js       # Constants, settings persistence, user preferences
│   ├── utils.js        # Pure helpers (formatting, math, geographic)
│   ├── data.js         # Stop accessors, label builders, route loading
│   ├── tracker.js      # Segment logic — the brain of the tracker
│   ├── viewer.js       # IP-based viewer location lookup
│   ├── main.js         # App init (Mapbox map, HUD, markers, tick loop)
│   └── countdown.js    # Countdown timer logic
├── tools/              # Python utility scripts (route processing)
├── index.html          # Pre-journey countdown page
├── tracker.html        # Main live tracker page
├── FAQ.html
├── privacy.html
├── terms.html
└── 404.html
```

---

## 🚀 Getting Started

### Prerequisites

You will need API keys for two external services:

| Service | Purpose | Sign up |
|---|---|---|
| [Mapbox](https://www.mapbox.com/) | Interactive map rendering | mapbox.com |
| [ipinfo.io](https://ipinfo.io/) | Viewer location for arrival estimate | ipinfo.io |

Both services have free tiers that are sufficient for running the tracker.

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/Roblify/Easter-Bunny-Tracker-easterbunnytracker.org-Open-Source-Code.git
   cd Easter-Bunny-Tracker-easterbunnytracker.org-Open-Source-Code
   ```

2. **Add your API keys** in `js/config.js`:
   ```js
   const MAPBOX_TOKEN = "your_mapbox_token_here";
   const _IPT = atob("your_base64_encoded_ipinfo_token_here");
   ```

3. **Populate `data/route.json`** with your route data. Each stop follows this structure:
   ```json
   [
    {
      "DR": 77,
      "Unix Arrival Arrival": 1775293484,
      "Unix Arrival": 1775293500,
      "Unix Arrival Departure": 1775293501,
      "Pretty Arrival EDT 2026": "4/4/2026 5:05:00",
      "City": "London",
      "Region": "Kiribati",
      "CC": "ki",
      "Locale": "en-KI",
      "Eggs Delivered": 8396,
      "Carrots eaten": 78,
      "Latitude": 1.983726,
      "Longitude": -157.474748,
      "Population Num": 1899,
      "Population Year": 2015,
      "Elevation Meter": 3,
      "Arrival Stoppage Time": 32,
      "Timezone": "Pacific/Kiritimati",
      "Wikipedia attr": "https://en.wikipedia.org/wiki/London,_Kiribati",
      "": null
    }
   ]
   ```

4. **Serve the project locally.** Because the tracker fetches `route.json` via `fetch()`, you need a local HTTP server rather than opening `index.html` directly in a browser:
   ```bash
   npx serve .
   # or
   python3 -m http.server 8080
   ```

5. **Open** `http://localhost:8080` in your browser.

---

## ⚙️ Configuration

Key constants in `js/config.js` can be adjusted to suit your route:

| Constant | Default | Description |
|---|---|---|
| `BASKET_START_DR` | `77` | DR value at which basket markers begin appearing |
| `TAKEOFF_DR` | `76` | DR value for the takeoff clearance stop |
| `FINAL_DR` | `1048` | DR value of the last stop (Easter Island) |
| `LOCKED_ZOOM` | `5.2` | Map zoom during active delivery |
| `LOCKED_ZOOM_PRE` | `3.5` | Map zoom before takeoff and at the final stop |
| `MUSIC_VOLUME` | `0.2` | Background music volume (0.0 – 1.0) |

### Understanding DR (Delivery Readiness)

The DR field controls the tracker's phase logic:

- **DR < 76** — Pre-journey preparation stops; no delivery stats shown yet
- **DR = 76** — Takeoff clearance stop; "lifting off" status shown briefly
- **DR ≥ 77** — Active delivery; baskets, stats, and city panel are shown
- **DR = 1048** — Final stop; journey complete

---

## 🛠️ Tools

### `tools/compiler.py` — Route Date Compiler

`compiler.py` reads `data/route.json`, detects the earliest scheduled date in the route, and shifts all Unix timestamps forward so the journey starts on a new target date of your choice — useful when adapting the route for a future year's Easter. Stops with `DR == 0` are ignored and left unchanged.

Before writing the updated file, the script renames the existing `route.json` to `DELETETHIS.json` as a backup.

> **Requires Python.** If you don't have it installed, download it from [python.org/downloads](https://www.python.org/downloads/).

#### Step 1 — Set your target date

Open `tools/compiler.py` and update the `--test-base-date` default value to the upcoming **Easter Eve** date (the day before Easter Sunday). The script will automatically shift any stops that fall on the following day to Easter Sunday:

```python
ap.add_argument(
    "--test-base-date",
    default="2026-3-15",  # Change to the upcoming Easter Eve date (YYYY-MM-DD)
    help="Test base date in YYYY-MM-DD (default: 2026-3-15)"
)
```

> ⚠️ This change must be made directly in `tools/compiler.py`. Editing any other file will have no effect.

Save the file after making your change (`Ctrl + S`).

#### Step 2 — Run the script

From the root of the project, run one of the following commands depending on your system:

```bash
python tools/compiler.py
```
```bash
python tools\compiler.py
```
```bash
py tools\compiler.py
```

#### Step 3 — Confirm success

If the script ran successfully, you will see output similar to this:

```
Renamed existing route.json -> DELETETHIS.json
Done.
Input:  data\route.json
Output: data\route.json
Pretty field: Pretty Arrival EDT 2026
Original base date detected (ignoring DR 0): 2026-04-04
Test base date: 2026-03-15 (EDT via America/New_York)
Converted stops: 87
Skipped DR 0 stops: 2
```

This confirms that `data/route.json` has been written with updated timestamps, and the previous version has been preserved as `DELETETHIS.json`. If the script outputs an error instead, check that Python is correctly installed and that you are running the command from the project root directory.

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0**. See the [LICENSE](LICENSE) file for full terms.

You are free to use, modify, and distribute this code, provided that any distributed modifications are also released under the GPL-3.0.

---

## 💛 Support the Project

The Easter Bunny Tracker is built and maintained by **Roblify**. If you enjoy it and want to help keep it running, consider making a donation:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/roblify)

---

## 📬 Contact

Questions, feedback, or bug reports: [support@easterbunnytracker.org](mailto:support@easterbunnytracker.org)
