# CLAUDE.md — EmergencyFlow AI

An open, reproducible simulation testbed for emergency-vehicle signal priority: an ambulance is driven through a live 3D city while signals are preempted through a verified safety layer and routes are suggested. v1 decision logic is rule-based.

This file is the source of truth for how to work in this repo. Read it fully before making changes.

---

## 1. Project status and scope

- **Target:** startup-grade prototype for **hackathon judges**: a reliable, impressive live demo plus measurable evaluation (clean, tested, demo-ready).
- **Dev OS:** Windows, native SUMO install (`C:\Program Files (x86)\Eclipse\Sumo`, `SUMO_HOME` set system-wide). Do not reinstall SUMO; `traci`/`sumolib` are pip-installed and pinned to the installed version.
- **AI scope for v1: rules + shortest-path routing ONLY.**
  - Do NOT add PyTorch, scikit-learn, Stable-Baselines3, or any ML/RL code in v1.
  - Traffic prediction (LSTM/GRU/XGBoost) and RL are post-v1 and must not be scaffolded early.
- **Out of scope for v1:** CARLA, Eclipse MOSAIC, SUMO+CARLA co-simulation, multi-city support, real hardware/IoT integration, SQLite/PostgreSQL, road-closure incidents (accidents only), Docker (after CI, if time).

## 2. Core architecture (non-negotiable)

```
SUMO  <--TraCI-->  Python engine (FastAPI)  <--WebSocket-->  React + R3F + Three.js
 truth              decisions + safety                         presentation only
```

1. **SUMO is the single source of truth.** Vehicle positions, speeds, signal states and queues come from SUMO. The 3D frontend never simulates traffic.
2. **The frontend only renders and sends intent.** It sends commands (spawn, drive input, start emergency, inject accident, toggle mode). The backend decides what actually happens.
3. **AI proposes, the safety controller disposes.** Every signal action and every autopilot reroute goes through `backend/safety/controller.py` before reaching TraCI. Manual turn/lane intents are not signal actions; `manual_control` checks them for feasibility.
   - The decision logic (`ai/rules.py`) returns requests.
   - The controller (pure Python) turns accepted requests into actuations.
   - `simulation/traffic_lights.py` is the **only** module that calls TraCI signal setters, and it only executes controller actuations. `tests/test_architecture.py` fails the build if a signal setter appears anywhere else, if `traci` is imported outside `simulation/`, or if `ai/` or `safety/` import `simulation`, `api` or `sumolib`.
4. **Never claim realistic vehicle physics.** SUMO is a traffic simulator, not a driving-physics engine. User "driving" is interactive control of a simulated vehicle (lane/route/speed intent).
5. **Three signal modes, always comparable:** `OFF` (normal signals), `BASIC` (rule-based preemption), `COORD` (coordinated: queue-aware preemption timing + downstream preparation + shortest-path routing). Every feature must work across modes so experiments stay fair.
6. **Control mode: MANUAL (v1 default).** The user drives the ambulance with the keyboard (W/S speed, A/D turn choice at the next junction, Q/E lane change). COORD only controls signals and gives **advisory** routing: the suggested route and ETA are drawn as an overlay and "route compromised" is flagged on incidents, but it never steers the ambulance. Batch experiments (section 14) use an autopilot that follows the suggested route so runs are reproducible. A/D are turn intents, not continuous steering.
   - Implementation: `backend/simulation/manual_control.py` and `frontend/src/simulation/useManualDrive.ts`, rewritten in Sprint 2 from the reference demos. Behaviour:
     - Commands only record intent; the engine thread applies them.
     - The TraCI connection is injected.
     - Q/E follow the driving side: lane 0 is the curb lane, which is on the left in left-hand traffic.
     - A turn pressed inside a junction is queued for the next one.
     - An impossible or too-late turn is rejected with a reason, and the plan is kept.
     - A U-turn is taken when it is the only way on (map edge).
     - A Q/E press into an occupied lane is held for 3 s, and the ack says "waiting for a gap".
     - Lane-change mode 513: only route-required lane changes happen automatically, and Q/E respect other vehicles' gaps.
     - On the hospital edge the ambulance parks at the hospital stop (status `arrived`; mission time frozen).
     - The frontend uses physical key codes (`e.code`) and a stable `send`; keys are ignored while typing, and input is released on blur or a hidden tab.
   - Ambulance: vType `ambulance` (vClass emergency, 6 m, accel 3.5, decel 6, `maxSpeed` 22, `speedFactor` 1.6, sigma 0). It spawns at the depot in the curb lane. "Dispatch" while it is on the road respawns it.
   - Backend step order (`engine.tick`):
     1. apply queued commands
     2. `manual.step(dt)`
     3. `controller.step()` → `traffic_lights.apply()`
     4. `simulationStep()`
     5. `manual.observe(...)`
     6. `monitor.observe(...)`
     7. BASIC rule → `controller.request_*()`
     8. publish state
   - Safety: speed mode stays at 31 (red lights and right of way respected; tested), speed is capped at 22 m/s (tested), and a deadman timer zeroes input if drive messages stop for 0.5 s (tested with an injected clock).
