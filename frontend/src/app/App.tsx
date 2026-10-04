import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";

import { TopDownScene } from "../components/TopDownScene";
import { Hud } from "../dashboard/Hud";
import { useSim, type CommandBody } from "../simulation/state";
import { useManualDrive } from "../simulation/useManualDrive";
import { SimSocket, fetchNetwork, socketUrl } from "../simulation/websocket";

export function App() {
  const network = useSim((s) => s.network);
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<SimSocket | null>(null);

  useEffect(() => {
    const sim = new SimSocket(socketUrl());
    socket.current = sim;
    sim.connect();
    fetchNetwork()
      .then((n) => useSim.getState().setNetwork(n))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => sim.close();
  }, []);

  const send = useCallback((command: CommandBody) => {
    socket.current?.send(command);
  }, []);
  useManualDrive(send);

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
      />
      {error && <div className="banner">Backend not reachable: {error}</div>}
    </div>
  );
}
