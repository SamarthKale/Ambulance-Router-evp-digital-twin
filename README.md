# EmergencyFlow AI

An open, reproducible **simulation testbed** for emergency-vehicle signal priority. An ambulance is driven through a live city (SUMO traffic simulation, 3D view in the browser). Traffic signals are preempted through a tested safety layer, and routes are suggested.

- v1 decision logic is **rule-based** (preemption rules + shortest-path routing). There is no machine learning in v1.
- This is a simulation. It does **not** control real traffic signals.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions and roadmap.

## Quick start (Windows, PowerShell, from the repo root)

Needs SUMO 1.27.1 (with `SUMO_HOME` set), Python 3.13, Node.js LTS and Git LFS (see Prerequisites).

```powershell
git lfs install; git lfs pull       # the team's 3D models
.\start.ps1 -Setup                  # first time: Python venv + packages, npm packages, .env
.\start.ps1                         # the demo: 4x4 city, heavy traffic; opens http://localhost:5173
```

`start.ps1` starts the backend (SUMO + API) and the frontend, waits until both answer, opens the browser and stops everything on **Ctrl+C**. Logs go to `logs\`.
- **Options:** `-Scenario grid2x2`, `-Scale 1.0`, `-Seed 7`, `-Warmup 60`, `-NoGhost`, `-NoBrowser`, `-BackendPort` / `-FrontendPort`, `-Lan`.

### Dashboard on another PC

`http://localhost:5173/dashboard` is a read-only dashboard: no 3D, so it opens on any PC or projector. It shows the live simulation, the ambulance, the OFF ghost and time saved, the safety counters and the safety controller's log, then the batch experiment results and charts (refreshed every 30 s). It only watches: it never sends a command.

To open it from another PC on the same network:
1. Start with `.\start.ps1 -Lan`. It prints this PC's addresses, e.g. `http://192.168.29.243:5173/dashboard`.
2. Open that address on the other PC. The live 3D view works too (`http://192.168.29.243:5173/`), as an observer.
3. **If it doesn't connect:** Windows blocks incoming connections on networks marked *Public*. Set the network to *Private* (Settings → Network → your Wi-Fi → Private), or allow the port once, in an admin PowerShell: `New-NetFirewallRule -DisplayName "EmergencyFlow 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow`. The launcher warns when the network is Public.

Only the frontend port is opened; the backend stays on 127.0.0.1 behind Vite's proxy.
- **Production build:** `-Prod` builds the frontend and serves it with `vite preview` on port 4173.
- **Script blocked by policy?** Run `powershell -ExecutionPolicy Bypass -File .\start.ps1`.

## Status

| Sprint | Deliverable | State |
|---|---|---|
| 1 | SUMO world: 2x2 signalized grid (left-hand traffic), seeded background traffic, clean TraCI lifecycle | done |
| 2 | Ambulance + manual WASD driving, FastAPI WebSocket, React Three Fiber top-down view | done |
| 3 | Safety controller + independent safety monitor + BASIC signal preemption (OFF/BASIC) | done |
| 4 | Demo hardening: protocol contract test, driver lock, reconnect, 4x4 grid + performance benchmark | done |
| 5 | 3D city with the team's delivered models: asset manifest, instancing + LOD, chase/orbit/map cameras, HDRI sky, `/assets` page, `check:assets` | done |
| 6 | Live-cost shortest-path routing: route overlay, ETA and distance, advisory turn hints, seeded ETA check | done |
| 7 | COORD: queue-aware preemption lead time + downstream junction preparation | done |
| 8 | Accident injection + automatic reroute + "route compromised" | done |
| 9 | Experiment runner (paired seeds, arms, demand sweep), charts, OFF ghost comparison run | done |
| 10 | Demo hardening, one-command local launcher, LAN dashboard, final verification (local Windows; no Docker, no CI/CD) | done |

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

`.\start.ps1 -Setup` does the same. The commands call `.venv\Scripts\python.exe` directly, so you don't need to activate the venv. That avoids PowerShell's script execution policy. In VS Code, pick `backend\.venv\Scripts\python.exe` as the interpreter so imports resolve.

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

### Suggested route

Once the ambulance is on the road, the fastest route to the hospital is drawn on the road and shown in the HUD:
- **ETA and distance** to the hospital.
- **The next turn**, labelled at its junction.