7. **Single TraCI owner.** One simulation thread (`backend/simulation/engine.py`) owns the TraCI connection, because TraCI is not thread-safe.
   - WebSocket handlers only `submit()` commands, which return a future. The engine thread applies them before each step and publishes an immutable `EngineState`. The event loop serializes it once and fans it out.
   - Each client gets every ack but only the newest tick, so a slow client skips frames instead of lagging.
   - If SUMO crashes, the engine records the error (`/api/health`) and restarts SUMO after 1 s (tested).

## 3. Tech stack

| Layer | Tech |
|---|---|
| Simulation | Eclipse SUMO 1.27.1 (native Windows install), TraCI, `sumolib` (pip, pinned 1.27.1) |
| Backend | Python 3.13 (3.11+), FastAPI, Uvicorn, WebSockets |
| Routing | SUMO `traci.simulation.findRoute` or `networkx` shortest path with live edge costs |
| Frontend | React, TypeScript, Vite, Three.js, React Three Fiber, `@react-three/drei`, Zustand |
| 3D assets | `.glb` files in `frontend/public/models/` via Git LFS (Blender only for authoring, never at runtime) |
| Data / eval | pandas, matplotlib |
| Testing | pytest (backend), Vitest (frontend) |
| Packaging | GitHub Actions CI; Docker + Docker Compose later, if time |
| Storage | CSV + `run_manifest.json` per run in v1 (no database) |

## 4. Repository structure

```
sparkathon26/                      (EmergencyFlow AI)
├── CLAUDE.md
├── README.md
├── ATTRIBUTIONS.md                # license/credit + validation notes for every 3D asset
├── .env.example                   # copy to .env (git-ignored): SUMO_HOME, EF_SCENARIO, EF_SEED, EF_SCALE
├── 3d_models/                     # team deliveries as received (Git LFS) + the asset workbook
│   ├── EmergencyFlow_3D_Asset_Checklist_Assigned.xlsx   # ownership + priority: source of truth
│   ├── Memeber-1/                 # Member 1's files (folder name as created by the team)
│   ├── member-2/  member-3/       # Members 2 and 3 (final asset set: all four members delivered)
│   └── member-4/                  # Member 4's files
├── frontend/
│   ├── src/
│   │   ├── components/            # TopDownScene, geometry (road ribbons), Label, vehicleStyles;
│   │   │                          # later City3D, Ambulance, TrafficLight, Vehicle, Hospital, Asset
│   │   ├── simulation/            # websocket.ts, state.ts (protocol types + Zustand), coords.ts,
│   │   │                          # useManualDrive.ts (+ *.test.ts)
│   │   ├── assets/                # manifest.ts (asset key -> file, fit, offsets, placeholder), Sprint 5
│   │   ├── dashboard/             # Hud.tsx
│   │   └── app/                   # App.tsx, app.css
│   ├── scripts/                   # check-assets.ts (when the first real model arrives)
│   └── public/models/             # *.glb (Git LFS)
├── backend/
│   ├── requirements.txt           # pinned
│   ├── pyproject.toml             # pytest, ruff, black config
│   ├── api/                       # protocol.py (v1 models), routes.py, websocket.py
│   ├── simulation/                # sumo.py, engine.py, manual_control.py, vehicle.py, network.py,
│   │                              # traffic_lights.py (the only signal actuator + net.xml tables)
│   ├── ai/                        # rules.py (BASIC); later routing.py, signal_optimizer.py, rerouting.py
│   ├── safety/                    # controller.py, monitor.py, invariants.py (R1-R3), signal_table.py
│   ├── scripts/                   # smoke_compare.py (OFF vs BASIC, one seed)
│   ├── tests/                     # incl. test_architecture.py (layering guards), helpers.py
│   └── main.py
├── scenarios/
│   ├── build_grid.py              # grid generator: plain XML -> netconvert -> routes + sumocfg
│   └── grid2x2/                   # grid.nod.xml, grid.edg.xml, network.net.xml,
│                                  # routes.rou.xml (1 h, experiments), routes.live.rou.xml (24 h, live),
│                                  # simulation.sumocfg, scenario.json (depot + hospital)
│                                  # (no signals.add.xml: preemption states are generated at runtime)
└── experiments/<arm>/             # CSV + charts + run_manifest.json, written by the runner (Sprint 9)
```

Keep `prediction.py` out of the repo until post-v1.

## 5. Setup and commands (Windows, PowerShell)

