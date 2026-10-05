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
- **Out of scope for v1:** CARLA, Eclipse MOSAIC, SUMO+CARLA co-simulation, multi-city support, real hardware/IoT integration, SQLite/PostgreSQL, road-closure incidents (accidents only), Docker, CI/CD.
- **Platform:** local, native Windows only (decided 2026-10-05). No Docker, no CI/CD pipelines. Tests, lint and the asset check run locally (section 5).

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
6. **Control mode: MANUAL (v1 default).** The user drives the ambulance with the keyboard (W/S speed, A/D turn choice at the next junction, Q/E lane change). A/D are turn intents, not continuous steering.
   - **Routing is advisory in every mode** (Sprint 6). The suggested route, the ETA and the next turn are drawn as an overlay and in the HUD. When the driver's plan differs from the suggestion, the HUD says which key to press. "Route compromised" is flagged on incidents. Routing never steers a manual drive.
   - **Signals:** COORD only adds signal coordination (section 7).
   - **Autopilot:** batch experiments (section 14) use an autopilot (`SimulationEngine(control="autopilot")`, never the live server) that follows the suggested route so runs are reproducible. Every route change it makes is reviewed by the safety controller first (`review_reroute`).
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
     2. autopilot (batch only): full throttle, and the suggested road at the next junction once `controller.review_reroute()` accepts the route
     3. `manual.step(dt)`
     4. `controller.step()` → `traffic_lights.apply()`
     5. `simulationStep()`
     6. `manual.observe(...)`
     7. `monitor.observe(...)`
     8. BASIC rule → `controller.request_*()`
     9. route: re-planned every 1 s and whenever the ambulance reaches a new road
     10. publish state
   - Safety: speed mode stays at 31 (red lights and right of way respected; tested), speed is capped at 22 m/s (tested), and a deadman timer zeroes input if drive messages stop for 0.5 s (tested with an injected clock).
7. **Single TraCI owner.** One simulation thread (`backend/simulation/engine.py`) owns the TraCI connection, because TraCI is not thread-safe.
   - WebSocket handlers only `submit()` commands, which return a future. The engine thread applies them before each step and publishes an immutable `EngineState`. The event loop serializes it once and fans it out.
   - Each client gets every ack but only the newest tick, so a slow client skips frames instead of lagging. A (re)connecting client is sent the latest state immediately.
8. **Driver lock** (`backend/api/session.py`, API layer, not the engine). The first client that dispatches drives; every other client is an observer.
   - Observers receive all state but cannot drive, turn, change lanes, switch mode or reset (ack: "observer: another screen is driving"). Their drive heartbeats are dropped silently.
   - With no driver, anyone may switch mode or reset.
   - Control is freed by `release_control` from the driver, by a reset, or when the driver's connection stays gone for **10 s**.
   - Each browser tab sends `hello` with a per-tab id (`sessionStorage`), so a tab that reconnects within those 10 s keeps control.
   - The lock is in memory: a backend restart frees it.
   - If SUMO crashes, the engine records the error (`/api/health`) and restarts SUMO after 1 s (tested).

## 3. Tech stack