The route is planned with live costs:
- **Traffic speed** on each road.
- **Queues** at the stop lines.
- **Red lights:** in OFF mode, the wait at each light is predicted from the signal program. With preemption (BASIC) the wait drops out.

It is re-planned every second and every time the ambulance reaches a new road. It is advice only: you steer.
- **Off the suggestion:** if your next turn differs, the route turns orange and the HUD says which key to press (A or D).
- **Accuracy:** over 10 seeded autopilot runs on the 4x4 grid, the ETA at dispatch was within 10 % on average with BASIC. With normal signals (OFF) it was within 25 %, because every red light met is a lottery. Run `scripts.eta_check` (below) to reproduce this.

### The OFF ghost

After **Reset**, the first **Dispatch** also starts an **OFF ghost**: the same mission, in the same traffic, with normal signals and the autopilot driving. It is drawn as a translucent ambulance labelled "OFF ghost".
- **How it works:** a second simulation has been replaying the live one, in lockstep, since the reset (same seed, same traffic). At the dispatch it sends out its own ambulance at the same moment, and it gets the same accidents at the same moments.
- **Time saved:** when your ambulance arrives, the ghost finishes its run in the background, and the HUD shows **saved N s**. The number is measured on the same traffic, never estimated.
- **Later dispatches:** they get no ghost (the HUD says why). Your earlier missions changed the traffic in ways the ghost can't replay; press **Reset** for a new one.
- **Turning it off:** set `EF_GHOST=0` in `.env`. The ghost costs a second SUMO process.

### Accidents

**Create accident** puts a wrecked car in the curb lane of the next road on the suggested route (beyond the next junction). It is closed off with a barrier, cones and a road-block marker.
- **In the simulation:** the wreck is a stopped vehicle in SUMO, so traffic behind it merges into the open lane and queues.
- **On the route:** the route is re-planned at once. If the accident was on it, the HUD shows **Route compromised** with the ETA change, and the new suggestion goes round it whenever that is faster. As always, you steer.
- **Clear accidents** removes every wreck; so does **Reset**.

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

The **OFF / BASIC / COORD** buttons switch modes. All three are rule-based; nothing here is machine learning.

- **OFF:** normal fixed-time signals.
- **BASIC:** when the ambulance is 15 s or less from its next signal, that junction is handed to the safety controller:
  1. **Clearing** (amber ring): conflicting greens turn yellow for 4 s, then all directions are red for 2 s.
  2. **Preempted** (blue ring): green for the ambulance's approach only.
  3. **Recovering** (violet ring): once the ambulance has passed, yellow 4 s, then all-red 2 s, then the normal program resumes at the other direction's green.
  - A preemption lasts at most 40 s.
  - Afterwards the cross traffic keeps its green for at least 10 s before the next preemption.
- **COORD (coordinated):** the same safety controller, with two changes to when it is asked:
  - **Queue-aware timing:** a junction starts clearing early enough for the cars queued in front of the ambulance to drive off before it arrives. That is 6 s of clearance + 2 s start-up + 2 s per queued car per lane + 3 s margin. An empty approach is held for 11 s instead of BASIC's 15 s, so cross traffic loses less green.
  - **Next junctions prepared:** the same rule runs for the next two junctions on the suggested route while you follow it (the log says "prepared ahead"). The **Safety** card counts the queues cleared ahead of the ambulance.

The HUD's **Safety** card shows the independent monitor's violation count, SUMO's collision count and the controller's latest decisions with reasons. Both counts must stay 0.

This is a simulation: nothing here controls real traffic signals.

### Several screens

The first screen that clicks **Dispatch** drives. Every other screen is an observer: it sees everything live, but its controls are disabled.
- **Handing over:** the driver can click **Release control**, and **Reset** also frees control.
- **Reconnects:** if the driver's tab loses its connection, it gets control back when it reconnects within 10 s. Any page reconnects on its own after a backend restart, and reloads the map if the scenario changed.

### Demo script

