/**
 * The playback clock: one time (seconds since the dispatch) that the map, the signals, the
 * event log and the charts all read, so they cannot drift apart. It lives outside React: the map
 * reads it every frame, and components subscribe through useClockTime, which re-renders them at
 * a limited rate.
 */
import { useSyncExternalStore } from "react";

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export class PlaybackClock {
  t = 0;
  playing = false;
  speed = 1;
  duration = 0;
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  setDuration(duration: number): void {
    this.duration = Math.max(0, duration);
    if (this.t > this.duration) this.t = this.duration;
    this.emit();
  }

  seek(t: number): void {
    this.t = Math.min(this.duration, Math.max(0, t));
    this.emit();
  }

  play(): void {
    if (this.t >= this.duration) this.t = 0; // at the end, play starts over
    this.playing = true;
    this.emit();
  }

  pause(): void {
    this.playing = false;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  restart(): void {
    this.t = 0;
    this.playing = true;
    this.emit();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.emit();
  }

  /** Advance by `dt` real seconds (called every animation frame). Stops at the end. */
  advance(dt: number): void {
    if (!this.playing) return;
    this.t += dt * this.speed;
    if (this.t >= this.duration) {
      this.t = this.duration;
      this.playing = false;
    }
    this.emit();
  }
}

export const clock = new PlaybackClock();

/** The clock time rounded down to 1/hz s: components re-render only when that changes. */
export function useClockTime(hz = 10): number {
  return useSyncExternalStore(clock.subscribe, () => Math.floor(clock.t * hz) / hz);
}

export function useClockPlaying(): boolean {
  return useSyncExternalStore(clock.subscribe, () => clock.playing);
}

export function useClockSpeed(): number {
  return useSyncExternalStore(clock.subscribe, () => clock.speed);
}

/** The length of the loaded run(s): changes when a second run (the ghost) finishes loading. */
export function useClockDuration(): number {
  return useSyncExternalStore(clock.subscribe, () => clock.duration);
}
