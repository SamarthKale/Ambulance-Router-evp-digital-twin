import { Canvas } from "@react-three/fiber";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { CityScene } from "../components/CityScene";
import { SKY_COLOR } from "../components/Sky";
import { Hud } from "../dashboard/Hud";
import { Results } from "../dashboard/Results";
import { useSim, type CommandBody } from "../simulation/state";
import { useManualDrive } from "../simulation/useManualDrive";
import { SimSocket, fetchNetwork, socketUrl, tabClientId } from "../simulation/websocket";

// The read-only dashboard (/dashboard) for a second screen or another PC: no 3D, own chunk.
const DashboardPage = lazy(() => import("../dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));

// The replay of recorded experiment runs (/replay): a 2D command centre, no 3D, own chunk.
const ReplayPage = lazy(() => import("../replay/ReplayPage").then((m) => ({ default: m.ReplayPage })));

// Dev-only asset inspection page (CLAUDE.md section 11); not part of the production bundle.
const AssetsPage = import.meta.env.DEV ? lazy(() => import("../assets/AssetsPage")) : null;

export function App() {
  if (AssetsPage && window.location.pathname === "/assets") {
    return (
      <Suspense fallback={null}>
        <AssetsPage />
      </Suspense>
    );
  }
  if (window.location.pathname.startsWith("/replay")) {
    return (
      <Suspense fallback={null}>
        <ReplayPage />
      </Suspense>
    );
  }
  if (window.location.pathname.startsWith("/dashboard")) {
    return (
      <Suspense fallback={null}>
        <DashboardPage />
      </Suspense>
    );
  }
  return <Simulation />;
}

function Simulation() {
  const network = useSim((s) => s.network);
  const connection = useSim((s) => s.connection);
  const role = useSim((s) => s.role);
  const [error, setError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const socket = useRef<SimSocket | null>(null);

  useEffect(() => {
    const sim = new SimSocket(socketUrl(), tabClientId());
    socket.current = sim;
    sim.connect();
    return () => sim.close();
  }, []);

  // (Re)load the map on every (re)connect: a restarted backend may run another scenario.
  useEffect(() => {
    if (connection !== "open") return;
    let cancelled = false;
    fetchNetwork()
      .then((fetched) => {
        if (cancelled) return;
        setError(null);
        const current = useSim.getState().network;
        if (!current || JSON.stringify(current) !== JSON.stringify(fetched)) {
          useSim.getState().setNetwork(fetched); // unchanged map: keep the built city
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const send = useCallback((command: CommandBody) => {
    socket.current?.send(command);
  }, []);
  useManualDrive(send, undefined, role !== "observer");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.repeat || target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.code === "KeyF") useSim.getState().toggleFollow();
      if (e.code === "KeyC") useSim.getState().cycleView();
      if (e.code === "KeyR") setShowResults((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <Canvas dpr={[1, 1.5]} gl={{ powerPreference: "high-performance", antialias: true }}>
        <color attach="background" args={[SKY_COLOR]} />
        {network && <CityScene network={network} />}
      </Canvas>
      <Hud
        network={network}
        onDispatch={() => send({ cmd: "spawn_ambulance" })}
        onReset={() => send({ cmd: "reset" })}
        onMode={(mode) => send({ cmd: "set_mode", mode })}
        onRelease={() => send({ cmd: "release_control" })}
        onAccident={() => send({ cmd: "inject_incident", type: "accident" })}
        onClearAccidents={() => send({ cmd: "clear_incidents" })}
        onResults={() => setShowResults((open) => !open)}
      />
      {showResults && <Results onClose={() => setShowResults(false)} />}
      {error && <div className="banner">Backend not reachable: {error}</div>}
    </div>
  );
}
