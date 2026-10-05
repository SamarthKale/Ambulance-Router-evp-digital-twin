/**
 * Dev-only asset page (http://localhost:5173/assets): every manifest asset on its own
 * turntable with axes (+Z = forward, blue), a 1 m grid, a 5 m ruler and its bounding box,
 * plus size, triangles, draw calls, load status, parts and a "copy manifest entry" button.
 * One WebGL canvas for all cards (drei <View>), so 40+ previews don't exhaust contexts.
 */
import { OrbitControls, PerspectiveCamera, View } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { BackSide, Box3, Sphere, Vector3, type DataTexture } from "three";

import { loadSkybox, useSkyStore } from "../components/Sky";
import { useAsset, useAssetStore } from "./loader";
import { ASSET_KEYS, MANIFEST, SKYBOX, type AssetKey } from "./manifest";
import type { PreparedAsset } from "./prepare";
import "./assets.css";

export default function AssetsPage() {
  useEffect(() => {
    document.title = "EmergencyFlow assets";
    useAssetStore.getState().setInteractive(); // this page is interactive at once
  }, []);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const states = useAssetStore((s) => s.states);
  const loaded = ASSET_KEYS.filter((k) => states[k]?.status === "loaded").length;
  return (
    <div className="assets-page" ref={setRoot}>
      <header className="assets-header">
        <strong>EmergencyFlow assets</strong>
        <span>
          {ASSET_KEYS.length} manifest entries · {loaded} loaded · files served unmodified from 3d_models/
        </span>
        <span className="legend">axes: <b className="x">X</b> <b className="y">Y</b> <b className="z">Z = forward</b> · grid 1 m · ruler 5 m (white) · yellow box = bounds</span>
      </header>
      <div className="asset-grid">
        {ASSET_KEYS.map((key) => (
          <AssetCard key={key} id={key} />
        ))}
        <SkyboxCard />
      </div>
      {root && (
        <Canvas className="assets-canvas" eventSource={root} dpr={[1, 1.5]}>
          <View.Port />
        </Canvas>
      )}
    </div>
  );
}