### Prerequisites
- SUMO 1.27.1 (Windows installer) with `SUMO_HOME` set and `%SUMO_HOME%\bin` on `PATH`. Shells opened before the install don't see them: restart, or rely on `.env`.
- Python 3.13, Node.js LTS, Git + Git LFS.

### Backend
```powershell
git lfs install                                   # once per machine
py -3.13 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Copy-Item .env.example .env

cd backend
.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000          # API + live simulation
.venv\Scripts\python.exe -m simulation.sumo --steps 600 --print-every 50   # headless run, prints vehicles + signals
.venv\Scripts\python.exe -m scripts.smoke_compare                          # OFF vs BASIC on one seed (smoke only)
.venv\Scripts\python.exe ..\scenarios\build_grid.py                        # regenerate scenarios\grid2x2
.venv\Scripts\python.exe ..\scenarios\build_grid.py --nx 4 --ny 4          # evaluation grid
```
Call `.venv\Scripts\python.exe` directly instead of activating (avoids the PowerShell execution policy). The backend reads `EF_SCENARIO`, `EF_SEED` and `EF_SCALE` from `.env`.

### Frontend
```powershell
cd frontend
npm install
npm run dev        # open http://localhost:5173 (Vite listens on localhost/::1; it proxies /api and /ws to 127.0.0.1:8000)
npm run build      # typecheck + production build
```

### SUMO sanity checks
```powershell
sumo --version
sumo-gui -c scenarios\grid2x2\simulation.sumocfg    # debug only, not the product UI
```

### Tests and lint
```powershell
cd backend
.venv\Scripts\python.exe -m pytest -q                 # add -m "not slow" to skip the 1-hour scenario run
.venv\Scripts\ruff.exe check --config pyproject.toml . ..\scenarios
.venv\Scripts\black.exe --config pyproject.toml --check . ..\scenarios
cd ..\frontend; npm run test; npm run typecheck
```

## 6. SUMO / TraCI conventions

- **Process and connection:**
  - Start SUMO headless (`sumo`, not `sumo-gui`) from the backend. `sumo-gui` is for debugging only.
  - `simulation/sumo.py` owns the SUMO subprocess and an unlabeled TraCI connection object. Never use the global `traci` module state, so several simulations can run side by side (batch, ghost run).
  - Shutdown is TraCI close, then wait with a timeout, then kill. It runs from `close()`, the context manager and `atexit`. SUMO also exits by itself if its client is killed (tested). Never leave orphan `sumo` processes.
- **Timing:**
  - Fixed step length of 0.1 s.
  - Live mode paces steps at 10 Hz real time and broadcasts every step. Small jitter is caught up; after a longer stall (a reset restarting SUMO) the loop resyncs instead of bursting ticks. Measured: median tick interval 100 ms, worst 113 ms. Batch mode runs unpaced; `libsumo` is allowed there.
  - Under TraCI, SUMO does not stop at the sumocfg `end` time; the client decides.
  - **Live vs experiment demand:** the live server (`main.py`) loads `routes.live.rou.xml`, with the same flows generated for 24 h, through `SumoConfig(routes=...)`. Experiments, tests and the sumocfg keep `routes.rou.xml` at **exactly 1 h**, so the benchmark stays controlled. Don't change the 1 h file for the demo.
  - Signal timing semantics: the signal state read after `simulationStep()` at time t is the one that governed the step ending at t. Phase changes therefore appear one step (0.1 s) after their nominal start, while durations are exact. Measure clearance as the difference between observed switch times.
- **Per-step reads:** use TraCI subscriptions, not per-vehicle getter loops (each TraCI call is a TCP round trip).
  - Signals: one subscription per signal.
  - Vehicles: one context subscription on the central junction with a radius covering the map.
  - Simulation time and SUMO's per-step collision count: one simulation subscription.
  - SUMO reports a vehicle's front-bumper position; `sumo.py` converts it to the vehicle **centre** before anything else sees it.
- **Traffic side:** left-hand traffic (India), via `netconvert --lefthand`. Lane 0 is the curb (left) lane and carries left + straight; lane 1 carries straight + right. The right turn crosses oncoming traffic and is permissive (`g`).
- **Network (`scenarios/build_grid.py`):**
  - Grid of signalized junctions named `<col letter><row>` (A0 is south-west), 250 m apart, with 200 m roads to the map edge.
  - Map-edge nodes are `n<col>`/`s<col>`/`w<row>`/`e<row>`; edges are `<from>_<to>`.
  - 2 lanes each way at 13.89 m/s.
  - Fixed-time signals, opposite approaches paired: green 31 s, yellow 4 s, all-red 2 s, so the cycle is 74 s, with offsets of 0.
  - No U-turns at signals (`--no-turnarounds.tls`); turnarounds exist at map-edge nodes.
