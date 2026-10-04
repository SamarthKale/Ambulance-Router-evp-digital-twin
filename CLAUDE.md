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
3. **AI proposes, the safety controller disposes.** Every signal action and every autopilot reroute goes through `backend/safety/controller.py` before reaching TraCI. No code path may call a TraCI signal-setting function directly except through the safety controller. Manual turn/lane intents are not signal actions; `manual_control` checks them for feasibility.
4. **Never claim realistic vehicle physics.** SUMO is a traffic simulator, not a driving-physics engine. User "driving" is interactive control of a simulated vehicle (lane/route/speed intent).
5. **Three signal modes, always comparable:** `OFF` (normal signals), `BASIC` (rule-based preemption), `COORD` (coordinated: queue-aware preemption timing + downstream preparation + shortest-path routing). Every feature must work across modes so experiments stay fair.
6. **Control mode: MANUAL (v1 default).** The user drives the ambulance with the keyboard (W/S speed, A/D turn choice at the next junction, Q/E lane change). COORD only controls signals and gives **advisory** routing: the suggested route and ETA are drawn as an overlay and "route compromised" is flagged on incidents, but it never steers the ambulance. Batch experiments (section 14) use an autopilot that follows the suggested route so runs are reproducible. A/D are turn intents, not continuous steering.
   - Implementation: `backend/simulation/manual_control.py` and `frontend/src/simulation/useManualDrive.ts`. Both are **untested reference demos**, moved unchanged in Sprint 1. They do not constrain the implementation. Known issues to fix in Sprint 2:
     - `handle()` calls TraCI from the WebSocket side, which is not thread-safe.
     - It uses the global `traci` module.
     - Q/E are inverted under left-hand traffic.
     - The ambulance gets stuck at map-edge dead ends.
     - Turn presses inside a junction are dropped.
     - Infeasible late turns can stall the ambulance at the stop line.
     - 22 m/s is unreachable without an ambulance vType `speedFactor` of about 1.6.
     - The frontend hook should use `e.code` instead of `e.key`, and it needs a stable `send`.
   - Backend step order: apply queued commands, `manual.step(dt)`, `simulationStep()`, publish snapshot, broadcast.
   - Safety: in live mode speed mode stays at 31 (red lights and right-of-way respected), speed is capped at 22 m/s, and a deadman timer zeroes input if drive messages stop for 0.5 s. The ambulance vType sets `speedFactor`/`accel`/`decel` so the cap and the ACCEL/BRAKE constants are actually reachable.