| Layer | Tech |
|---|---|
| Simulation | Eclipse SUMO 1.27.1 (native Windows install), TraCI, `sumolib` (pip, pinned 1.27.1) |
| Backend | Python 3.13 (3.11+), FastAPI, Uvicorn, WebSockets |
| Routing | SUMO `traci.simulation.findRoute` or `networkx` shortest path with live edge costs |
| Frontend | React, TypeScript, Vite, Three.js, React Three Fiber, `@react-three/drei`, Zustand |
| 3D assets | The team's deliveries in `3d_models/` (Git LFS), served unmodified at `/models/` by a Vite plugin; `@gltf-transform` for `check:assets` (Blender only for authoring, never at runtime) |
| Data / eval | pandas, matplotlib |
| Testing | pytest (backend), Vitest (frontend) |
| Packaging | Local native Windows: a PowerShell launcher script (Sprint 10). No Docker, no CI/CD |
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
│   │   ├── components/            # CityScene (root), City3D (ground, roads, props), cityLayout.ts
│   │   │                          # (pure layout from the network), Asset (instancing), Vehicles,
│   │   │                          # TrafficLights, Ambulance, CameraRig, Sky, lod.ts, geometry, Label,
│   │   │                          # RouteOverlay + routePath.ts (suggested route), vehicleStyles;
│   │   │                          # fixtures/ (network JSON, generated by gen_contract)
│   │   ├── simulation/            # websocket.ts, state.ts (protocol types + Zustand), coords.ts,
│   │   │                          # poses.ts (per-frame interpolation), useManualDrive.ts (+ *.test.ts)
│   │   ├── assets/                # manifest.ts, prepare.ts (bake + merge), loader.ts, names.ts,
│   │   │                          # exr.ts + exrWorker.ts (skybox), AssetsPage.tsx (dev-only /assets)
│   │   ├── dashboard/             # Hud.tsx, layout.ts (panel widths shared with the camera)
│   │   └── app/                   # App.tsx, app.css
│   └── scripts/                   # deliveredModels.ts (Vite plugin: /models/ -> 3d_models/),
│                                  # check-assets.ts (npm run check:assets) (+ *.test.ts)
├── backend/
│   ├── requirements.txt           # pinned
│   ├── pyproject.toml             # pytest, ruff, black config
│   ├── api/                       # protocol.py (v1 models), routes.py, websocket.py
│   ├── simulation/                # sumo.py, engine.py, manual_control.py, vehicle.py, network.py,
│   │                              # traffic_lights.py (the only signal actuator + net.xml tables)
│   ├── ai/                        # rules.py (BASIC), routing.py (live-cost routing); later COORD rules
│   ├── safety/                    # controller.py, monitor.py, invariants.py (R1-R3), signal_table.py
│   ├── scripts/                   # smoke_compare.py (OFF vs BASIC, one seed), benchmark.py,
│   │                              # gen_contract.py (-> frontend contract.fixtures.ts),
│   │                              # eta_check.py (routing ETA vs measured, seeded autopilot)
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
.venv\Scripts\python.exe -m scripts.benchmark                              # tick time + message size, 2x2/4x4 x 1.0/1.5
.venv\Scripts\python.exe -m scripts.eta_check                              # routing ETA vs measured, seeded autopilot (4x4)
.venv\Scripts\python.exe -m scripts.gen_contract                           # after ANY change to api/protocol.py or a scenario
.venv\Scripts\python.exe ..\scenarios\build_grid.py                        # regenerate scenarios\grid2x2
.venv\Scripts\python.exe ..\scenarios\build_grid.py --nx 4 --ny 4          # evaluation grid
```
Call `.venv\Scripts\python.exe` directly instead of activating (avoids the PowerShell execution policy). The backend reads `EF_SCENARIO`, `EF_SEED`, `EF_SCALE` and `EF_WARMUP_S` from `.env`.

**Run demos on AC power** with Edge/Chrome on the high-performance GPU, the RTX 4060 (Windows Settings → Display → Graphics → Edge → High performance). Edge otherwise picks the Intel UHD, even when plugged in. On battery (Balanced plan), this laptop measured SUMO about 4x slower (see section 6). Browser numbers are in section 11. Scripted browser checks force the NVIDIA GPU with Edge's `--force_high_performance_gpu` flag.

### Frontend
```powershell
cd frontend
npm install
npm run dev            # open http://localhost:5173 (Vite listens on localhost/::1; it proxies /api and /ws to 127.0.0.1:8000)
                       # http://localhost:5173/assets: dev-only asset inspection page