- **Background traffic:**
  - Poisson flows (`period="exp(rate)"`) between every pair of map-edge roads, so the seed changes the traffic. 400 veh/h per entry at `--scale 1.0`; the heavy-traffic demo is `--scale 1.5`.
  - The vType id is the 3D asset key.
  - Cars only (`car_sedan` 70%, `car_hatchback` 30%). Trucks and buses on permissive turns caused SUMO junction collisions (1–11 per hour at 1.5x). They return only with protected turn phases plus a collision check.
- **sumocfg:** seed 42, `lanechange.duration` 1.5 s (smooth lateral motion, far fewer emergency braking events), `time-to-teleport` 300 (teleports flag a bad run), collision warnings with junction checks on. Baseline target: 0 collisions and 0 teleports (a slow test enforces this).
- **Ambulance:** a vehicle with `vClass="emergency"` and a dedicated vType (`ambulance`), see section 2.6. Depot and hospital come from the scenario's `scenario.json`: the depot is the start of `w0_A0` (west edge), and the hospital is 15 m before the end of `B1_e1` (east edge).
- **Routing:** use `traci.simulation.findRoute(fromEdge, toEdge)` (Dijkstra by default) or `networkx` on the `sumolib` network. The cost function (live travel time, queues, signal wait, incidents) is what matters, not the algorithm. Re-evaluate on a timer or on incident events, not every step.
- **Layering:** wrap TraCI calls in the `simulation/` layer. API handlers, AI modules and tests never import `traci` directly.

## 7. Signal preemption rules (BASIC mode)

