# EmergencyFlow AI

An open, reproducible **simulation testbed** for emergency-vehicle signal priority. An ambulance is driven through a live city (SUMO traffic simulation, 3D view in the browser). Traffic signals are preempted through a tested safety layer, and routes are suggested.

- v1 decision logic is **rule-based** (preemption rules + shortest-path routing). There is no machine learning in v1.
- This is a simulation. It does **not** control real traffic signals.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions and roadmap.

## Status

| Sprint | Deliverable | State |
|---|---|---|
| 1 | SUMO world: 2x2 signalized grid (left-hand traffic), seeded background traffic, clean TraCI lifecycle | done |
| 2 | Ambulance + manual WASD driving, FastAPI WebSocket, React Three Fiber top-down view | done |
| 3 | Safety controller + independent safety monitor + BASIC signal preemption (OFF/BASIC) | done |
| 4 | Demo hardening: protocol contract test, driver lock, reconnect, 4x4 grid + performance benchmark | done |
| 5 | 3D city with the team's delivered models: asset manifest, instancing + LOD, chase/orbit/map cameras, HDRI sky, `/assets` page, `check:assets` | done |
| 6 | Shortest-path routing with live costs, route overlay, ETA | next |

## Prerequisites (Windows)

- **SUMO 1.27.1** (Windows installer), with `SUMO_HOME` set (e.g. `C:\Program Files (x86)\Eclipse\Sumo`) and `%SUMO_HOME%\bin` on `PATH`.
  Terminals and VS Code windows opened **before** SUMO was installed don't see these variables. Restart them, or use the `.env` file below.
- **Python 3.13** (3.11+ works), **Node.js LTS**, **Git** with **Git LFS**.

## Setup (PowerShell, from the repo root)

```powershell
git lfs install                                   # once per machine
py -3.13 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Copy-Item .env.example .env                       # local settings, git-ignored; edit SUMO_HOME if needed
cd frontend; npm install; cd ..
```

The commands call `.venv\Scripts\python.exe` directly, so you don't need to activate the venv. That avoids PowerShell's script execution policy. In VS Code, pick `backend\.venv\Scripts\python.exe` as the interpreter so imports resolve.

## Drive the ambulance

Use two terminals.

```powershell
# terminal 1: backend (starts SUMO headless, 10 Hz)
cd backend
.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000

# terminal 2: frontend
cd frontend
npm run dev
```

Open **http://localhost:5173**, click **Dispatch ambulance** and drive from the depot (west) to the hospital (east, top road).

| Key | Action |
|---|---|
| W / S | Throttle / brake (hold) |
| A / D | Turn left / right at the next junction (tap). A turn pressed inside a junction is queued for the next one |
| Q / E | Change lane left / right. Left-hand traffic: the curb lane is on the left |
| C | Camera: **Chase** (behind the ambulance; a city overview while none is out), **Orbit** (free: drag to rotate, right-drag to pan, wheel to zoom), **Map** (2D) |
| F | Map view: follow the ambulance on/off (off shows the whole map) |

### The 3D city

- **Source of truth:** the roads, signals and traffic all come from SUMO.
- **City:** the team's delivered models furnish it.
  - **Placement:** buildings line every block. The shops (bazaar) with an auto-rickshaw stand and the petrol station are on the depot road, and the hospital stands at the destination.
  - **Signal heads:** one per approach, with the lamps lit from the live signal state.
  - **Street furniture:** trees, streetlights, zebra crossings, medians and the rest.
- **Map view:** also shows one disc per signal link (a junction has no single colour) and the junction names.
- **Model files:** they are used exactly as delivered (`3d_models/`, served at `/models/`). All corrections live in the asset manifest. If a file can't load, a grey box (its placeholder) is drawn and the app keeps running.

How driving works:
- The ambulance obeys red lights and right of way.
- Its top speed is capped at 80 km/h.
- If drive input stops for 0.5 s (window loses focus, tab hidden), it coasts to a stop.
- When a request can't be done, the HUD says why (e.g. "too late to turn right at A0").

### Signal modes

The **OFF / BASIC** buttons switch modes; COORD arrives in Sprint 7.

- **OFF:** normal fixed-time signals.
- **BASIC:** when the ambulance is 15 s or less from its next signal, that junction is handed to the safety controller:
  1. **Clearing** (amber ring): conflicting greens turn yellow for 4 s, then all directions are red for 2 s.
  2. **Preempted** (blue ring): green for the ambulance's approach only.
  3. **Recovering** (violet ring): once the ambulance has passed, yellow 4 s, then all-red 2 s, then the normal program resumes at the other direction's green.
  - A preemption lasts at most 40 s.
  - Afterwards the cross traffic keeps its green for at least 10 s before the next preemption.

