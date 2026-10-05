/** WebSocket client: reconnects automatically, identifies the tab, stamps commands, feeds the store. */
import {
  PROTOCOL_VERSION,
  useSim,
  type Command,
  type CommandBody,
  type NetworkMsg,
  type ServerMsg,
} from "./state";

const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 2000;
const CLIENT_ID_KEY = "emergencyflow.clientId";

export function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws`;
}

export async function fetchNetwork(): Promise<NetworkMsg> {
  const response = await fetch("/api/network");
  if (!response.ok) throw new Error(`GET /api/network failed: ${response.status}`);
  return (await response.json()) as NetworkMsg;
}

/**
 * Per-tab id sent in `hello`, so a tab that reconnects keeps the driver role.
 * sessionStorage: survives reloads and reconnects, but two tabs are two clients.
 */
export function tabClientId(): string {
  const fresh = `tab-${crypto.randomUUID()}`;
  try {
    const stored = sessionStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
    sessionStorage.setItem(CLIENT_ID_KEY, fresh);
  } catch {
    // storage blocked (private mode, sandbox): the id lasts for this page only
  }
  return fresh;
}

const SERVER_TYPES: ReadonlySet<string> = new Set(["state", "ack", "error", "session"]);

/** Light runtime check: the backend is trusted, but a version mismatch must not render garbage. */
export function parseServerMsg(text: string): ServerMsg | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { v, type } = data as { v?: unknown; type?: unknown };
  if (v !== PROTOCOL_VERSION || typeof type !== "string" || !SERVER_TYPES.has(type)) return null;
  return data as ServerMsg;
}

export class SimSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly clientId: string,
  ) {}

  connect(): void {
    this.stopped = false;
    useSim.getState().setConnection("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = RETRY_MIN_MS;
      this.send({ cmd: "hello", clientId: this.clientId }); // reclaims the driver role
      useSim.getState().setConnection("open");
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      const msg = parseServerMsg(event.data);
      if (!msg) return;
      const store = useSim.getState();
      if (msg.type === "state") store.receiveState(msg, performance.now());
      else if (msg.type === "session") store.receiveSession(msg);
      else store.receiveReply(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      useSim.getState().setConnection("closed");
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
  }

  /** Returns false if the socket is not open (the command is dropped, not queued). */
  send(body: CommandBody): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const message: Command =
      body.cmd === "drive" || body.cmd === "hello"
        ? { v: PROTOCOL_VERSION, ...body }
        : { v: PROTOCOL_VERSION, id: this.nextId++, ...body };
    ws.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
