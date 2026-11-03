# Wi-Fi Map

Plan Wi-Fi for your home or property. Draw or import a layout, place your router and access points, and see coverage as a **traffic light**:

- 🟢 **Good** (≥ −67 dBm) – streaming, video calls
- 🟠 **Fair** (−67 to −75 dBm) – browsing, OK
- 🔴 **Poor** (< −75 dBm) – slow or dropping

The app then **suggests the best router spot** and **where to add access points / mesh nodes** to fill the gaps.

It runs entirely in the browser with **no internet needed** (no server, no build step, no accounts). Your plan is saved on the device.

## Getting the app on your phone

The easiest way is GitHub Pages: in the repo go to **Settings → Pages**, choose "Deploy from a branch", pick the branch and `/ (root)`. Open the link on your phone once, then use **Share → Add to Home Screen** (iPhone) or **Install app** (Android). After that it works offline like a normal app.

On a computer you can also just open `index.html`, or run `python3 -m http.server` in this folder and visit `http://localhost:8000`.

## Features

| | |
|---|---|
| **Layouts** | Upload a floor plan / photo / screenshot, draw walls and rooms, multiple floors (floor below shown faintly for alignment) |
| **Google Maps** | Screenshot a satellite view and set the scale with the map's scale bar (offline), or download a satellite image directly with your own Maps Static API key (scale set automatically) |
| **LiDAR / 3D scans** | Import OBJ scans from LiDAR apps (Polycam, 3D Scanner App, Scaniverse…), Apple RoomPlan JSON, or DXF files from CAD / floor-plan apps. Scans are sliced at wall height, cleaned up and turned into walls, with the slice kept as a background picture |
| **Walls** | 12 materials (drywall, brick, concrete, glass, Low-E glass, metal, hedges…), each with its own loss at 2.4 / 5 / 6 GHz |
| **Devices** | Router, mesh node, access point, extender, with adjustable transmit power |
| **Coverage** | Traffic-light map per floor and band, tap anywhere for exact dBm, room-by-room report |
| **Suggestions** | Best router positions, greedy + refined access point placement (wired or wireless mesh with backhaul check), channel plan and tips |
| **Calibration** | Add real signal readings with the Measure tool; the app corrects its prediction |
| **Save / share** | Auto-save, undo/redo, export/import project files, export picture |

A web app can't read the phone's LiDAR sensor directly, which is why scans are imported from a scanning app.

## How the prediction works

A standard indoor multi-wall model (COST-231 / Motley-Keenan style):

```
RSSI = EIRP − FSPL(1 m) − 10·n·log10(distance) − Σ wall losses − floors × floor loss + calibration
```

`n` depends on how furnished the home is (2.0–2.7). It's an estimate: real results depend on your devices, furniture and neighbours. A few real measurements (Measure tool → Apply calibration) make it noticeably more accurate.

## Files

- `index.html`, `css/styles.css` – page and styles
- `js/engine.js` – data model, materials, radio model, coverage grid
- `js/optimizer.js` – router / access point placement search
- `js/importers.js` – image, DXF, OBJ (LiDAR), RoomPlan and Google Maps importers
- `js/app.js` – editor, tools, panels
- `sw.js`, `manifest.webmanifest` – offline install support