1. **Setup:** laptop on AC power, Edge on the NVIDIA GPU (below), `.\start.ps1`. Open the page about 15 s early, so the models and the sky are in. A second screen may open the same page as an observer.
2. **The city:** heavy traffic, signals **OFF**, ambulance parked. **C** cycles Chase / Orbit / Map. If anyone has dispatched since the start, press **Reset** first: the OFF ghost replays the first mission after a reset only.
3. **Dispatch ambulance**, drive with **W**, follow the suggested turns (**A**/**D**). The translucent **OFF ghost** sets off with you.
4. Switch to **BASIC**: the next signal turns green ahead of you, after 4 s of yellow and 2 s of all-red. The Safety log shows each step.
5. Switch to **COORD**: junctions further ahead are "prepared ahead", and queues clear before you arrive.
6. **Create accident**: the HUD shows **Route compromised**, the route goes round it with the new ETA, and the ghost meets the same accident.
7. Arrive: the HUD shows the OFF ghost's time and what you **saved**, measured on the same traffic. Press **R** for the batch experiment results: travel time per arm with confidence intervals, and the cost to background traffic.

Switching windows or tabs releases the keys and the ambulance coasts to a stop, by design.

### Demo settings

- **Warm-up:** the backend fast-forwards 120 s on start and after Reset, so traffic is already flowing (`EF_WARMUP_S` in `.env`).
- **Heavy traffic:** `EF_SCALE=1.5` (`start.ps1`'s default).
- **Bigger city:** `EF_SCENARIO=grid4x4` for the 16-junction grid (`start.ps1`'s default).
- **OFF ghost:** `EF_GHOST=1` (default); it runs a second SUMO process.

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
.venv\Scripts\python.exe -m scripts.eta_check       # routing ETA vs measured: 10 seeds, autopilot, 4x4 (~2 min, parallel)
.venv\Scripts\python.exe -m scripts.gen_contract    # run after ANY change to api/protocol.py, then fix state.ts until `npm run typecheck` passes
```

`gen_contract` regenerates two things:
- `frontend/src/simulation/contract.fixtures.ts`, from the backend's message models. If the frontend types drift from the backend, TypeScript and `pytest` both fail.
- the network fixtures the city layout tests use.

### 3D assets (from `frontend\`)

```powershell
npm run check:assets            # every model: triangles, size before/after fit, parts, LFS pointers,
                                # ATTRIBUTIONS rows, manifest owner/priority vs the workbook
npm run check:assets -- --strict   # warnings fail too
```

**http://localhost:5173/assets** (dev server only) shows every model on its own turntable:
- axes (+Z = forward), a 1 m grid, a 5 m ruler and the bounding box
- size, triangles and draw calls
- load status
- a "copy manifest entry" button

Use it to calibrate a model's rotation and size in `frontend/src/assets/manifest.ts`. The files themselves are never edited.

## OFF vs BASIC vs COORD smoke comparison (one seed)

```powershell
cd backend
.venv\Scripts\python.exe -m scripts.smoke_compare        # --seed N, --scale 1.5
```

Same scripted trip in every mode: depot → straight at A0 → left at B0 → right at B1 → hospital. Seed 42, demand ×1.0:

```
mode   mission s stopped s stops preempt q cleared violations collisions bg halted veh*s
OFF         92.0      33.5     3       0         0          0          0          3946.3
BASIC       47.5       0.0     0       3         0          0          0          4700.4
COORD       47.5       0.0     0       3         0          0          0          4889.3
```

This is **one seed** on the network's own 74 s signals: a smoke test, not evidence. The seeded evaluation follows.
- **The trade-off:** the ambulance gets there in about half the time, while the other traffic spends about 19–24 % more time stopped over the same 300 s window.
- **COORD vs BASIC here:** COORD has no queues to clear on this light demand, so it matches BASIC.

## Evaluation: batch experiments (results)

All numbers are **autopilot batch runs**, never the manual live demo. 4x4 grid, 8 arms (signals x routing), the same seeded missions in every arm (random start, destination and dispatch time after a 300 s warm-up). Every arm of a seed starts from identical traffic, verified by a fingerprint. Each arm shares one fixed-time signal program tuned for the demand by SUMO's `tlsCycleAdaptation.py` (cycles of 28-36 s), so the baseline is not a strawman. The baseline is **OFF strict, static routing**: no priority, the ambulance waits at reds, and follows the route a map would give.

560 runs in total: 40 seeds at demand x1.5, and 10 seeds each at x0.75, x1.0 and x2.0. One run was excluded (not arrived within the 600 s window), and 0 teleported.

**Ambulance travel time, mean (s):**

| Arm | x0.75 | x1.0 | x1.5 | x2.0 |
|---|---|---|---|---|
| OFF strict, static (baseline) | 133.8 | 153.6 | 197.1 | 212.4 |
| OFF realistic (crosses reds slowly), static | 116.3 | 130.8 | 170.6 | 143.4 |
| BASIC, static | 89.7 | 93.2 | 93.8 | 99.2 |
| BASIC, dynamic | 84.3 | 91.4 | 95.9 | 93.6 |
| COORD, static | 89.4 | 93.7 | 94.6 | 95.8 |
| COORD, dynamic | 83.6 | 91.3 | 97.3 | 98.1 |

**At demand x1.5 (40 paired seeds), against the baseline** (mean difference, 95 % confidence interval, Wilcoxon p):

| Arm | Travel time | Waiting time | Red-light stops | Background time loss (of ~190,600 veh-s) |
|---|---|---|---|---|
| BASIC, static | −103.3 s [−121.9, −85.9], p < 0.001 | −56.4 s | −3.6 (to 0) | +60 veh-s [−1064, +1024], p = 0.33 |
| COORD, static | −102.5 s [−121.2, −85.3], p < 0.001 | −56.4 s | −3.6 (to 0) | −184 veh-s [−1240, +805], p = 0.91 |
| COORD, dynamic | −99.8 s [−118.1, −82.7], p < 0.001 | −56.0 s | −3.6 | +681 veh-s [−506, +1821], p = 0.17 |
| OFF realistic, static | −26.5 s [−37.5, −16.7], p < 0.001 | −24.1 s | −1.1 | −89 veh-s, p = 0.38 |

What the experiments show:
- **Signal priority roughly halves the ambulance's travel time** at every demand: −44 s at x0.75, −60 s at x1.0, −103 s at x1.5 and −113 to −119 s at x2.0 (all p ≤ 0.002). The ambulance stops at no red light, and the time for the queue in front of it to clear drops from 5.4 s to 1.5 s per junction.
- **Background traffic pays no measurable price:** with BASIC or COORD the change in its total time loss stays within ±0.7 % and is never significant, at any demand. With short tuned cycles, the 4 s yellow, 2 s all-red and recovery cost cross traffic little.
- **COORD is not better than BASIC here.** The paired difference is under 5 s at every demand, and never significant (p ≥ 0.28). The cycles tuned for the demand are 28-36 s, so the queues COORD clears early are short. On the network's own 74 s program, a 5-seed smoke test had COORD 2-8 s ahead.
- **Live re-routing doesn't help without incidents:** with BASIC or COORD, dynamic and static routing differ by under 6 s, and the difference is never significant at x1.0 and above. Its value is the accident case: "Route compromised" and the way round.
- **Crossing reds without priority is faster than waiting, but unsafe.** `off_realistic` saves 17-34 s. In 12 of its 140 runs the ambulance was in a junction collision: 22 events. SUMO's red-crossing model doesn't yield to cross traffic. Signal priority saves 2.5-4x as much time, with no ambulance collision at all.

**Safety** (`experiments/summary/collisions.csv`, from `scripts.classify_collisions`: every run with a collision was rerun with SUMO's log kept, and all 32 reproduced exactly):
- The independent monitor counted **0 signal violations in all 560 runs**.
- **0 collisions involved the ambulance in BASIC, COORD or OFF strict** (420 runs).
- The other collisions are between background cars at permissive turns. They happen almost only at x2.0, where the network is oversaturated, and in every arm, including the baseline (8 events in the baseline's 10 runs). At the demo's x1.5 there was one, in both OFF strict arms of the same seed.

Reproduce (from `backend\`; about 2.5 h on 14 cores):

```powershell
.venv\Scripts\python.exe -m scripts.run_experiments --scales 1.5 --seeds 1-40
.venv\Scripts\python.exe -m scripts.run_experiments --scales 0.75,1.0,2.0 --seeds 1-10
.venv\Scripts\python.exe -m scripts.classify_collisions
```

The results are in `experiments/`: per-arm CSVs and a manifest per run, plus `summary/` (`paired.csv`, `summary.json`, `collisions.csv`, charts). They are also shown in the app (**R**) and on `/dashboard`. SUMO is CPU-only, so the runs use the processor; the GPU only draws the 3D view.

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