npm run build          # typecheck + production build (copies 3d_models/ byte for byte into dist/models/)
npm run check:assets   # read-only model report + manifest vs workbook; -- --strict also fails on warnings
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
  - The ambulance's next signal, stop state and lane position: one vehicle subscription, renewed on every spawn. The only per-tick ambulance call left is the `setSpeed` write.
- **Warm-up:** the live server fast-forwards `EF_WARMUP_S` (default 120 s) of simulated time on start and after Reset, so the demo opens with traffic flowing. Experiments and tests use 0.
- **Performance (Sprint 4, `scripts/benchmark.py`; BASIC mode with the ambulance driving).** `/api/health` reports live tick p50/p95/max.

  | Scenario and demand | Vehicles | Tick p50/p95, plugged in | Tick p50, on battery | State message raw → deflated |
  |---|---|---|---|---|
  | 2x2 at 1.0x | ~80 | 1.9 / 3.2 ms | 5.4 ms | 10 → 1.9 KB |
  | 4x4 at 1.5x | ~480 | 7.8 / 11.4 ms | ~30 ms (p95 50 ms with the browser running) | 54 → 8 KB |

  - The budget is 100 ms (10 Hz). SUMO's own step is about 98% of the tick and JSON serialisation adds 1.3 ms, so the backend needs no optimisation.
  - The 4x4 grid at 1.5x runs 1 h with 0 teleports and 0 collisions.
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
  - The vType id is the 3D asset key. The frontend may draw a vType as one of its visual variants (`car_sedan` as a sedan, taxi or SUV at the same 4.5 m); SUMO's traffic is unchanged.
  - Cars only (`car_sedan` 70%, `car_hatchback` 30%). Trucks and buses on permissive turns caused SUMO junction collisions (1–11 per hour at 1.5x). They return only with protected turn phases plus a collision check.
