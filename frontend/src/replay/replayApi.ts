import type { NetworkMsg, ReplayIndexMsg, ReplayRunMsg } from "../simulation/state";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new HttpError(response.status, `GET ${url} failed: ${response.status}`);
  return (await response.json()) as T;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const fetchReplayIndex = (): Promise<ReplayIndexMsg> => getJson("/api/replay/index");
export const fetchReplayNetwork = (scenario: string): Promise<NetworkMsg> =>
  getJson(`/api/replay/network/${encodeURIComponent(scenario)}`);

/** One run's telemetry; resolves to null when none was recorded (404). */
export async function fetchReplayRun(id: string): Promise<ReplayRunMsg | null> {
  const [arm, key] = id.split("/");
  try {
    return await getJson<ReplayRunMsg>(`/api/replay/runs/${encodeURIComponent(arm)}/${encodeURIComponent(key)}`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
