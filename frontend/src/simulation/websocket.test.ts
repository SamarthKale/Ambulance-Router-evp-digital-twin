import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SimSocket, parseServerMsg, randomId } from "./websocket";

class FakeWebSocket {
  static readonly OPEN = 1;
  static created: FakeWebSocket[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.created.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

describe("SimSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.created = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens one socket under React StrictMode's mount, unmount, remount", () => {
    const first = new SimSocket("ws://x/ws", "tab-test-0001");
    first.connect();
    first.close(); // StrictMode cleanup, before the deferred open
    const second = new SimSocket("ws://x/ws", "tab-test-0001");
    second.connect();
    vi.runOnlyPendingTimers();
    expect(FakeWebSocket.created).toHaveLength(1);
    expect(FakeWebSocket.created[0]!.closed).toBe(false);
  });

  it("reconnects after the connection drops, but not after close()", () => {
    const sim = new SimSocket("ws://x/ws", "tab-test-0001");
    sim.connect();
    vi.runOnlyPendingTimers();
    FakeWebSocket.created[0]!.onclose?.(); // backend restarted
    vi.advanceTimersByTime(300);
    expect(FakeWebSocket.created).toHaveLength(2);
    sim.close();
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.created).toHaveLength(2);
  });
});

describe("randomId", () => {
  it("works without crypto.randomUUID (pages opened from another PC are not a secure context)", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const a = randomId();
      expect(a).toMatch(/^[0-9a-f]{32}$/);
      expect(randomId()).not.toBe(a);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});

describe("parseServerMsg", () => {
  it("accepts v1 state, ack and error messages", () => {
    expect(parseServerMsg('{"v":1,"type":"ack","id":3,"ok":false,"reason":"x"}')).toMatchObject({
      type: "ack",
      id: 3,
    });
    expect(parseServerMsg('{"v":1,"type":"error","reason":"bad"}')?.type).toBe("error");
    expect(parseServerMsg('{"v":1,"type":"state","seq":1}')?.type).toBe("state");
  });

  it("rejects other versions, unknown types and garbage", () => {
    expect(parseServerMsg('{"v":2,"type":"state"}')).toBeNull();
    expect(parseServerMsg('{"v":1,"type":"hello"}')).toBeNull();
    expect(parseServerMsg("not json")).toBeNull();
    expect(parseServerMsg("null")).toBeNull();
  });
});