The HUD's **Safety** card shows the independent monitor's violation count, SUMO's collision count and the controller's latest decisions with reasons. Both counts must stay 0.

This is a simulation: nothing here controls real traffic signals.

### Several screens

The first screen that clicks **Dispatch** drives. Every other screen is an observer: it sees everything live, but its controls are disabled.
- **Handing over:** the driver can click **Release control**, and **Reset** also frees control.
- **Reconnects:** if the driver's tab loses its connection, it gets control back when it reconnects within 10 s. Any page reconnects on its own after a backend restart, and reloads the map if the scenario changed.

### Demo settings

- **Warm-up:** the backend fast-forwards 120 s on start and after Reset, so traffic is already flowing (`EF_WARMUP_S` in `.env`).
- **Heavy traffic:** `EF_SCALE=1.5`.
- **Bigger city:** `EF_SCENARIO=grid4x4` for the 16-junction grid.

**Plug the laptop in and run Edge on the NVIDIA GPU for demos:** Windows Settings → Display → Graphics → Microsoft Edge → High performance. Otherwise Edge uses the Intel UHD, even when plugged in. Open the page about 15 s before driving, so the models and the sky are in.

3D scene, Edge at 1600x900, plugged in. 4x4 grid at 1.5x (~540 vehicles), driving in BASIC:

| View | RTX 4060 | Intel UHD |
|---|---|---|
| Chase | 144 FPS (display cap) | 60 median, 53 min |
| Orbit | 144 | 63 / 61 |
| City overview | 144 | 63 / 47 |
| Map (2D) | 144 | 136 / 133 |

- **2x2 at 1.5x:** chase is 144 FPS on the RTX 4060 and 62 / 55 on the Intel UHD.
- **Draw calls:** at most ~80 (one mesh per car in Sprint 4 was ~957).
- **Response time:** keypress to the first responding simulation tick takes 45 ms median on the RTX 4060 and 70 ms on the Intel UHD.
- **Battery:** not measured this sprint. In Sprint 4, SUMO ran about 4x slower on battery.
- **Backend tick:** 1.9 ms (2x2) and 7.8 ms (4x4 at 1.5x) plugged in, out of a 100 ms budget.

## Headless run

```powershell
cd backend
.venv\Scripts\python.exe -m simulation.sumo --steps 600 --print-every 50
```

This starts SUMO headless, steps it at 0.1 s, prints the vehicle count and every signal's state, then shuts SUMO down. Example output:

```
SUMO 1.27.1 | scenario grid2x2 | seed 42 | scale 1.0 | step 0.1 s | sumo pid 36108
t=    5.0s  vehicles=   6  A0=GGGgrrrrGGGgrrrr(p0)  A1=GGGgrrrrGGGgrrrr(p0)  ...
t=   35.0s  vehicles=  30  A0=yyyyrrrryyyyrrrr(p1)  A1=yyyyrrrryyyyrrrr(p1)  ...
t=   40.0s  vehicles=  30  A0=rrrrGGGgrrrrGGGg(p3)  A1=rrrrGGGgrrrrGGGg(p3)  ...
SUMO closed (exit code 0).
```

Each signal state has one character per controlled lane movement: `G` = green, `g` = green but must yield, `y` = yellow, `r` = red. `(pN)` is the phase index.

Options:
- `--seed 7`: different random traffic.
- `--scale 1.5`: heavy-traffic demo demand.
- `--steps N`: number of 0.1 s steps.
- `--gui`: `sumo-gui`, for debugging only. It is not the product UI.

## Developer tools (from `backend\`)

```powershell
.venv\Scripts\python.exe -m scripts.benchmark       # engine tick time + message size, 2x2/4x4 at 1.0x/1.5x (~2 min)
.venv\Scripts\python.exe -m scripts.gen_contract    # run after ANY change to api/protocol.py, then fix state.ts until `npm run typecheck` passes
```

`gen_contract` regenerates two things:
- `frontend/src/simulation/contract.fixtures.ts`, from the backend's message models. If the frontend types drift from the backend, TypeScript and `pytest` both fail.
- the network fixtures the city layout tests use.

### 3D assets (from `frontend\`)

```powershell
npm run check:assets            # every model: triangles, size before/after fit, parts, LFS pointers,
                                # ATTRIBUTIONS rows, manifest owner/priority vs the workbook
npm run check:assets -- --strict   # warnings fail too (CI)
```

**http://localhost:5173/assets** (dev server only) shows every model on its own turntable:
- axes (+Z = forward), a 1 m grid, a 5 m ruler and the bounding box
- size, triangles and draw calls
- load status
- a "copy manifest entry" button

Use it to calibrate a model's rotation and size in `frontend/src/assets/manifest.ts`. The files themselves are never edited.

