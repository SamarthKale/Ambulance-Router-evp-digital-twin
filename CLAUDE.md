# CLAUDE.md — EmergencyFlow AI

Predictive emergency-vehicle priority network: a digital twin of an urban road network where an ambulance is driven through a live 3D city while signals are preempted and the route is optimized.

This file is the source of truth for how to work in this repo. Read it fully before making changes.

---

## 1. Project status and scope

- **Target:** startup-grade prototype (clean, tested, containerizable, demo-ready).
- **Dev OS:** Windows (native SUMO install, no WSL required).
- **AI scope for v1: rules + A* routing ONLY.**
  - Do NOT add PyTorch, scikit-learn, Stable-Baselines3, or any ML/RL code in v1.
  - Traffic prediction (LSTM/GRU/XGBoost) and RL are post-v1 and must not be scaffolded early.
- **Out of scope for v1:** CARLA, Eclipse MOSAIC, SUMO+CARLA co-simulation, multi-city support, real hardware/IoT integration.

## 2. Core architecture (non-negotiable)

```
SUMO  <--TraCI-->  Python engine (FastAPI)  <--WebSocket-->  React + R3F + Three.js
 truth              decisions + safety                         presentation only
```

1. **SUMO is the single source of truth.** Vehicle positions, speeds, signal states and queues come from SUMO. The 3D frontend never simulates traffic.
2. **The frontend only renders and sends intent.** It sends commands (spawn, drive input, start emergency, inject accident, toggle mode). The backend decides what actually happens.
3. **AI proposes, the safety controller disposes.** Every signal/route action goes through `backend/safety/controller.py` before reaching TraCI. No code path may call a TraCI signal-setting function directly except through the safety controller.
4. **Never claim realistic vehicle physics.** SUMO is a traffic simulator, not a driving-physics engine. User "driving" is interactive control of a simulated vehicle (lane/route/speed intent).
5. **Three signal modes, always comparable:** `OFF` (normal signals), `BASIC` (rule-based preemption), `AI` (A* routing + downstream preparation). Every feature must work across modes so experiments stay fair.
6. **Control mode: MANUAL (v1 default).** The user drives the ambulance with the keyboard (W/S speed, A/D turn choice at the next junction, Q/E lane change). The AI only controls signals and gives **advisory** routing: A* draws the suggested route and ETA as an overlay and flags "route compromised" on incidents, but never steers the ambulance. Batch experiments (section 14) use an autopilot that follows the A* route so runs are reproducible. A/D are turn intents, not continuous steering.
   - Implementation: `backend/simulation/manual_control.py` and `frontend/src/simulation/useManualDrive.ts`.
   - Backend step order: `manual.step(dt)` then `traci.simulationStep()` then broadcast state.
   - Safety: speed mode stays at 31 (red lights and right-of-way respected), speed capped at 22 m/s, and a deadman timer zeroes input if drive messages stop for 0.5 s.

## 3. Tech stack

| Layer | Tech |
|---|---|
| Simulation | Eclipse SUMO 1.27.x, TraCI, `sumolib` |
| Backend | Python 3.11+, FastAPI, Uvicorn, WebSockets |
| Routing | SUMO `traci.simulation.findRoute` or `networkx` A* |
| Frontend | React, TypeScript, Vite, Three.js, React Three Fiber, `@react-three/drei`, Zustand |
| 3D assets | `.glb` files in `frontend/public/models/` (Blender only for authoring, never at runtime) |
| Data / eval | pandas, matplotlib |
| Testing | pytest (backend), Vitest (frontend) |
| Packaging | Docker + Docker Compose (later), GitHub Actions CI |
| Storage | SQLite for run logs in v1; PostgreSQL later |

## 4. Repository structure

```
emergencyflow/
├── CLAUDE.md
├── README.md
├── ATTRIBUTIONS.md              # license/credit for every 3D asset
├── docker-compose.yml           # later
├── frontend/
│   ├── src/
│   │   ├── components/          # City3D, Ambulance, TrafficLight, Vehicle, Hospital
│   │   ├── simulation/          # websocket.ts, state.ts (Zustand store)
│   │   ├── dashboard/           # HUD, telemetry, controls
│   │   └── app/
│   └── public/models/           # *.glb
├── backend/
│   ├── api/                     # routes.py, websocket.py
│   ├── simulation/              # sumo.py, vehicle.py, traffic_lights.py, network.py
│   ├── ai/                      # routing.py (A*), rules.py, signal_optimizer.py, rerouting.py
│   ├── safety/                  # controller.py
│   ├── tests/
│   └── main.py
├── simulation/                  # SUMO files
│   ├── network.net.xml
│   ├── routes.rou.xml
│   ├── signals.add.xml
│   └── simulation.sumocfg
└── experiments/
    ├── baseline/
    ├── basic_evp/
    └── ai_evp/
```

