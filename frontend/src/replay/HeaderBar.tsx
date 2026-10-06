import { PlaybackControls, RunSelector } from "./Header";
import { useReplay } from "./replayStore";

export function Header() {
  const demo = useReplay((s) => s.demo);
  const set = useReplay((s) => s.set);
  return (
    <header className="rp-header">
      <div className="rp-top">
        <div className="brand">
          <h1>EmergencyFlow AI · Replay</h1>
          <span className="badge" title="Everything here was recorded from the simulation; nothing is running live">
            RECORDED EXPERIMENT PLAYBACK · not live
          </span>
        </div>
        <nav className="nav">
          <a href="/" title="The live simulation">Live simulation</a>
          <a href="/dashboard" title="Live tiles and the batch results">Dashboard</a>
          <button className={demo ? "active" : ""} onClick={() => set({ demo: !demo })} title="Hide the technical controls (D)">
            {demo ? "Exit demo mode" : "Demo mode"}
          </button>
        </nav>
      </div>
      <div className="rp-controls">
        {!demo && <RunSelector />}
        <PlaybackControls />
      </div>
    </header>
  );
}
