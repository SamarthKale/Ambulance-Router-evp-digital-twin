import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";

import { TopDownScene } from "../components/TopDownScene";
import { Hud } from "../dashboard/Hud";
import { useSim, type CommandBody } from "../simulation/state";
import { useManualDrive } from "../simulation/useManualDrive";
import { SimSocket, fetchNetwork, socketUrl, tabClientId } from "../simulation/websocket";

export function App() {
  const network = useSim((s) => s.network);
  const connection = useSim((s) => s.connection);
  const role = useSim((s) => s.role);
  const [error, setError] = useState<string | null>(null);
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
          useSim.getState().setNetwork(fetched); // unchanged map: keep the built geometry
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
      if (e.code === "KeyF" && !e.repeat) useSim.getState().toggleFollow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <Canvas orthographic camera={{ position: [0, 500, 0.001], near: 0.1, far: 2000 }} dpr={[1, 2]}>
        <color attach="background" args={["#111827"]} />
        {network && <TopDownScene network={network} />}
      </Canvas>
      <Hud
        network={network}
        onDispatch={() => send({ cmd: "spawn_ambulance" })}
        onReset={() => send({ cmd: "reset" })}
        onMode={(mode) => send({ cmd: "set_mode", mode })}
        onRelease={() => send({ cmd: "release_control" })}
      />
      {error && <div className="banner">Backend not reachable: {error}</div>}
    </div>
  );
}
