import { describe, expect, it } from "vitest";

import { parseServerMsg } from "./websocket";

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