- **sumocfg:** seed 42, `lanechange.duration` 1.5 s (smooth lateral motion, far fewer emergency braking events), `time-to-teleport` 300 (teleports flag a bad run), collision warnings with junction checks on. Baseline target: 0 collisions and 0 teleports (a slow test enforces this).
- **Ambulance:** a vehicle with `vClass="emergency"` and a dedicated vType (`ambulance`), see section 2.6. Depot and hospital come from the scenario's `scenario.json`: the depot is the start of `w0_A0` (west edge), and the hospital is 15 m before the end of `B1_e1` (east edge).
- **Routing** (Sprint 6, `ai/routing.py`, pure): a time-dependent Dijkstra over the road graph. Nodes are roads and arcs are junction movements; the graph is built from the net file by `RoadNetwork.road_graph()`. The cost function matters more than the algorithm. A route's cost is the predicted time to the hospital, summing:
  - **drive:** the ambulance's top speed, or the speed moving traffic allows (live mean speed of the moving vehicles × 1.6). On its own road only the queue counts, because cars there are as often behind it as ahead.
  - **acceleration:** a standing start costs the time to reach top speed.
  - **queue:** halted vehicles / lanes × 2 s headway.
  - **signal:** the wait depends on the mode:
    - OFF: the wait until the ambulance's own link turns green, predicted from the fixed-time program.
    - BASIC: what 9 s of preempted green can't discharge.
    - COORD: 0.
  - **turns:** a few seconds per turn.
  - **incidents:** a penalty, or a closed road.

  Prediction horizon: live queues and exact signal timing are used only for the next 30 s. Beyond that, the expected values take over (half the current queue, the program's average red wait); exact far-ahead predictions made routes chase greens that were gone on arrival. Live inputs come from TraCI subscriptions: one per road (mean speed, halting, vehicles) and each signal's next switch time. The route is re-planned every 1 s and on every new road, never every step. A new suggestion replaces the current one only if it is at least max(5 s, 10 %) faster, so the advice doesn't flip. Static routing (experiment arm) keeps the free-flow plan made at dispatch.
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
- **Autopilot reroutes** (Sprint 6): `review_reroute` accepts a route only if:
  - the vehicle is an emergency vehicle
  - the route starts on the road it is on
  - every step is a real movement
  - it avoids closed roads
  - it ends at the destination

  Each decision is logged (`reroute`), once per change.
- **Fail-safe:** if the decision logic throws, the engine recovers every junction (`fail_safe`, with clearance) and switches to OFF.
- **Independent safety monitor** (`backend/safety/monitor.py`): reads the actual signal state from SUMO every step and applies R1–R3. "Safety violations = 0" is reported from the monitor plus SUMO's collision count, never from the controller's own logs. The normal program itself passes the monitor (tested over 3 cycles).
  - It also watches the warm-up fast-forward. Started after it, mid-cycle, the monitor didn't know how long a link had been red, and flagged the next normal green as an R3 breach.
  - That false positive appeared in Sprint 6's seeded runs (0 collisions; identical counts in OFF and BASIC). It is fixed, with a regression test that fails without the fix.

Never bypass or weaken these checks to make a demo work. Never describe the system as controlling real traffic signals.

## 9. WebSocket protocol (v1)

Every message carries `"v": 1`. The source of truth is `backend/api/protocol.py` (pydantic, camelCase JSON) mirrored by `frontend/src/simulation/state.ts`. Any change must update both in the same commit; a breaking change bumps the version. Fields marked "(Sprint N)" are sent as `null`/`0`/`[]` until that sprint.

**Contract test (Sprint 4).**
- `backend/scripts/gen_contract.py` serialises example messages through the pydantic models into `frontend/src/simulation/contract.fixtures.ts`. Each fixture `satisfies` its `state.ts` type, alongside the exact lists of command names, server message types and enum values.
- When the two sides drift, tsc fails on a missing, extra or mistyped field or on a one-sided enum value or command, and `tests/test_contract.py` fails on stale fixtures. All three kinds of drift were verified to fail.
- After changing `protocol.py`: run `scripts.gen_contract`, then fix `state.ts` until `npm run typecheck` passes.

Static network, fetched once via `GET /api/network` (and again on every reconnect: a restarted backend may run another scenario). The frontend generates roads, signal lamps and markers from it. Coordinates are SUMO metres. `GET /api/health` returns `{status: starting|running|error, error, seq, t, vehicles, tickMsP50, tickMsP95, tickMsMax, sumoStepMsP50}`.
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
  "route": {"edges": ["A0_B0", "B0_B1", "B1_e1"],
            "turns": [{"junction": "B0", "turn": "left", "edge": "B0_B1"}, {"junction": "B1", "turn": "right", "edge": "B1_e1"}],
            "eta": 31.4, "distance": 512.0, "follows": true, "routing": "dynamic", "computedAt": 123.0,
            "drive": 27.9, "queue": 3.5, "signal": 0.0},
  "metrics": {"eta": 31.4, "signalsPreempted": 2, "queueCleared": null, "timeSaved": null},
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
- **`route`:** the suggested route (null without a driving ambulance).
  - `edges` start at the ambulance's road, or at the road after the junction it is in.
  - `turns` are the junctions ahead.
  - `eta` is in seconds and counts down between re-plans; `distance` is the metres remaining along the route.
  - `follows` says whether the road the ambulance takes next is the suggested one.
  - `drive`/`queue`/`signal` split the planned ETA.
  - `metrics.eta` repeats `route.eta`.
- **`events` actions:** besides the ones above, `reroute` (autopilot only).
- **`metrics`:** `signalsPreempted` counts preemptions that reached green. `timeSaved` stays `null` unless it was measured against the ghost run (section 14).
- **`mode`:** `OFF` or `BASIC`. `COORD` is rejected until Sprint 7.

Frontend → backend (commands). Every command except `drive` and `hello` carries an `id` and gets an ack once it has run. Driving commands, `set_mode` and `reset` are subject to the driver lock (section 2.8):
```json
{"v": 1, "cmd": "hello", "clientId": "tab-<uuid>"}                                           // first on every (re)connect; reply: session
{"v": 1, "id": 7, "cmd": "release_control"}                                                  // driver hands over control
{"v": 1, "id": 1, "cmd": "spawn_ambulance"}                                                  // dispatch (respawns if on the road); claims control
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
{"v": 1, "type": "session", "clientId": "tab-<uuid>", "role": "driver|observer|free"}       // on connect, hello and every driver change
```
Replies:
- **Invalid commands with an `id`:** get `ok: false` with a reason.
- **Unreadable messages:** get an `error`.
- **Accepted commands:** `ok: true` may still carry an informative reason ("left turn queued for B0", "waiting for a gap in the curb lane").
- **Ack timeouts:** a command that hasn't run within 2 s is acked `ok: false`, "simulation not responding". `reset` waits up to 120 s, because it restarts SUMO and fast-forwards the warm-up (about 10 s on the 4x4 at 1.5x).

## 10. Coordinate and orientation mapping

- SUMO: x east, y north, angle in degrees clockwise from north.
- Three.js: x east, y up, z south. Recenter on the network center: `world = (x - cx, 0, -(y - cy))`.
- Rotation for glTF models facing +Z: `rotation.y = π − angle·π/180` (north → π, east → π/2, south → 0, west → −π/2). This conversion lives in **one** utility (`frontend/src/simulation/coords.ts`, unit-tested for every 15° heading). Do not inline it in components.
- Flat generated geometry must face up (+Y), or three.js culls it when seen from above. `geometry.test.ts` checks the face normals.
- Map labels are canvas-texture sprites (`components/Label.tsx`) with a constant on-screen size in the orthographic map and the perspective views. Don't use drei `<Html>` (an extra React root per label, which errors under StrictMode) or drei `<Text>` (it fetches a font from a CDN).
- Interpolate between ticks on the client (positions linearly, angles along the shortest arc). Never extrapolate beyond one tick. Interpolation adds one tick (100 ms) of display latency; give instant HUD feedback on keydown instead of predicting motion.
- Per-asset rotation and pivot offsets come from the asset manifest, never from `coords.ts`. `assets/prepare.ts` bakes them into the model's geometry at load. That is equivalent to a child group, and it lets one `InstancedMesh` draw every copy.
- The interpolated poses are computed once per frame (`simulation/poses.ts`). Frame order (`useFrame` priorities, all negative so R3F keeps rendering automatically):
  1. poses
  2. camera rig
  3. orbit controls
  4. frustum for culling
  5. the renderers

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
- Missing assets get placeholders. Never block progress on art. The manifest's `placeholder` (box, cylinder or cone at the fitted size) is drawn until a model loads, and whenever it fails.

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
  3. Add or enable its manifest entry, calibrate it on `/assets` and run `npm run check:assets`.
  4. Validate the GLB: triangles, real-world size, named parts, texture weight.
  5. Record source, credit and validation notes in `ATTRIBUTIONS.md`.
  6. The placeholder swaps automatically. Simulation logic never changes.
- Mappings confirmed by the team:
  - `member-4/model.glb` (internal name "bazaar-street-and-shrine") is Member 4's **Shops / commercial row**.
  - `member-2/street-tile-c7e3cf.glb` is Member 2's **Stop line / zebra crossing**. It is a plain 8 x 8 m asphalt tile with no stripes, so:
    - stop lines and zebras are generated in code, as the workbook allows
    - the tile paves the depot apron and the hospital ambulance bay
- Sprint 3 validation of the Member 1 and Member 4 deliveries (details in `ATTRIBUTIONS.md`), used as-is:
  - All 22 files are valid GLBs.
  - Almost none is in metres, so the manifest's auto-fit (`fit`) is required.
  - The ambulance has no `siren` or wheel parts, so it uses the fallback.
  - Above the triangle guideline: `model.glb` (92k triangles, 859 nodes), `auto_rickshaw` and Truck (vehicles above 5k).
  - `standard_bus_stop.glb` is 23.7 MB, almost all textures. Load it lazily (after the scene is interactive) so it doesn't delay the first frame.

**Asset pipeline (Sprint 5).**
- **Serving:** `frontend/scripts/deliveredModels.ts` serves `3d_models/` at `/models/<folder>/<file>`.
  - Dev and preview stream from disk, with ETag revalidation.
  - A build copies the folder byte for byte into `dist/models/`. Names, including spaces, stay as delivered.
  - The workbook is not served.
  - `frontend/public/models/` is no longer used.
- **Manifest** (`frontend/src/assets/manifest.ts`): 42 entries. Each asset key maps to:
  - `file`, `enabled`, and the workbook's `owner`, `workbook` row and `priority`
  - `rotationY?`: applied first, so `fit` measures in the corrected frame
  - `fit?: {axis, meters}`, `scale?`, `pivot: "bottom-center" | "none"`, `offset?`
  - `placeholder: {size, color, shape}`: the expected fitted size; the city layout plans with it
  - `requiredParts?`, `optionalParts?`, `aliases?`
  - `tintMaterials?`: per-vehicle paint
  - `hide?`
  - `triBudget`: advisory
  - `lazy?`
  - `alphaCutout?`: foliage drawn opaque with alphaTest, on a runtime copy of the material

  The SUMO vType id equals the asset key. `VEHICLE_VARIANTS` lets the `car_sedan` vType show as a sedan, taxi or SUV, picked by a hash of the vehicle id. This is purely visual: SUMO's vehicle is the same 4.5 m car either way.
- **Loading** (`assets/loader.ts`, `assets/prepare.ts`):
  - **Placeholder first:** every hook returns the placeholder first, so the app runs with no model at all. `enabled: false` never fetches.
  - **Failures:** a 404 or parse error logs one warning and keeps the placeholder.
  - **Missing driven parts:** they log one warning and get generated stand-ins. The ambulance has no `siren`, so it gets a red/blue light bar on the roof plus a flashing glow.
  - **Baking:** each model is baked once: node transforms, rotationY, fit, pivot and offset go into the geometry. Quantized attributes become float32, and mirrored nodes keep outward faces.
  - **Merging:** meshes are merged to cut draw calls:
    - plain-coloured opaque materials become one vertex-coloured mesh per face side
    - textured, transparent or emissive materials merge per material
    - driven parts and tinted paint stay separate

    Measured: `model.glb` 688 meshes → 4 draws, the gas station 361 → 1, the fire truck 122 → 2.
- **Name matching** (`assets/names.ts`) is case-insensitive and ignores punctuation and `.001`. `aliases` map odd names, e.g. Member 3's `Red_Light` → `lamp_red`.
- **No decoders needed:** no delivered file uses Draco or Meshopt (`check:assets` errors if one ever does). `model.glb`'s `KHR_mesh_quantization` and `EXT_texture_webp` are built into the loader. If a decoder is ever needed, self-host it in `public/`, never from a CDN.
- **Rendering:**
  - **Instancing:** every copy of a model is instanced: one `InstancedMesh` per part sharing one matrix buffer (`components/Asset.tsx`). This covers buildings, trees, street furniture, signal heads with per-copy lamp colours, and traffic with per-copy paint.
  - **Culling and LOD** (`components/lod.ts`): copies are culled against the frustum on the CPU every 2 frames, then drawn by projected size:
    - big enough: the model
    - smaller: the placeholder (a cone for a tree, a box for a car or building)
    - smaller still: nothing (small furniture)
  - **Ground:** ground layers are unlit (pre-lit colours), don't overlap (a frame around the map, pavement bands, lots), and are drawn in a fixed order without depth writes, so they never z-fight.
- **Skybox** (Member 2's 72 MB EXR):
  - It is fetched and decoded in a Web Worker 1.5 s after the scene is interactive.
  - It is shown at 2048x1024: a box-filtered display copy, never a file edit.
  - Until then the sky is a plain colour and a generated room environment lights the models. That environment uses the same PMREM cube size as the skybox's (512), because a size change recompiles every material.
  - Main-thread stall when the sky goes in: 0.19 s. It was 2.1 s with mismatched sizes, and 0.47 s at full 4k.
- **Lazy files:** the bus stop is fetched after the scene is interactive. The crashed car is used from Sprint 8 and fetched only when shown (`/assets` has a button).
- **Placed in the city** (`components/cityLayout.ts`, deterministic, tested on the real 2x2 and 4x4 networks): nothing overlaps a road or another building, every signalised approach has one head, and zebras lie inside the junction box.
  - **Building rows:** they line every block, using the generic buildings (`building_01..05`) and Member 1's residential block.
  - **Depot road:** the shops (bazaar), with an auto-rickshaw stand and scooters. The petrol station sits across the road, with fuel pumps, a truck and a stop sign.
  - **Depot:** a fire truck and the street-tile apron.
  - **Bus stop:** on the next road.
  - **Hospital:** by its stop, with a forecourt holding the ambulance bay (street tile), a path-tile walkway, a police car, benches and no-parking signs, plus a red-cross sign.
  - **Parks:** footpaths, trees, grass and benches.
  - **Along every road:** trees, streetlights, hydrants and bins.
  - **At each junction mouth:** a raised median with the delivered divider segments, generated stop lines, zebras and lane markings, and a pedestrian signal per crossing.
  - **Not placed in Sprint 5:** cones, barricade, road block, explosion marker and crashed car are incident props for Sprint 8. The flyover isn't placed because the grid has none. All of them are on `/assets`.
- **Dev-only `/assets` page** (`http://localhost:5173/assets`): every manifest asset in one canvas (drei `<View>`). Each card shows:
  - the model with axes (+Z = forward, blue), a 1 m grid, a 5 m ruler and the bounding box
  - fitted size against the placeholder, triangles against the budget, draws per copy against the file's meshes, parts, load status and time, and node names
  - a "copy manifest entry" button

  Heavy files load on a button. The page is not in the production bundle.
- **`npm run check:assets`** (`scripts/check-assets.ts`, gltf-transform, run by Node directly). For every manifest file it reports:
  - triangles against the budget
  - size in the file and after rotation/fit, against the placeholder
  - the longest horizontal axis (forward sign unconfirmed)
  - driven parts
  - extensions and file size
  - the `ATTRIBUTIONS.md` row
  - Git LFS pointer files (`git lfs pull` not run)
  - files no entry uses

  It also reads the workbook itself and checks every row's owner and priority against the manifest. Errors exit 1; warnings exit 1 only with `--strict`. It currently reports 0 errors and 9 warnings: the triangle guideline on 8 models, and the ambulance's missing siren.
- **Measured** (Edge; 4x4 at 1.5x, ~540 vehicles, driving in BASIC; 1600x900):

  | View | RTX 4060 | Intel UHD (plugged in) |
  |---|---|---|
  | Chase | 144 FPS (display cap) | 60 median, 53 min |
  | Orbit | 144 | 63 / 61 |
  | Overview | 144 / 136 | 63 / 47 |
  | Map (2D) | 144 | 136 / 133 |

  - **2x2 at 1.5x on the Intel UHD:** chase 62/55.
  - **Draw calls:** at most 79 (Sprint 4: ~957). Triangles at most ~0.7 M.
  - **Load times:** first frame ~1.5-2 s, all models ~4.4-5.2 s, sky ~9-12 s.
  - **Start-up stalls:** while models load and shaders compile, frames stall up to ~1 s, before anyone can drive.
  - **Input to first response:** 45 ms median on the RTX 4060 and 70 ms on the Intel UHD (Sprint 2, 2D view: 28-57 ms).
  - **Not measured:** battery power; the laptop was plugged in all sprint.
- **Before Sprint 5** (Sprint 4 measurements, kept for comparison): one mesh per vehicle gave ~957 draw calls on the 4x4 at 1.5x, with dips to 21 FPS on the integrated GPU. The EXR took 16.4 s to load and decode on the main thread.

## 12. Code conventions

- **Python:**
  - Type hints everywhere, `ruff` + `black` (line length 100, config in `backend/pyproject.toml`), small modules, no global mutable state outside the simulation manager.
  - Format with black before committing.
- **TypeScript:** `strict` mode, no `any`, state in Zustand, components stay presentational.
- Prefer iterative changes to the existing code over full rewrites.
- Commit messages: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- **Git:** `main` holds approved work. Each sprint is built on `sprint-<n>/<name>` (e.g. `sprint-1/sumo-world`) and merged after approval. Keep PRs small and reviewable. Sprints 6–10 were approved to run back to back (2026-10-05): each one merges into `main` once its tests pass.
- Secrets and local paths go in `.env` (git-ignored). Commit `.env.example`.

## 13. Roadmap (v1)

| Sprint | Deliverable |
|---|---|
| 1 | SUMO world: 2x2 signalized grid (left-hand traffic), seeded background traffic, clean TraCI lifecycle, tests ✅ |
| 2 | Ambulance vType + manual WASD control (reference demos reworked) + FastAPI WebSocket + React Three Fiber top-down view; input latency measured ✅ |
| 3 | Safety controller + independent monitor (tests first), BASIC preemption with clearance and recovery, OFF/BASIC mode in protocol + UI, 24 h live traffic ✅ |
| 4 | Demo hardening: protocol contract test, driver lock, reconnect handling, ambulance subscription, 4x4 grid + performance benchmark, live warm-up ✅ |
| 5 | 3D scene with the delivered models: asset manifest (fit/pivot/aliases, placeholder fallback), instanced vehicles and lamps, merged multi-node buildings, lazy skybox, per-approach signal heads, hospital, chase camera, HUD placement, `/assets` page and `check:assets`; per-copy LOD; 60 FPS chase on the integrated GPU (4x4 at 1.5x) ✅ |
| 6 | Shortest-path routing with live costs + route overlay + ETA, advisory turn hints, batch autopilot through the safety controller, seeded ETA-vs-actual check ✅ |
| 7 | COORD: queue-aware preemption lead time + downstream junction preparation |
| 8 | Accident injection + automatic reroute + "route compromised" |
| 9 | Experiment runner (paired seeds, arms, demand sweep) + charts + **ghost comparison run** |
| 10 | README, demo script hardening, one-command local launcher, final verification (local native Windows; no Docker, no CI/CD) |

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
- **Routing ETA accuracy** (Sprint 6, `scripts/eta_check.py`): 4x4 at 1.0, seeds 1–10, autopilot, ETA predicted at dispatch vs measured.

  | Mode | Mean abs. error | MAPE | Bias |
  |---|---|---|---|
  | BASIC | 11 s | 10 % | −1 s |
  | OFF | 42 s | 25 % | +4 s |

  OFF stays noisy because each red light met is close to a lottery; the bias is what the horizon rule fixed (it was −35 s).
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

0. Setup:
   - Laptop on AC power, with Edge set to the RTX 4060 in Windows Graphics settings.
   - Backend started with `EF_SCALE=1.5`; traffic is already flowing thanks to the warm-up.
   - Open the page about 15 s early, so the models and the HDRI sky are in before anyone drives.
   - A second screen may open the page as an observer.
1. Heavy traffic (`--scale 1.5`), ambulance parked, mode OFF. The Chase view shows the city overview until dispatch; **C** cycles Chase / Orbit / Map.
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