Keep `prediction.py` out of the repo until post-v1.

## 5. Setup and commands (Windows)

### Prerequisites
- SUMO (Windows installer), with `SUMO_HOME` set (e.g. `C:\Program Files (x86)\Eclipse\Sumo`) and `%SUMO_HOME%\bin` on `PATH`
- Python 3.11+, Node.js LTS, Git

### Backend
```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install fastapi uvicorn websockets traci sumolib networkx pandas matplotlib pytest
uvicorn main:app --reload --port 8000
```

### Frontend
```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173
```

### SUMO sanity checks
```powershell
sumo --version
sumo-gui -c simulation\simulation.sumocfg    # debug only, not the product UI
```

### Tests
```powershell
cd backend; pytest -q
cd frontend; npm run test
```

## 6. SUMO / TraCI conventions

- Start SUMO headless (`sumo`, not `sumo-gui`) from the backend; `sumo-gui` is for debugging only.
- Fixed step length (default `0.1` s); the backend steps the simulation and broadcasts state at a fixed rate (target 10-20 Hz).
- The ambulance is a vehicle with `vClass="emergency"` and a dedicated vType (`ambulance`).
- Use `traci.simulation.findRoute(fromEdge, toEdge)` (or `networkx` A* on the `sumolib` network) for routing. Re-evaluate on a timer or on incident events, not every step.
- Always close TraCI cleanly on shutdown; never leave orphan `sumo` processes.
- Wrap TraCI calls in the `simulation/` layer. API handlers and AI modules never import `traci` directly.

## 7. Signal preemption rules (BASIC mode)

1. Detect the ambulance's approach edge/lane to the next junction and its ETA to that junction.
2. If ETA is under the preempt threshold, request the phase that gives the approach green and all conflicting approaches red.
3. Respect yellow and all-red **clearance** before switching. Never jump straight from green on one approach to green on a conflicting one.
4. After the ambulance clears the junction, return to the normal program via a defined recovery transition.
5. All requests go through the safety controller.

AI mode adds **downstream preparation** (pre-clearing queues at the next 2-3 junctions on the route) using rules over ETA and queue length, not learned models.

## 8. Safety controller requirements

`backend/safety/controller.py` must validate, and be unit-tested for:
- Valid phase transitions only (no conflicting greens)
- Minimum yellow and all-red clearance times honored
- Emergency authorization (only a vehicle flagged emergency may trigger preemption)
- Maximum preemption duration (fail back to normal program on timeout)
- Controller health: if the engine or AI errors, fall back to the normal signal program
- Every accept/reject logged with reason

Never bypass or weaken these checks to make a demo work. Never describe the system as controlling real traffic signals.

## 9. WebSocket protocol

Backend → frontend (state tick):
```json
{
  "t": 123.4,
  "mode": "AI",
  "vehicles": [{"id": "ambulance_01", "type": "ambulance", "x": 421.4, "y": 193.2, "angle": 90, "speed": 16.8}],
  "signals": [{"id": "J12", "state": "GREEN", "preempted": true}],
  "route": {"vehicle": "ambulance_01", "edges": ["e1", "e5", "e9"]},
  "metrics": {"eta": 261, "signalsPreempted": 3, "queueCleared": 41, "timeSaved": 134},
  "incidents": []
}
```

Frontend → backend (commands):
```json
{"cmd": "spawn_ambulance"}
{"cmd": "set_mode", "mode": "OFF|BASIC|AI"}
{"cmd": "drive", "vehicle": "ambulance_01", "control": {"throttle": 1, "brake": 0}}   // sent on change + 10 Hz heartbeat
{"cmd": "turn", "vehicle": "ambulance_01", "direction": "left|right"}                  // intent for the next junction
{"cmd": "lane", "vehicle": "ambulance_01", "direction": "left|right"}
{"cmd": "inject_incident", "type": "accident", "edge": "e7"}
{"cmd": "reset"}
```

Version the message schema. Any change must update both `state.ts` types and the backend models in the same commit.

## 10. Coordinate and orientation mapping