Implemented in Sprint 3 (`ai/rules.py` proposes; `safety/controller.py` decides).
1. **Next signal:** `vehicle.getNextTLS()` gives the next signal, the exact link index the ambulance will use, and its distance. ETA = distance / max(speed, 5 m/s). The 5 m/s floor means a slow or stopped ambulance near the stop line still gets green.
2. **Preempt:** when ETA ≤ **15 s**, request the **approach-exclusive** state: every link from the ambulance's incoming edge is `G` and everything else is `r`. This state is generated from the junction's link table.
3. **Clearance:** links losing green show yellow for 4 s, followed by an all-red of 2 s. Links already green for the approach keep their green. If the normal program is mid-yellow, the controller restarts a full 4 s yellow (conservative).
4. **Release:** a junction is released once the ambulance has passed it (it isn't inside the junction and the junction is no longer its next signal) or has left the road. Slowing down doesn't release it. A preemption lasts at most **40 s from acceptance** before it times out and recovers.
5. **Recovery:** yellow 4 s, all-red 2 s, then `setProgram("0")` + `setPhase(k)`, where k is the **other direction's green** (the normal green phase giving no green to the preempted approach). The cross traffic then keeps that green for at least **10 s** before the junction accepts a new preemption.
6. **Routing of requests:** all requests go through the safety controller. Requests the controller rejects for the same reason on every tick are logged once.

COORD mode adds two things, both rule-based rather than learned:
- **Queue-aware lead time:** preempt when `ETA <= clearance + startup loss + queued vehicles x ~2 s headway`, so the queue has discharged before the ambulance arrives.
- **Downstream preparation:** the same rule applied to the next 2–3 junctions on the route.

## 8. Safety controller requirements

`backend/safety/controller.py` must validate, and be unit-tested for:
- Valid phase transitions only (no conflicting greens). The conflict check uses the junction foe matrix from `network.net.xml` and treats `G` (priority) and `g` (must yield) correctly.
- Minimum yellow (4 s) and all-red (2 s) clearance times honored, measured per the timing semantics in section 6.
- Emergency authorization (only a vehicle with `vClass="emergency"` may trigger preemption)
- Maximum preemption duration (fail back to the normal program on timeout)
- Controller health: if the engine or decision logic errors, fall back to the normal signal program
- Every accept/reject logged with reason

Implemented in Sprint 3:
- **Rules** (`safety/invariants.py`), checked on observed states:
  - R1: no two conflicting links are `G` at the same time.
  - R2: green → yellow → red only; yellow lasts ≥ 4 s and never returns to green.
  - R3: a link turns green or gains priority (`g` → `G`) only after every conflicting link has been red for ≥ 2 s.
- **Conflict data:** `simulation/traffic_lights.py` reads the conflict sets from `network.net.xml` (`<request foes>`, rightmost bit = request 0). It maps signal link indices through each connection's `via` lane, following split turns, and verifies the matrix is symmetric.
- **Plan checks:** before accepting, the controller replays every plan through the same rules and rejects unsafe plans. A broken recovery plan raises `UnsafePlanError` and the engine restarts SUMO.
- **Fail-safe:** if the decision logic throws, the engine recovers every junction (`fail_safe`, with clearance) and switches to OFF.
- **Independent safety monitor** (`backend/safety/monitor.py`): reads the actual signal state from SUMO every step and applies R1–R3. "Safety violations = 0" is reported from the monitor plus SUMO's collision count, never from the controller's own logs. The normal program itself passes the monitor (tested over 3 cycles).

Never bypass or weaken these checks to make a demo work. Never describe the system as controlling real traffic signals.

## 9. WebSocket protocol (v1)

Every message carries `"v": 1`. The source of truth is `backend/api/protocol.py` (pydantic, camelCase JSON) mirrored by `frontend/src/simulation/state.ts`. Any change must update both in the same commit; a breaking change bumps the version. Fields marked "(Sprint N)" are sent as `null`/`0`/`[]` until that sprint.

Static network, fetched once via `GET /api/network`. The frontend generates roads, signal lamps and markers from it. Coordinates are SUMO metres. `GET /api/health` returns `{status: starting|running|error, error, seq, t}`.
```json
{
  "v": 1, "lefthand": true, "bounds": [0, 0, 650, 650],
  "lanes": [{"id": "w0_A0_0", "edge": "w0_A0", "index": 0, "width": 3.2, "shape": [[0, 204.8], [189.6, 204.8]]}],
  "junctions": [{"id": "A0", "type": "traffic_light", "shape": [[193.6, 189.6], [206.4, 189.6]]}],
  "signals": [{"id": "A0", "links": [{"index": 12, "fromLane": "w0_A0_0", "toLane": "A0_A1_0", "dir": "l", "approach": "w0_A0"}]}],
  "depot": {"edge": "w0_A0", "pos": 0.0, "x": 0.0, "y": 204.8},
  "hospital": {"edge": "B1_e1", "pos": 174.6, "x": 635.0, "y": 454.8}
}
```

Backend → frontend (state tick, every step at 10 Hz):
```json
{
  "v": 1, "type": "state", "seq": 1234, "t": 123.4, "mode": "BASIC",
  "vehicles": [{"id": "ambulance_01", "type": "ambulance", "x": 421.4, "y": 193.2, "angle": 90, "speed": 16.8, "edge": "A0_B0", "lane": 1}],
  "signals": [{"id": "B0", "state": "rrrrrrrrrrrrGGGG", "phase": 0, "preempted": true, "control": "preempted"}],
  "ambulance": {"id": "ambulance_01", "status": "driving", "throttle": 1, "brake": 0,
                "nextSignal": {"junction": "B0", "linkIndex": 13, "distance": 84.2, "state": "G"},
                "plannedTurn": {"junction": "B0", "turn": "left", "edge": "B0_B1"},
                "queuedTurn": null, "missionTime": 41.5},
  "route": null,
  "metrics": {"eta": null, "signalsPreempted": 2, "queueCleared": null, "timeSaved": null},
  "safety": {"violations": 0, "collisions": 0,
             "events": [{"t": 18.4, "junction": "B0", "vehicle": "ambulance_01", "action": "preempt",
                         "accepted": true, "reason": "ETA 14.5 s: clearing B0 for A0_B0 (yellow 4 s, all-red 2 s)"}]},
  "incidents": []
}
```
Field notes:
- **Vehicle `x`, `y`:** the vehicle centre.
- **Vehicle `lane`:** 0 is the curb lane.
- **Signal `state`:** one character per link (SUMO notation), indexed by link index. A junction does not have a single colour.
- **`ambulance.status`:** `none | pending | driving | arrived`.
- **`ambulance.throttle` / `brake`:** the input the backend actually applied, after the deadman timer.
- **`nextSignal.state` / `linkIndex`:** the ambulance's own link.
- **Signal `control`:** `program | clearing | preempted | recovering`. `preempted` is true whenever it isn't `program`. `phase` only means something under program control.
- **`safety`:** `violations` comes from the independent monitor and `collisions` from SUMO (both since the simulation started). `events` holds the controller's most recent decisions (up to 8; most recent last), with actions `preempt`, `green`, `release`, `timeout`, `resume` and `fail_safe`.
- **`route`:** arrives in Sprint 6.
- **`metrics`:** `signalsPreempted` counts preemptions that reached green. `timeSaved` stays `null` unless it was measured against the ghost run (section 14).
- **`mode`:** `OFF` or `BASIC`. `COORD` is rejected until Sprint 7.

Frontend → backend (commands). Every command except `drive` carries an `id` and gets an ack once the engine has run it:
```json
{"v": 1, "id": 1, "cmd": "spawn_ambulance"}                                                  // dispatch (respawns if on the road)
{"v": 1, "cmd": "drive", "vehicle": "ambulance_01", "control": {"throttle": 1, "brake": 0}}   // on change + 10 Hz heartbeat, no ack
{"v": 1, "id": 3, "cmd": "turn", "vehicle": "ambulance_01", "direction": "left|right"}     // intent for the next junction
{"v": 1, "id": 4, "cmd": "lane", "vehicle": "ambulance_01", "direction": "left|right"}
{"v": 1, "id": 6, "cmd": "reset"}                                                            // restarts SUMO (same seed)
{"v": 1, "id": 2, "cmd": "set_mode", "mode": "OFF|BASIC|COORD"}                             // OFF releases all; COORD: Sprint 7
{"v": 1, "id": 5, "cmd": "inject_incident", "type": "accident", "edge": "A0_B0"}            // Sprint 8
```
```json
{"v": 1, "type": "ack", "id": 3, "ok": false, "reason": "too late to turn right at A0: needs the inner lane, only 4 m left"}
{"v": 1, "type": "ack", "id": 4, "ok": true, "reason": "waiting for a gap in the curb lane"}
{"v": 1, "type": "error", "reason": "message is not valid JSON"}
```
Replies:
- **Invalid commands with an `id`:** get `ok: false` with a reason.
- **Unreadable messages:** get an `error`.
- **Accepted commands:** `ok: true` may still carry an informative reason ("left turn queued for B0", "waiting for a gap in the curb lane").

## 10. Coordinate and orientation mapping

- SUMO: x east, y north, angle in degrees clockwise from north.
- Three.js: x east, y up, z south. Recenter on the network center: `world = (x - cx, 0, -(y - cy))`.
- Rotation for glTF models facing +Z: `rotation.y = π − angle·π/180` (north → π, east → π/2, south → 0, west → −π/2). This conversion lives in **one** utility (`frontend/src/simulation/coords.ts`, unit-tested for every 15° heading). Do not inline it in components.
- Flat generated geometry must face up (+Y), or three.js culls it when seen from above. `geometry.test.ts` checks the face normals.
- Map labels are canvas-texture sprites (`components/Label.tsx`) with a constant on-screen size. Don't use drei `<Html>` (an extra React root per label, which errors under StrictMode) or drei `<Text>` (it fetches a font from a CDN).
- Interpolate between ticks on the client (positions linearly, angles along the shortest arc). Never extrapolate beyond one tick. Interpolation adds one tick (100 ms) of display latency; give instant HUD feedback on keydown instead of predicting motion.
- Per-asset rotation and pivot offsets come from the asset manifest and are applied on a child group, never in `coords.ts`.

## 11. 3D asset rules

- Format: `.glb`, one file per model, textures embedded, committed via **Git LFS**.
- **Licensing:** the team confirmed (2026-10-05) that every delivered `.glb` is purchased or licensed for project use. `ATTRIBUTIONS.md` records source and author credit where known. An empty Source/Link field in the workbook never blocks an asset.
- **Delivered files are never modified:** no compression, re-encoding, texture resizing, simplification, replacement or renaming of asset files or folders unless explicitly instructed. Scale, rotation and pivot are calibrated in the manifest. Heavy assets are handled in the renderer (lazy loading, instancing, level of detail), never by editing the file.
- Real-world scale in meters (car ~4.5 m, ambulance ~6 m, bus ~12 m). Delivered models rarely are, and the manifest's `fit` corrects that.
- Forward = +Z, pivot at center-bottom (the manifest can correct either).
- Budget guideline: ~5k triangles per vehicle, ~20k per building. It's a performance target for the renderer, not a reason to reject or edit a delivered asset.
- Traffic light lamps are **separate named meshes**: `lamp_red`, `lamp_yellow`, `lamp_green`. Ambulance has a named `siren` mesh; wheels are named `wheel_*` if separate.
- Roads, junctions, lane markings, signal-head placement and route overlays are **generated in code** from the network (`/api/network`), not modeled.
- One signal head per approach at the stop line, lit from that approach's links.
- Missing assets get placeholders. Never block progress on art. Until the manifest exists (Sprint 5), placeholder sizes and colours per vType live in `frontend/src/components/vehicleStyles.ts`.

**Team deliveries (`3d_models/`).**
- The workbook `3d_models/EmergencyFlow_3D_Asset_Checklist_Assigned.xlsx` is the **source of truth** for ownership and priority. Never reassign assets.
- Each member delivers into their own folder. All four members have delivered (2026-10-05), and the files in `3d_models/` are the **final asset set**: no more uploads are coming, and every workbook asset has a file. Placeholders remain only as the fallback when a file fails to load, and the app must still run without any model.
- Non-GLB deliveries are used as delivered:
  - the crashed car is a multi-file `.gltf` with its `.bin` and PNG textures
  - the skybox is a 72 MB `.exr`

  `.gitattributes` routes them through Git LFS byte-exact.
- When new files arrive:
  1. Commit them under `3d_models/` (Git LFS).
  2. Map each file to its workbook asset and asset key.
  3. Add or enable its manifest entry (Sprint 5+).
  4. Validate the GLB: triangles, real-world size, named parts, texture weight.
  5. Record source, credit and validation notes in `ATTRIBUTIONS.md`.
  6. The placeholder swaps automatically. Simulation logic never changes.
- Mapping decided by the team: `member-4/model.glb` (internal name "bazaar-street-and-shrine") is Member 4's **Shops / commercial row**.
- Sprint 3 validation of the Member 1 and Member 4 deliveries (details in `ATTRIBUTIONS.md`), used as-is:
  - All 22 files are valid GLBs.
  - Almost none is in metres, so the manifest's auto-fit (`fit`) is required.
  - The ambulance has no `siren` or wheel parts, so it uses the fallback.
  - Above the triangle guideline: `model.glb` (92k triangles, 859 nodes), `auto_rickshaw` and Truck (vehicles above 5k).
  - `standard_bus_stop.glb` is 23.7 MB, almost all textures. Load it lazily (after the scene is interactive) so it doesn't delay the first frame.

**Asset pipeline.** Manifest and fallback come in Sprint 5. The `/assets` page and `check:assets` are built with the 3D scene in Sprint 5, now that real models exist.
- **Manifest:** `frontend/src/assets/manifest.ts` maps each asset key to `{ file, enabled, fit?: {axis, meters}, scale?, rotationY?, offset?, pivot: "bottom-center" | "none", placeholder: {size, color, shape}, requiredParts?, optionalParts?, aliases?, triBudget }`. Asset keys: ambulance, car_sedan, car_hatchback, bus, truck, traffic_light, hospital, building_01..05, cone, barricade, wrecked_car, tree, streetlight. The SUMO vType id equals the asset key.
- **`<Asset id>`:**
  - `enabled: false` renders the placeholder without fetching.
  - A 404 or parse error falls back to the placeholder and logs one warning.
  - A loaded model is cloned per instance (materials too, since `useGLTF` caches one scene), then auto-fitted to `fit` meters and pivoted from its bounding box. Manifest offsets go on a child group.
  - Missing required parts log a warning and fall back to whole-model behavior (placeholder lamp discs, emissive siren pulse).
- **Swapping a placeholder** for a real model means dropping in the `.glb` and setting `enabled: true`. No component edits.
- **Name matching:** match node names case-insensitively, because the loader strips `.` and Blender appends `.001`. Use `aliases` for odd names.
- **Draco/Meshopt decoders:** self-host them in `public/`, never from a CDN (venue Wi-Fi).
- **Dev-only `/assets` page:** every asset on a grid with axes, a 1 m grid, a 5 m ruler, bounding-box size, triangle count, load status (loaded / placeholder / error / missing parts) and a "copy manifest entry" button.
- **`npm run check:assets`** (gltf-transform): for each `.glb`, reports triangles vs budget, bounding box in meters, a forward-axis guess (sign unconfirmed), node names, missing required parts, file size and a missing `ATTRIBUTIONS.md` row. It warns by default; `--strict` is for CI.
- **Instancing:** use instancing (drei `<Instances>`/`<Merged>`) for background cars once counts exceed ~100.

## 12. Code conventions

- **Python:**
  - Type hints everywhere, `ruff` + `black` (line length 100, config in `backend/pyproject.toml`), small modules, no global mutable state outside the simulation manager.
  - Format with black before committing.
- **TypeScript:** `strict` mode, no `any`, state in Zustand, components stay presentational.
- Prefer iterative changes to the existing code over full rewrites.
- Commit messages: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- **Git:** `main` holds approved work. Each sprint is built on `sprint-<n>/<name>` (e.g. `sprint-1/sumo-world`) and merged after approval. Keep PRs small and reviewable.
- Secrets and local paths go in `.env` (git-ignored). Commit `.env.example`.

## 13. Roadmap (v1)

| Sprint | Deliverable |
|---|---|
| 1 | SUMO world: 2x2 signalized grid (left-hand traffic), seeded background traffic, clean TraCI lifecycle, tests ✅ |
| 2 | Ambulance vType + manual WASD control (reference demos reworked) + FastAPI WebSocket + React Three Fiber top-down view; input latency measured ✅ |
| 3 | Safety controller + independent monitor (tests first), BASIC preemption with clearance and recovery, OFF/BASIC mode in protocol + UI, 24 h live traffic ✅ |
| 4 | Full WebSocket protocol v1: `/api/network`, versioned messages, command acks, subscriptions for all per-step reads |
| 5 | 3D scene with placeholders: roads from the network, vehicles, per-approach signal heads, hospital, chase camera; asset manifest + fallback; `coords.ts` |
| 6 | Shortest-path routing with live costs + route overlay + ETA |
| 7 | COORD: queue-aware preemption lead time + downstream junction preparation |
| 8 | Accident injection + automatic reroute + "route compromised" |
| 9 | Experiment runner (paired seeds, arms, demand sweep) + charts + **ghost comparison run** |
| 10 | CI, README, demo script hardening; Docker if time |

Asset tooling (`/assets` debug page, `check:assets`) is part of Sprint 5, since real models have arrived.

Post-v1 (do not start early): traffic prediction, RL, OSM real-city import, multi-emergency-vehicle coordination, trucks/buses with protected turn phases.

## 14. Evaluation and metrics

Run seeded batch headless simulations comparing arms, typically on a 4x4 grid; the 2x2 grid has too few alternative routes to show routing effects.

- **Arms:** signals {OFF, BASIC, COORD} × routing {static, dynamic}. OFF is run in two variants:
  - `off_strict`: the ambulance obeys red lights.
  - `off_realistic`: the ambulance crosses reds cautiously, modeled with SUMO's emergency-vehicle behavior (still to verify, Sprint 9).
  - Until then, `scripts/smoke_compare.py` runs OFF vs BASIC on one seed as a smoke test only. It reports mission time, stops, preemptions, violations, collisions, and background halted vehicle-seconds over the same fixed 300 s window.
  - All arms share one base signal program, tuned for the demand (SUMO `tlsCycleAdaptation.py`) so OFF is not a strawman.
- **Fairness:**
  - Use the same seed set across all arms and report paired differences with bootstrap 95% CIs (plus a Wilcoxon test). Pick the run count by CI width.
  - Randomize dispatch time after a ≥300 s warm-up, plus origin and destination per seed.
  - Sweep demand with `--scale` (e.g. 0.75 / 1.0 / 1.5 / 2.0).
  - The experiment ambulance uses `sigma=0` and `speedDev=0`.
- **Primary metric:** ambulance travel time.
- **Secondary metrics:**
  - Ambulance waiting time and red-light stops.
  - Average queue length and time to clear a junction.
  - Background-traffic delay (`tripinfo` timeLoss over a fixed window that includes recovery) and maximum side-street wait. These are headline numbers, not footnotes.
  - Route changes and preemption count.
  - Safety violations: from the independent monitor plus SUMO collisions and emergency braking. Must be 0 beyond the OFF baseline on the same seeds.
- **Data quality:** count teleports per run and flag or exclude those runs.
- **Ghost comparison run:** at dispatch, save SUMO state, replay the same scenario headless in OFF mode with the autopilot, render its ambulance as a translucent ghost, and compute `timeSaved` from it.
- **Output:** CSVs and matplotlib charts go to `experiments/<arm>/`, plus a `run_manifest.json` per run (SUMO version, git SHA, config hash, seed, scale, arm). Always seed runs. Label charts as autopilot results, since the live demo is manual.

## 15. Demo script

1. Heavy traffic (`--scale 1.5`), ambulance parked, mode OFF.
2. Press **Start Emergency**: show normal-signal delay; the OFF ghost appears.
3. Switch to BASIC: the signal turns green on approach after yellow + all-red clearance.
4. Switch to COORD: downstream junctions prepare; route overlay shown.
5. Press **Create Accident**: route recalculates, new ETA shown.
6. Show the comparison chart **inside the app**. Switching windows or tabs releases the keys and the ambulance coasts to a stop, by design.

## 16. Do / Don't

**Do**
- Build one junction first, then scale.
- Keep SUMO authoritative and the frontend dumb.
- Test the safety controller before any decision logic.
- Measure everything; no claims without numbers.
- Describe it as a "simulation testbed" with "rule-based" decision logic.

**Don't**
- Don't add ML/RL in v1.
- Don't start with CARLA or MOSAIC.
- Don't let the decision logic or frontend touch signals directly.
- Don't claim novelty from "ambulance turns the signal green". The contribution is the closed-loop testbed, the human-in-the-loop driving, the verified safety layer, queue-aware coordination and fair, reproducible evaluation.
- Don't call it a digital twin of a real city, call COORD "AI" without saying it is rule-based, or show an unmeasured `timeSaved`.
- Don't use SUMO-GUI as the final UI.
- Don't commit large binaries outside Git LFS.
- Don't modify, compress, rename or replace delivered `.glb` files or the `3d_models/` folders unless explicitly instructed.

## 17. Definition of done (per feature)

- Works in all three modes (or is explicitly mode-specific)
- Unit tests pass; safety tests cover any signal-affecting change
- No direct TraCI calls outside `simulation/`
- Message schema updated on both sides
- README/CLAUDE.md updated if behavior or commands changed
- Verified in the browser at 30+ FPS with the demo scenario running (from Sprint 2)
