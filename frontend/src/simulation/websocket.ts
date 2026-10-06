/** WebSocket client: reconnects automatically, identifies the tab, stamps commands, feeds the store. */
import {
  PROTOCOL_VERSION,
  useSim,
  type Command,
  type CommandBody,
  type NetworkMsg,
  type ResultsMsg,
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

export async function fetchResults(): Promise<ResultsMsg> {
  const response = await fetch("/api/results");
  if (!response.ok) throw new Error(`GET /api/results failed: ${response.status}`);
  return (await response.json()) as ResultsMsg;
}

/**
 * Per-tab id sent in `hello`, so a tab that reconnects keeps the driver role.
 * sessionStorage: survives reloads and reconnects, but two tabs are two clients.
 */
export function tabClientId(): string {
  const fresh = `tab-${randomId()}`;
  try {
    const stored = sessionStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
    sessionStorage.setItem(CLIENT_ID_KEY, fresh);
  } catch {
    // storage blocked (private mode, sandbox): the id lasts for this page only
  }
  return fresh;
}

/**
 * 32 random hex digits. crypto.randomUUID exists only in secure contexts (https, localhost),
 * so a page opened from another PC (http://<LAN IP>) uses getRandomValues, available everywhere.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

  /**
   * Opens the socket one task later. React StrictMode (development) mounts, unmounts and
   * remounts every effect, so an immediate open would create a socket that is closed while
   * still connecting: the browser warns, and the dev server's proxy, already relaying the
   * backend's first state tick into it, logs "ws proxy error: write ECONNABORTED".
   * close() cancels the pending open, so only one socket is ever created.
   */
  connect(): void {
    this.stopped = false;
    useSim.getState().setConnection("connecting");
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, delayMs);
  }

  private open(): void {
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
      this.schedule(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
  }

  /**
   * Returns the command's id, so its ack can be matched (0 for drive and hello, which carry
   * none), or null if the socket is not open (the command is dropped, not queued).
   */
  send(body: CommandBody): number | null {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    if (body.cmd === "drive" || body.cmd === "hello") {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...body } satisfies Command));
      return 0;
    }
    const id = this.nextId++;
    const message: Command = { v: PROTOCOL_VERSION, id, ...body };
    ws.send(JSON.stringify(message));
    return id;
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
