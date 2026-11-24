export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thrown when no server address answers: the phone is off the office Wi-Fi or the PC is down. */
export class OfflineError extends Error {
  constructor() {
    super("Can't reach the server. Are you on the office Wi-Fi?");
  }
}

const TIMEOUT_MS = 6000;

/**
 * Calls the first server address that answers. Pairing can give several addresses (one per network
 * card on the PC); the one that worked last is tried first.
 */
export async function request<T>(
  servers: string[],
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null } = {},
): Promise<{ data: T; server: string }> {
  for (const server of servers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(server + path, {
        method,
        signal: controller.signal,
        headers: {
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      continue; // unreachable or timed out: try the next address
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(json?.error ?? `Server error ${res.status}`, res.status);
    return { data: json as T, server };
  }
  throw new OfflineError();
}