## OFF vs BASIC smoke comparison (one seed)

```powershell
cd backend
.venv\Scripts\python.exe -m scripts.smoke_compare        # --seed N, --scale 1.5
```

Same scripted trip in both modes: depot → straight at A0 → left at B0 → right at B1 → hospital. Seed 42, demand ×1.0:

```
mode   mission s stopped s stops preempt violations collisions bg halted veh*s
OFF         92.0      33.5     3       0          0          0          3946.3
BASIC       47.5       0.0     0       3          0          0          4700.4
```

This is **one seed**: a smoke test, not evidence. The seeded multi-run evaluation is Sprint 9. Even so, it shows the trade-off honestly: the ambulance gets there in about half the time, while the other traffic spends about 19% more time stopped over the same 300 s window.

## Tests and lint

```powershell
cd backend
.venv\Scripts\python.exe -m pytest -q                  # ~70 s plugged in (~2.5 min on battery); includes a 1-hour run
.venv\Scripts\python.exe -m pytest -q -m "not slow"    # ~55 s plugged in
.venv\Scripts\ruff.exe check --config pyproject.toml . ..\scenarios
.venv\Scripts\black.exe --config pyproject.toml --check . ..\scenarios

cd ..\frontend
npm run test        # Vitest: coordinates, keys, store, protocol, geometry, city layout, asset pipeline, workbook
npm run build       # strict TypeScript check + production build (copies 3d_models/ into dist/models/)
```

## Scenario: `scenarios/grid2x2`

```
            nA            nB
            |             |
  w1 ------ A1 ========== B1 ------ e1
            ‖    250 m    ‖
  w0 ------ A0 ========== B0 ------ e0
            |             |
            sA            sB
  ==/‖ roads between junctions; --/| 200 m roads to the map edge; north is up
```

- **Junctions:** 4 signalized (`A0` `B0` `A1` `B1`). Edges are named `<from>_<to>`, e.g. `w0_A0`.
- **Roads:** left-hand traffic (India), 2 lanes each way, 50 km/h. Lane 0 is the curb (left) lane and carries left + straight; lane 1 carries straight + right.
- **Signals:** fixed-time. Each direction gets 31 s green, 4 s yellow and 2 s all-red, so the cycle is 74 s. Right turns cross oncoming traffic and yield (`g`).
- **U-turns:** none at signals; allowed at the map edge.
- **Background traffic:** cars only (70% sedan, 30% hatchback). Vehicles arrive randomly (Poisson) between every pair of map-edge roads, 400 veh/h per entry at `--scale 1.0`.
  - Verified over 8 seeds: 0 collisions and 0 teleports per simulated hour at both 1.0x and 1.5x.
  - Trucks and buses are defined but switched off: in this junction geometry they caused SUMO junction collisions.

Regenerate (from `backend\`):

```powershell
.venv\Scripts\python.exe ..\scenarios\build_grid.py                  # -> scenarios\grid2x2
.venv\Scripts\python.exe ..\scenarios\build_grid.py --nx 4 --ny 4    # -> scenarios\grid4x4 (evaluation)
```

## Troubleshooting

- **`Could not find 'sumo'`**: set `SUMO_HOME` in `.env`, or open a new terminal after installing SUMO.
- **`Warning: Environment variable SUMO_HOME is not set properly, disabling XML validation`**: harmless, but it means that terminal can't see `SUMO_HOME`. Restart the terminal, or run through `simulation.sumo`, which loads `.env`.
- **Leftover `sumo.exe`**: shouldn't happen. The backend owns the SUMO process and kills it on exit, and SUMO quits by itself if its client dies. Check with `Get-Process sumo`.
- **Page says "Backend not reachable"**: start the backend first (terminal 1). `http://127.0.0.1:8000/api/health` should report `running`.
- **Open `http://localhost:5173`, not `127.0.0.1:5173`**: Vite listens on `localhost`, which Windows resolves to IPv6 `::1`.
- **`[vite] ws proxy error: ECONNRESET` in the frontend terminal:** the backend went away mid-connection, e.g. `uvicorn --reload` restarting after a backend file changed. The page reconnects on its own. Page loads and reloads themselves no longer log it: the socket opens only once under React StrictMode, and the skybox worker's dependency is pre-bundled, so Vite no longer force-reloads the page.
- **Grey boxes instead of buildings and cars:** the model files are missing or are Git LFS pointers. Run `git lfs pull`, then `npm run check:assets` (it names each problem file).
- **Low FPS:** check which GPU Edge uses (Windows Graphics settings above). The HUD shows FPS, draw calls and triangles.
- **How long does live traffic last?** The live server generates background traffic for 24 h (`routes.live.rou.xml`). Experiments and tests use exactly 1 h (`routes.rou.xml`) so results stay comparable.
