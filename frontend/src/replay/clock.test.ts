import { describe, expect, it } from "vitest";

import { PlaybackClock } from "./clock";

function make(duration = 10): PlaybackClock {
  const clock = new PlaybackClock();
  clock.setDuration(duration);
  return clock;
}

describe("PlaybackClock", () => {
  it("advances only while playing, at the chosen speed", () => {
    const clock = make();
    clock.advance(1);
    expect(clock.t).toBe(0);
    clock.play();
    clock.advance(1);
    expect(clock.t).toBe(1);
    clock.setSpeed(4);
    clock.advance(0.5);
    expect(clock.t).toBe(3);
    clock.pause();
    clock.advance(5);
    expect(clock.t).toBe(3);
  });

  it("stops at the end and plays from the start when played again", () => {
    const clock = make(10);
    clock.play();
    clock.advance(30);
    expect(clock.t).toBe(10);
    expect(clock.playing).toBe(false);
    clock.play();
    expect(clock.t).toBe(0);
    expect(clock.playing).toBe(true);
  });

  it("clamps a seek to the run", () => {
    const clock = make(10);
    clock.seek(-4);
    expect(clock.t).toBe(0);
    clock.seek(99);
    expect(clock.t).toBe(10);
    clock.setDuration(6); // a shorter run: the time stays inside it
    expect(clock.t).toBe(6);
  });

  it("restarts from zero and keeps playing", () => {
    const clock = make();
    clock.seek(7);
    clock.restart();
    expect(clock).toMatchObject({ t: 0, playing: true });
  });

  it("toggles play and pause", () => {
    const clock = make();
    clock.toggle();
    expect(clock.playing).toBe(true);
    clock.toggle();
    expect(clock.playing).toBe(false);
  });

  it("tells subscribers about every change until they unsubscribe", () => {
    const clock = make();
    let calls = 0;
    const off = clock.subscribe(() => calls++);
    clock.seek(1);
    clock.play();
    expect(calls).toBe(2);
    off();
    clock.seek(2);
    expect(calls).toBe(2);
    expect(clock.getVersion()).toBeGreaterThan(2);
  });
});
