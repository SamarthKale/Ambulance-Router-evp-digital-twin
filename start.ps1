<#
.SYNOPSIS
  EmergencyFlow AI: start the simulation backend and the 3D frontend with one command.

.DESCRIPTION
  Local, native Windows only (no Docker). Starts the backend (SUMO + FastAPI on
  127.0.0.1:8000) and the frontend (Vite on http://localhost:5173), waits until both answer,
  opens the browser, and stops both (SUMO included) on Ctrl+C or when either one exits.
  Logs go to logs\backend.log and logs\frontend.log.

  If PowerShell refuses to run scripts, start it with:
    powershell -ExecutionPolicy Bypass -File .\start.ps1

.EXAMPLE
  .\start.ps1 -Setup                         # first time: venv, Python and npm packages, .env
.EXAMPLE
  .\start.ps1                                # the demo: 4x4 grid, heavy traffic (1.5x)
.EXAMPLE
  .\start.ps1 -Scenario grid2x2 -Scale 1.0   # the small grid, normal traffic
.EXAMPLE
  .\start.ps1 -Prod                          # production build, served by vite preview (port 4173)
.EXAMPLE
  .\start.ps1 -Lan                           # also reachable from other PCs on the network:
                                             # http://<this PC's IP>:5173/dashboard
#>
param(
    [ValidateSet("grid2x2", "grid4x4")][string]$Scenario = "grid4x4",
    [double]$Scale = 1.5,
    [int]$Seed = 42,
    [int]$Warmup = 120,           # simulated seconds fast-forwarded at start and after Reset
    [switch]$NoGhost,             # no OFF ghost (saves a second SUMO process)
    [switch]$Prod,                # production build + vite preview instead of the dev server
    [switch]$Setup,               # create the venv and install packages first
    [switch]$NoBrowser,
    [switch]$Lan,                 # listen on the network too (dashboard / observers on other PCs)
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 0        # 0: 5173 (dev) or 4173 (-Prod)
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$logs = Join-Path $root "logs"
$python = Join-Path $backend ".venv\Scripts\python.exe"
if ($FrontendPort -eq 0) { if ($Prod) { $FrontendPort = 4173 } else { $FrontendPort = 5173 } }

function Say([string]$text, [string]$color = "Gray") { Write-Host $text -ForegroundColor $color }
function Fail([string]$text) { throw $text }  # caught below: the servers are stopped first

function Read-DotEnv([string]$path) {
    $values = @{}
    if (Test-Path $path) {
        foreach ($line in Get-Content $path) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
        }
    }
    return $values
}

function Test-PortFree([int]$port) {
    $owner = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $owner) {
        $name = (Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Fail "port $port is in use by $name (PID $($owner.OwningProcess)). Stop it, or pass -BackendPort / -FrontendPort."
    }
}

function Wait-Url([string]$url, [int]$seconds, [System.Diagnostics.Process]$process, [string]$what) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) { return $false }
        try {
            $response = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return $response }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    Fail "$what did not answer at $url within $seconds s (see the logs folder)"
}

function Stop-Tree($process) {
    if ($null -ne $process -and -not $process.HasExited) {
        & taskkill /T /F /PID $process.Id 2>&1 | Out-Null
    }
}

