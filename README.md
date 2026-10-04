# EmergencyFlow AI

An open, reproducible **simulation testbed** for emergency-vehicle signal priority. An ambulance is driven through a live city (SUMO traffic simulation, 3D view in the browser). Traffic signals are preempted through a tested safety layer, and routes are suggested.

- v1 decision logic is **rule-based** (preemption rules + shortest-path routing). There is no machine learning in v1.
- This is a simulation. It does **not** control real traffic signals.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions and roadmap.

## Status

| Sprint | Deliverable | State |
|---|---|---|
| 1 | SUMO world: 2x2 signalized grid (left-hand traffic), seeded background traffic, clean TraCI lifecycle | done |
| 2 | Ambulance + manual WASD control + minimal WebSocket and top-down view | next |

## Prerequisites (Windows)

- **SUMO 1.27.1** (Windows installer), with `SUMO_HOME` set (e.g. `C:\Program Files (x86)\Eclipse\Sumo`) and `%SUMO_HOME%\bin` on `PATH`.
  Terminals and VS Code windows opened **before** SUMO was installed don't see these variables. Restart them, or use the `.env` file below.
- **Python 3.13** (3.11+ works), **Git** with **Git LFS**. Node.js LTS is needed from Sprint 2.

## Setup (PowerShell, from the repo root)

```powershell
git lfs install                                   # once per machine
py -3.13 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Copy-Item .env.example .env                       # local settings, git-ignored; edit SUMO_HOME if needed
```

The commands call `.venv\Scripts\python.exe` directly, so you don't need to activate the venv. That avoids PowerShell's script execution policy. In VS Code, pick `backend\.venv\Scripts\python.exe` as the interpreter so imports resolve.

## Run

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

## Tests and lint (from `backend\`)

```powershell
.venv\Scripts\python.exe -m pytest -q                  # ~20 s, includes a 1-hour heavy-traffic run
.venv\Scripts\python.exe -m pytest -q -m "not slow"    # ~6 s
.venv\Scripts\ruff.exe check --config pyproject.toml . ..\scenarios
.venv\Scripts\black.exe --config pyproject.toml --check . ..\scenarios
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