7. **Single TraCI owner.** One simulation thread owns the TraCI connection. WebSocket handlers only enqueue commands; the sim thread applies them before each step and publishes an immutable snapshot that the async side broadcasts. TraCI is not thread-safe.

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
├── ATTRIBUTIONS.md                # license/credit for every 3D asset
├── .env.example                   # copy to .env (git-ignored): SUMO_HOME, EF_SCENARIO, EF_SEED
├── frontend/
│   ├── src/
│   │   ├── components/            # City3D, Ambulance, TrafficLight, Vehicle, Hospital, Asset
│   │   ├── simulation/            # websocket.ts, state.ts (Zustand), coords.ts, useManualDrive.ts
│   │   ├── assets/                # manifest.ts (asset key -> file, fit, offsets, placeholder)
│   │   ├── dashboard/             # HUD, telemetry, controls
│   │   └── app/
│   ├── scripts/                   # check-assets.ts (when the first real model arrives)
│   └── public/models/             # *.glb (Git LFS)
├── backend/
│   ├── requirements.txt           # pinned
│   ├── pyproject.toml             # pytest, ruff, black config
│   ├── api/                       # routes.py, websocket.py
│   ├── simulation/                # sumo.py, manual_control.py, vehicle.py, traffic_lights.py, network.py
│   ├── ai/                        # routing.py, rules.py, signal_optimizer.py, rerouting.py
│   ├── safety/                    # controller.py, monitor.py
│   ├── tests/
│   └── main.py
├── scenarios/
│   ├── build_grid.py              # grid generator: plain XML -> netconvert -> routes + sumocfg
│   └── grid2x2/                   # grid.nod.xml, grid.edg.xml, network.net.xml, routes.rou.xml,
│                                  # simulation.sumocfg (signals.add.xml arrives with preemption)
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
.venv\Scripts\python.exe -m simulation.sumo --steps 600 --print-every 50   # headless run, prints vehicles + signals
.venv\Scripts\python.exe ..\scenarios\build_grid.py                        # regenerate scenarios\grid2x2
.venv\Scripts\python.exe ..\scenarios\build_grid.py --nx 4 --ny 4          # evaluation grid
```
Call `.venv\Scripts\python.exe` directly instead of activating (avoids the PowerShell execution policy). `uvicorn main:app --reload --port 8000` arrives in Sprint 2.

### Frontend (from Sprint 2)
```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173
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
cd ..\frontend; npm run test                          # from Sprint 2
```

## 6. SUMO / TraCI conventions

- **Process and connection:**
  - Start SUMO headless (`sumo`, not `sumo-gui`) from the backend. `sumo-gui` is for debugging only.
  - `simulation/sumo.py` owns the SUMO subprocess and an unlabeled TraCI connection object. Never use the global `traci` module state, so several simulations can run side by side (batch, ghost run).
  - Shutdown is TraCI close, then wait with a timeout, then kill. It runs from `close()`, the context manager and `atexit`. SUMO also exits by itself if its client is killed (tested). Never leave orphan `sumo` processes.
- **Timing:**
  - Fixed step length of 0.1 s.
  - Live mode paces steps at 10 Hz real time and broadcasts every step. Batch mode runs unpaced; `libsumo` is allowed there.
  - Signal timing semantics: the signal state read after `simulationStep()` at time t is the one that governed the step ending at t. Phase changes therefore appear one step (0.1 s) after their nominal start, while durations are exact. Measure clearance as the difference between observed switch times.
- **Per-step reads:** use TraCI subscriptions, not per-vehicle getter loops (each TraCI call is a TCP round trip).
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
- **Ambulance:** a vehicle with `vClass="emergency"` and a dedicated vType (`ambulance`, Sprint 2).
- **Routing:** use `traci.simulation.findRoute(fromEdge, toEdge)` (Dijkstra by default) or `networkx` on the `sumolib` network. The cost function (live travel time, queues, signal wait, incidents) is what matters, not the algorithm. Re-evaluate on a timer or on incident events, not every step.
- **Layering:** wrap TraCI calls in the `simulation/` layer. API handlers, AI modules and tests never import `traci` directly.

## 7. Signal preemption rules (BASIC mode)

1. Use `vehicle.getNextTLS()` for the next signal, the exact link index the ambulance will use, and its distance. Compute ETA from that.
2. If ETA is under the preempt threshold, request the **approach-exclusive** state: every link from the ambulance's incoming edge is `G` and everything else is `r`. This state is generated from the junction's link table.
3. Respect yellow and all-red **clearance** before switching. Never jump straight from green on one approach to green on a conflicting one.
4. After the ambulance clears the junction, recover via yellow, then all-red, then `setProgram("0")` + `setPhase(k)` with a defined k. `setRedYellowGreenState` holds forever, so the controller owns the timeout.
5. All requests go through the safety controller.

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

An **independent safety monitor** (`backend/safety/monitor.py`) reads the actual signal state from SUMO every step and checks the same invariants. "Safety violations = 0" is reported from the monitor plus SUMO's collision and emergency-braking outputs, never from the controller's own logs.

Never bypass or weaken these checks to make a demo work. Never describe the system as controlling real traffic signals.

## 9. WebSocket protocol (v1)

Every message carries `"v": 1`. Any change bumps the version and must update both `state.ts` types and the backend models in the same commit.

Static network, fetched once via `GET /api/network`. The frontend generates roads and places one signal head per approach from it:
```json
{
  "v": 1, "lefthand": true, "bounds": [0, 0, 650, 650],
  "lanes": [{"id": "w0_A0_0", "edge": "w0_A0", "width": 3.2, "shape": [[0, 204.8], [189.6, 204.8]]}],
  "junctions": [{"id": "A0", "shape": [[190.4, 210.8], [209.6, 210.8]]}],
  "signals": [{"id": "A0", "links": [{"index": 12, "fromLane": "w0_A0_0", "toLane": "A0_A1_0", "dir": "l", "approach": "w0_A0"}]}]
}
```

Backend → frontend (state tick, every step):
```json
{
  "v": 1, "type": "state", "seq": 1234, "t": 123.4, "mode": "COORD",
  "vehicles": [{"id": "ambulance_01", "type": "ambulance", "x": 421.4, "y": 193.2, "angle": 90, "speed": 16.8, "edge": "A0_B0", "lane": 1}],
  "signals": [{"id": "A0", "state": "GGGgrrrrGGGgrrrr", "phase": 0, "preempted": false}],
  "route": {"vehicle": "ambulance_01", "edges": ["w0_A0", "A0_B0", "B0_B1"], "eta": 41.2, "compromised": false},
  "metrics": {"eta": 41.2, "signalsPreempted": 3, "queueCleared": 41, "timeSaved": null},
  "incidents": []
}
```
Signal `state` has one character per link (SUMO notation). A junction does not have a single color. `timeSaved` is `null` unless it was measured against the ghost run (section 14).

Frontend → backend (commands). Every command except `drive` carries an `id` and gets an ack:
```json
{"v": 1, "id": 1, "cmd": "spawn_ambulance"}
{"v": 1, "id": 2, "cmd": "set_mode", "mode": "OFF|BASIC|COORD"}
{"v": 1, "cmd": "drive", "vehicle": "ambulance_01", "control": {"throttle": 1, "brake": 0}}   // on change + 10 Hz heartbeat, no ack
{"v": 1, "id": 3, "cmd": "turn", "vehicle": "ambulance_01", "direction": "left|right"}     // intent for the next junction
{"v": 1, "id": 4, "cmd": "lane", "vehicle": "ambulance_01", "direction": "left|right"}
{"v": 1, "id": 5, "cmd": "inject_incident", "type": "accident", "edge": "A0_B0"}
{"v": 1, "id": 6, "cmd": "reset"}
```
```json
{"v": 1, "type": "ack", "id": 3, "ok": false, "reason": "no left turn at B1"}
```

## 10. Coordinate and orientation mapping

- SUMO: x east, y north, angle in degrees clockwise from north.
- Three.js: x east, y up, z south. Recenter on the network center: `world = (x - cx, 0, -(y - cy))`.
- Rotation for glTF models facing +Z: `rotation.y = π − angle·π/180` (north → π, east → π/2, south → 0, west → −π/2). Put this conversion in **one** utility (`frontend/src/simulation/coords.ts`) and unit-test it for N/E/S/W. Do not inline it in components.
- Interpolate between ticks on the client (positions linearly, angles along the shortest arc). Never extrapolate beyond one tick. Interpolation adds one tick (100 ms) of display latency; give instant HUD feedback on keydown instead of predicting motion.
- Per-asset rotation and pivot offsets come from the asset manifest and are applied on a child group, never in `coords.ts`.

## 11. 3D asset rules

- Format: `.glb`, one file per model, textures embedded, committed via **Git LFS**.
- Sources: Kenney and Quaternius (CC0) first. Sketchfab only for CC0/CC-BY assets. Every asset needs a row in `ATTRIBUTIONS.md`, and CC-BY credit is also shown in-app. CC-BY-NC and Sketchfab "Standard"/"Editorial" are not allowed.
- Real-world scale in meters (car ~4.5 m, ambulance ~6 m, bus ~12 m).
- Forward = +Z, pivot at center-bottom (the manifest can correct either).
- Budget: under ~5k triangles per vehicle, ~20k per building.
- Traffic light lamps are **separate named meshes**: `lamp_red`, `lamp_yellow`, `lamp_green`. Ambulance has a named `siren` mesh; wheels are named `wheel_*` if separate.
- Roads, junctions, lane markings, signal-head placement and route overlays are **generated in code** from the network (`/api/network`), not modeled.
- One signal head per approach at the stop line, lit from that approach's links.
- Missing assets get placeholders. Never block progress on art.

**Asset pipeline.** Manifest and fallback come in Sprint 5. The `/assets` page and `check:assets` come when the first real `.glb` arrives.
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
  - The reference `manual_control.py` is excluded from lint until it is integrated.
- **TypeScript:** `strict` mode, no `any`, state in Zustand, components stay presentational.
- Prefer iterative changes to the existing code over full rewrites.
- Commit messages: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- **Git:** `main` holds approved work. Each sprint is built on `sprint-<n>/<name>` (e.g. `sprint-1/sumo-world`) and merged after approval. Keep PRs small and reviewable.
- Secrets and local paths go in `.env` (git-ignored). Commit `.env.example`.

## 13. Roadmap (v1)

| Sprint | Deliverable |
|---|---|
| 1 | SUMO world: 2x2 signalized grid (left-hand traffic), seeded background traffic, clean TraCI lifecycle, tests ✅ |
| 2 | Ambulance vType + manual WASD control (rework the reference demos) + **minimal FastAPI WebSocket and top-down box view**, so manual driving is validated by a human before full 3D; measure input latency |
| 3 | Safety controller + independent monitor (tests first), then BASIC preemption with clearance and recovery |
| 4 | Full WebSocket protocol v1: `/api/network`, versioned messages, command acks, subscriptions for all per-step reads |
| 5 | 3D scene with placeholders: roads from the network, vehicles, per-approach signal heads, hospital, chase camera; asset manifest + fallback; `coords.ts` |
| 6 | Shortest-path routing with live costs + route overlay + ETA |
| 7 | COORD: queue-aware preemption lead time + downstream junction preparation |
| 8 | Accident injection + automatic reroute + "route compromised" |
| 9 | Experiment runner (paired seeds, arms, demand sweep) + charts + **ghost comparison run** |
| 10 | CI, README, demo script hardening; Docker if time |

Floating: the `/assets` debug page and `check:assets` are built when the first real `.glb` arrives.

Post-v1 (do not start early): traffic prediction, RL, OSM real-city import, multi-emergency-vehicle coordination, trucks/buses with protected turn phases.

## 14. Evaluation and metrics

Run seeded batch headless simulations comparing arms, typically on a 4x4 grid; the 2x2 grid has too few alternative routes to show routing effects.

- **Arms:** signals {OFF, BASIC, COORD} × routing {static, dynamic}. OFF is run in two variants:
  - `off_strict`: the ambulance obeys red lights.
  - `off_realistic`: the ambulance crosses reds cautiously, modeled with SUMO's emergency-vehicle behavior (verify in Sprint 2).
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
- Don't commit large binaries outside Git LFS, or unlicensed assets.

## 17. Definition of done (per feature)

- Works in all three modes (or is explicitly mode-specific)
- Unit tests pass; safety tests cover any signal-affecting change
- No direct TraCI calls outside `simulation/`
- Message schema updated on both sides
- README/CLAUDE.md updated if behavior or commands changed
- Verified in the browser at 30+ FPS with the demo scenario running (from Sprint 2)
