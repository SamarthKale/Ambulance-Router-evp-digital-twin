/**
 * Protocol contract, frontend half. The fixtures are generated from the backend's models
 * (backend/scripts/gen_contract.py) and each one `satisfies` its type from state.ts, so
 * tsc fails on any field drift. The checks below also catch command or message types
 * that exist on only one side.
 */
import { describe, expect, it } from "vitest";

import * as fixtures from "./contract.fixtures";
import type {
  Command,
  HealthMsg,
  IncidentType,
  MissionStatus,
  Routing,
  ServerMsg,
  SessionRole,
  SignalControl,
  SignalMode,
  TurnKind,
} from "./state";
import { parseServerMsg } from "./websocket";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Values<K extends keyof typeof fixtures.BACKEND_ENUMS> = (typeof fixtures.BACKEND_ENUMS)[K][number];

// Compile-time: a command, message type or enum value present on only one side breaks the build.
const commandsMatch: Equal<Command["cmd"], (typeof fixtures.BACKEND_COMMANDS)[number]> = true;
const serverTypesMatch: Equal<ServerMsg["type"], (typeof fixtures.BACKEND_SERVER_TYPES)[number]> =
  true;
const enumsMatch: [
  Equal<SessionRole, Values<"role">>,
  Equal<SignalMode, Values<"mode">>,
  Equal<SignalControl, Values<"signalControl">>,
  Equal<MissionStatus, Values<"missionStatus">>,
  Equal<TurnKind, Values<"turn">>,
  Equal<HealthMsg["status"], Values<"healthStatus">>,
  Equal<Routing, Values<"routing">>,
  Equal<IncidentType, Values<"incidentType">>,
] = [true, true, true, true, true, true, true, true];

describe("protocol contract", () => {
  it("knows every backend command, server message type and enum value", () => {
    expect(commandsMatch && serverTypesMatch && enumsMatch.every(Boolean)).toBe(true);
    expect(new Set(fixtures.commands.map((c) => c.cmd))).toEqual(new Set(fixtures.BACKEND_COMMANDS));
  });

  it("parses every real server message", () => {
    const messages: ServerMsg[] = [
      fixtures.stateDriving,
      fixtures.stateIdle,
      fixtures.ackRejected,
      fixtures.ackAccepted,
      fixtures.error,
      fixtures.sessionDriver,
    ];
    for (const msg of messages) {
      expect(parseServerMsg(JSON.stringify(msg))).toEqual(msg);
    }
  });

  it("matches the real network payload shape", () => {
    const { network } = fixtures;
    expect(network.lanes[0]?.shape[0]).toHaveLength(2);
    expect(network.signals[0]?.links[0]?.fromLane).toMatch(/_\d+$/);
  });
});