$backendProcess = $null
$frontendProcess = $null
$failed = $false
try {
    # ---- prerequisites -----------------------------------------------------------------------
    Set-Location $root
    if (-not (Test-Path (Join-Path $root ".env"))) {
        Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
        Say "created .env from .env.example" "Yellow"
    }
    $dotenv = Read-DotEnv (Join-Path $root ".env")
    $sumoHome = $env:SUMO_HOME
    if (-not $sumoHome) { $sumoHome = $dotenv["SUMO_HOME"] }
    if (-not $sumoHome -or -not (Test-Path (Join-Path $sumoHome "bin\sumo.exe"))) {
        Fail "SUMO not found. Install SUMO 1.27.1 and set SUMO_HOME (system-wide or in .env)."
    }

    if ($Setup) {
        if (-not (Test-Path $python)) {
            Say "creating the Python environment (backend\.venv)..." "Cyan"
            & py -3.13 -m venv (Join-Path $backend ".venv")
            if ($LASTEXITCODE -ne 0) { Fail "could not create the venv: is Python 3.13 installed (py -3.13)?" }
        }
        Say "installing Python packages..." "Cyan"
        & $python -m pip install --quiet -r (Join-Path $backend "requirements.txt")
        if ($LASTEXITCODE -ne 0) { Fail "pip install failed" }
        Say "installing npm packages..." "Cyan"
        Push-Location $frontend
        & npm.cmd install --no-fund --no-audit
        $npmExit = $LASTEXITCODE
        Pop-Location
        if ($npmExit -ne 0) { Fail "npm install failed" }
    }
    if (-not (Test-Path $python)) { Fail "backend\.venv is missing: run .\start.ps1 -Setup first" }
    if (-not (Test-Path (Join-Path $frontend "node_modules"))) { Fail "frontend\node_modules is missing: run .\start.ps1 -Setup first" }

    $sample = Get-ChildItem (Join-Path $root "3d_models") -Recurse -Filter *.glb -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $sample -and $sample.Length -lt 1024) {
        Say "warning: 3D models look like Git LFS pointers (run: git lfs pull). The app still runs, with placeholder shapes." "Yellow"
    }
    Test-PortFree $BackendPort
    Test-PortFree $FrontendPort
    New-Item -ItemType Directory -Force $logs | Out-Null

    # ---- start ---------------------------------------------------------------------------------
    $env:EF_SCENARIO = $Scenario
    $env:EF_SCALE = "$Scale"
    $env:EF_SEED = "$Seed"
    $env:EF_WARMUP_S = "$Warmup"
    if ($NoGhost) { $env:EF_GHOST = "0" } else { $env:EF_GHOST = "1" }
    $env:EF_BACKEND = "127.0.0.1:$BackendPort"

    Say "EmergencyFlow AI: $Scenario, demand x$Scale, seed $Seed, warm-up $Warmup s, OFF ghost $(-not $NoGhost)" "Green"
    Say "starting the backend (SUMO + API) on 127.0.0.1:$BackendPort..." "Cyan"
    $backendProcess = Start-Process -FilePath $python -WorkingDirectory $backend -NoNewWindow -PassThru `
        -ArgumentList "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "$BackendPort" `
        -RedirectStandardOutput (Join-Path $logs "backend.log") -RedirectStandardError (Join-Path $logs "backend.err.log")

    $health = "http://127.0.0.1:$BackendPort/api/health"
    $deadline = (Get-Date).AddSeconds(240)
    while ($true) {
        if ($backendProcess.HasExited) { Fail "the backend stopped (see logs\backend.err.log)" }
        if ((Get-Date) -gt $deadline) { Fail "the backend did not start within 240 s (see logs\backend.err.log)" }
        try {
            $state = Invoke-RestMethod $health -TimeoutSec 2
            if ($state.status -eq "running") { break }
            if ($state.status -eq "error") { Fail "the simulation failed to start: $($state.error)" }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    Say ("backend running: t = {0} s, {1} vehicles, tick p50 {2} ms" -f $state.t, $state.vehicles, $state.tickMsP50) "Green"

    Push-Location $frontend
    try {
        if ($Prod) {
            Say "building the frontend (production)..." "Cyan"
            & npm.cmd run build *> (Join-Path $logs "frontend-build.log")
            if ($LASTEXITCODE -ne 0) { Fail "the frontend build failed (see logs\frontend-build.log)" }
            $npmArgs = @("run", "preview", "--", "--port", "$FrontendPort", "--strictPort")
        } else {
            $npmArgs = @("run", "dev", "--", "--port", "$FrontendPort", "--strictPort")
        }
        # The backend stays on 127.0.0.1: Vite proxies /api and /ws to it.
        if ($Lan) { $npmArgs += @("--host") }  # all addresses, IPv4 and IPv6
        Say "starting the frontend on http://localhost:$FrontendPort ..." "Cyan"
        $frontendProcess = Start-Process -FilePath "npm.cmd" -ArgumentList $npmArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput (Join-Path $logs "frontend.log") -RedirectStandardError (Join-Path $logs "frontend.err.log")
    } finally {
        Pop-Location
    }
    $url = "http://localhost:$FrontendPort/"
    if (-not (Wait-Url $url 90 $frontendProcess "the frontend")) { Fail "the frontend stopped (see logs\frontend.err.log)" }
    Say "ready: $url  (dashboard: ${url}dashboard)" "Green"
    if ($Lan) {
        $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" }
        foreach ($a in $addresses) {
            Say ("from other PCs ({0}): http://{1}:{2}/dashboard  (live 3D view: http://{1}:{2}/)" -f $a.InterfaceAlias, $a.IPAddress, $FrontendPort) "Green"
        }
        $public = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq "Public" }
        if ($public) {
            Say "note: the network '$($public[0].Name)' is Public, where Windows blocks incoming connections. Make it Private, or allow the port (admin PowerShell):" "Yellow"
            Say "  New-NetFirewallRule -DisplayName 'EmergencyFlow $FrontendPort' -Direction Inbound -Protocol TCP -LocalPort $FrontendPort -Action Allow" "Yellow"
        } else {
            Say "if another PC can't connect, allow Node.js when Windows asks, or allow TCP $FrontendPort in Windows Firewall" "Gray"
        }
    }
    if (-not $NoBrowser) { Start-Process $url }
    Say "Demo: Reset, then Dispatch (the OFF ghost replays the first mission after a reset). R shows the experiment results." "Gray"
    Say "Press Ctrl+C to stop both servers." "Gray"

    while ($true) {
        if ($backendProcess.HasExited) { Say "the backend exited (see logs\backend*.log); stopping the other one" "Yellow"; break }
        if ($frontendProcess.HasExited) { Say "the frontend exited (see logs\frontend*.log); stopping the other one" "Yellow"; break }
        Start-Sleep -Seconds 1
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $failed = $true
} finally {
    Stop-Tree $frontendProcess
    Stop-Tree $backendProcess
    if ($null -ne $backendProcess) { Say "stopped" "Gray" }
}
if ($failed) { exit 1 }