- SUMO: x east, y north, angle in degrees clockwise from north.
- Three.js: x east, y up, z south (so `z = -y_sumo`).
- Rotation: convert SUMO angle to `rotation.y` in radians with the sign and offset verified against the model's forward axis. Put this conversion in **one** utility function (`frontend/src/simulation/coords.ts`) and unit-test it. Do not inline it in components.
- Interpolate between ticks on the client for smooth motion; never extrapolate beyond one tick.

## 11. 3D asset rules

- Format: `.glb`, one file per model, textures embedded.
- Real-world scale in meters (car ~4.5 m, ambulance ~6 m, bus ~12 m).
- Forward = +Z, pivot at center-bottom.
- Budget: under ~5k triangles per vehicle, ~20k per building.
- Traffic light lamps are **separate named meshes**: `lamp_red`, `lamp_yellow`, `lamp_green`.
- Ambulance has a named `siren` mesh; wheels named `wheel_*` if separate.
- Load via `useGLTF`; use instancing for traffic cars once vehicle count grows.
- Roads, junctions, lane markings and route overlays are **generated in code** from the SUMO network, not modeled.
- Every asset needs a commercial-use license (CC0 or CC-BY) recorded in `ATTRIBUTIONS.md`.
- Missing assets get box placeholders; never block progress on art.

## 12. Code conventions

- **Python:** type hints everywhere, `ruff` + `black`, small modules, no global mutable state outside the simulation manager.
- **TypeScript:** `strict` mode, no `any`, state in Zustand, components stay presentational.
- Prefer iterative changes to the existing code over full rewrites.
- Commit messages: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- One sprint item per branch; keep PRs small and reviewable.
- Secrets and local paths go in `.env` (git-ignored); commit a `.env.example`.

## 13. Roadmap (v1)

| Sprint | Deliverable |
|---|---|
| 1 | SUMO world: 4 intersections, traffic, signals, no AI |
| 2 | Ambulance vehicle: position, speed, heading, next junction, plus manual WASD control (speed, turns, lanes) |
| 3 | BASIC signal preemption with clearance and recovery |
| 4 | FastAPI + WebSocket streaming of SUMO state |
| 5 | 3D scene: roads, cars, ambulance, signals, buildings, hospital, chase camera |
| 6 | A* dynamic routing + route overlay in 3D |
| 7 | Rule-based downstream junction preparation |
| 8 | Incident injection (accident, road closure) + automatic reroute |
| 9 | Experiment runner + metrics comparison (OFF vs BASIC vs AI) |
| 10 | Dockerize, CI, README, demo script |

Post-v1 (do not start early): traffic prediction, RL, OSM real-city import, multi-emergency-vehicle coordination.

## 14. Evaluation and metrics

Run batch headless simulations (100+ runs, seeded) comparing OFF / BASIC / AI.

- **Primary:** ambulance travel time
- **Secondary:** ambulance waiting time, red-light stops, average queue length, time to clear a junction, background-traffic delay, route changes, preemption count, safety-rule violations (must be 0)

Outputs go to `experiments/<mode>/` as CSV, plus matplotlib charts. Always seed runs and record the seed so results are reproducible.

## 15. Demo script

1. Heavy traffic, ambulance parked, mode OFF.
2. Press **Start Emergency**: show normal-signal delay.
3. Switch to BASIC: signal turns green on approach with clearance.
4. Switch to AI: downstream junctions prepare; route overlay shown.
5. Press **Create Accident**: route recalculates, new ETA shown.
6. Show the comparison chart (OFF vs BASIC vs AI).

## 16. Do / Don't

**Do**
- Build one junction first, then scale.
- Keep SUMO authoritative and the frontend dumb.
- Test the safety controller before any AI logic.
- Measure everything; no claims without numbers.

**Don't**
- Don't add ML/RL in v1.
- Don't start with CARLA or MOSAIC.
- Don't let the AI or frontend touch signals directly.
- Don't claim novelty from "ambulance turns the signal green"; the contribution is the integrated closed-loop twin, rerouting and measurable evaluation.
- Don't use SUMO-GUI as the final UI.
- Don't commit large binaries or unlicensed assets.

## 17. Definition of done (per feature)

- Works in all three modes (or is explicitly mode-specific)
- Unit tests pass; safety tests cover any signal-affecting change
- No direct TraCI calls outside `simulation/`
- Message schema updated on both sides
- README/CLAUDE.md updated if behavior or commands changed
- Verified in the browser at 30+ FPS with the demo scenario running