function AssetCard({ id }: { id: AssetKey }) {
  const entry = MANIFEST[id];
  const lazy = "lazy" in entry && entry.lazy === true;
  const [load, setLoad] = useState(!lazy);
  const asset = useAsset(id, load);
  const state = useAssetStore((s) => s.states[id]);
  const [copied, setCopied] = useState(false);
  const status = state?.status ?? (load ? "loading" : "on demand");
  const [w, h, l] = asset.size;
  const [pw, ph, pl] = entry.placeholder.size;
  const drift = Math.max(Math.abs(w - pw) / pw, Math.abs(h - ph) / ph, Math.abs(l - pl) / pl);

  const copy = () => {
    const measured = { ...entry, placeholder: { ...entry.placeholder, size: asset.size.map((v) => +v.toFixed(2)) } };
    void navigator.clipboard.writeText(`${id}: ${JSON.stringify(measured, null, 2)},`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <section className={`asset-card ${status}`}>
      <View className="asset-view">
        <Preview asset={asset} />
      </View>
      <div className="asset-info">
        <div className="asset-title">
          <strong>{id}</strong>
          <span className={`badge ${status}`}>{asset.placeholder && status === "loaded" ? "placeholder" : status}</span>
        </div>
        <div className="muted">
          {entry.workbook ?? "not in workbook"} · {entry.owner}
          {entry.priority ? ` · ${entry.priority}` : ""}
        </div>
        <div className="file" title={entry.file}>
          {entry.file}
        </div>
        <table>
          <tbody>
            <tr>
              <th>size (m)</th>
              <td>
                {w.toFixed(2)} × {h.toFixed(2)} × {l.toFixed(2)}
                {!asset.placeholder && drift > 0.15 && <span className="warn"> (placeholder {Math.round(drift * 100)}% off)</span>}
              </td>
            </tr>
            <tr>
              <th>triangles</th>
              <td className={asset.triangles > entry.triBudget ? "warn" : ""}>
                {asset.triangles.toLocaleString()} / {entry.triBudget.toLocaleString()}
              </td>
            </tr>
            <tr>
              <th>draws / copy</th>
              <td>
                {asset.parts.length}
                {asset.sourceMeshes > 0 && ` (file: ${asset.sourceMeshes} meshes)`}
              </td>
            </tr>
            <tr>
              <th>parts</th>
              <td>
                {asset.foundParts.length ? asset.foundParts.join(", ") : "-"}
                {asset.missingParts.length > 0 && <span className="warn"> missing: {asset.missingParts.join(", ")}</span>}
              </td>
            </tr>
            {state?.ms !== undefined && (
              <tr>
                <th>load</th>
                <td>{state.ms} ms</td>
              </tr>
            )}
            {state?.status === "error" && (
              <tr>
                <th>error</th>
                <td className="warn">{state.message}</td>
              </tr>
            )}
          </tbody>
        </table>
        {asset.nodeNames.length > 0 && (
          <details>
            <summary>{asset.nodeNames.length} nodes</summary>
            <div className="nodes">{asset.nodeNames.slice(0, 60).join(" · ")}</div>
          </details>
        )}
        <div className="asset-actions">
          {!load && <button onClick={() => setLoad(true)}>Load (heavy file)</button>}
          <button onClick={copy}>{copied ? "Copied" : "Copy manifest entry"}</button>
        </div>
      </div>
    </section>
  );
}

function Preview({ asset }: { asset: PreparedAsset }) {
  const { center, radius, box } = useMemo(() => {
    const b = new Box3(new Vector3(...asset.box.min), new Vector3(...asset.box.max));
    const sphere = b.getBoundingSphere(new Sphere());
    return { center: sphere.center.clone(), radius: Math.max(0.5, sphere.radius), box: b };
  }, [asset]);
  const gridSize = Math.max(6, Math.ceil(radius * 2.4));
  const distance = radius * 2.3;
  return (
    <>
      <PerspectiveCamera
        makeDefault
        fov={40}
        near={radius / 50}
        far={radius * 40 + 50}
        position={[center.x + distance * 0.75, center.y + distance * 0.5, center.z + distance * 0.85]}
      />
      <OrbitControls target={center} makeDefault />
      <color attach="background" args={["#1f2937"]} />
      <hemisphereLight args={["#ffffff", "#444444", 1.6]} />
      <directionalLight position={[5, 10, 7]} intensity={2} />
      {asset.parts.map((part, i) => (
        <mesh key={i} geometry={part.geometry} material={part.material} />
      ))}
      <gridHelper args={[gridSize, gridSize, "#6b7280", "#374151"]} />
      <axesHelper args={[Math.max(1.5, radius * 1.1)]} />
      <box3Helper args={[box, "#facc15"]} />
      <mesh position={[0, 0.02, -radius * 1.15]}>
        <boxGeometry args={[5, 0.04, 0.12]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </>
  );
}

function SkyboxCard() {
  const status = useSkyStore((s) => s.status);
  const message = useSkyStore((s) => s.message);
  const [texture, setTexture] = useState<DataTexture | null>(null);
  return (
    <section className="asset-card">
      <View className="asset-view">
        <PerspectiveCamera makeDefault fov={70} position={[0, 0, 0.1]} />
        <OrbitControls makeDefault enableZoom={false} />
        {texture ? (
          <mesh>
            <sphereGeometry args={[50, 48, 24]} />
            <meshBasicMaterial map={texture} side={BackSide} toneMapped />
          </mesh>
        ) : (
          <color attach="background" args={["#1f2937"]} />
        )}
      </View>
      <div className="asset-info">
        <div className="asset-title">
          <strong>skybox</strong>
          <span className={`badge ${status}`}>{status}</span>
        </div>
        <div className="muted">
          {SKYBOX.workbook} · {SKYBOX.owner} · {SKYBOX.priority}
        </div>
        <div className="file">{SKYBOX.file}</div>
        <div className="muted">{message ?? "72 MB OpenEXR, decoded in a Web Worker"}</div>
        <div className="asset-actions">
          {!texture && (
            <button disabled={status === "loading"} onClick={() => void loadSkybox().then(setTexture)}>
              Load (72 MB)
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
