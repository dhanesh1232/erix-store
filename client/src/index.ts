/**
 * @ecodrix/erix-client
 *
 * Type-safe HTTP client for the erix-store in-memory data service.
 * Connects to a running erix-store instance without requiring the
 * consumer to know any of the underlying HTTP route structure.
 *
 * @example
 * ```ts
 * import { ErixClient } from '@ecodrix/erix-client'
 *
 * const store = new ErixClient({
 *   baseUrl: 'https://erix-store.onrender.com',
 *   apiKey: process.env.ERIX_API_KEY!,
 *   tenantId: 'org_abc123',
 * })
 *
 * await store.set('session:user1', { role: 'admin' }, 3600)
 * const session = await store.get<{ role: string }>('session:user1')
 * ```
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Any value that can be serialized to and from JSON */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ErixClientOptions {
  /** Full URL of the deployed erix-store instance, e.g. https://erix-store.onrender.com */
  baseUrl: string;
  /** Shared secret generated at deploy time — must match ERIX_API_KEY on the server */
  apiKey: string;
  /** Tenant namespace — all keys are automatically namespaced under this prefix */
  tenantId: string;
  /** Optional request timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ErixClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: ErixClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.headers = {
      "x-erix-key": options.apiKey,
      "x-tenant-id": options.tenantId,
      "Content-Type": "application/json",
    };
  }

  // ── Internal fetch helper ─────────────────────────────────────────────

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          `[erix-store] ${method} ${path} → ${res.status}: ${err.error ?? res.statusText}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Health ───────────────────────────────────────────────────────────

  /** Check if the erix-store instance is reachable */
  async ping(): Promise<{ status: string; uptime: number }> {
    return this.req("GET", "/health");
  }

  // ─── Core: Key / Value ────────────────────────────────────────────────

  /**
   * Store any JSON value under a key.
   * @param ttlSeconds  Optional expiry in seconds. Omit for no expiry.
   */
  async set(key: string, value: JsonValue, ttlSeconds?: number): Promise<void> {
    await this.req("POST", "/core/set", {
      key,
      value: JSON.stringify(value),
      ttl: ttlSeconds,
    });
  }

  /**
   * Retrieve a value by key. Returns `null` if the key doesn't exist or has expired.
   */
  async get<T = JsonValue>(key: string): Promise<T | null> {
    const data = await this.req<{ value: string | null }>(
      "GET",
      "/core/get",
      undefined,
      { key },
    );
    if (!data.value) return null;
    try {
      return JSON.parse(data.value) as T;
    } catch {
      return data.value as unknown as T;
    }
  }

  /** Delete a key */
  async del(key: string): Promise<void> {
    await this.req("DELETE", "/core/del", { key });
  }

  // ─── Hash ─────────────────────────────────────────────────────────────

  public hash = {
    /** Set a field in a hash */
    hset: async (
      key: string,
      field: string,
      value: JsonValue,
    ): Promise<void> => {
      await this.req("POST", "/hash/hset", {
        key,
        field,
        value: JSON.stringify(value),
      });
    },
    /** Get a single field from a hash */
    hget: async <T = JsonValue>(
      key: string,
      field: string,
    ): Promise<T | null> => {
      const data = await this.req<{ value: string | null }>(
        "GET",
        "/hash/hget",
        undefined,
        { key, field },
      );
      if (!data.value) return null;
      try {
        return JSON.parse(data.value) as T;
      } catch {
        return data.value as unknown as T;
      }
    },
    /** Get all fields of a hash */
    hgetall: async (key: string): Promise<Record<string, string>> => {
      const data = await this.req<{ data: Record<string, string> }>(
        "GET",
        "/hash/hgetall",
        undefined,
        { key },
      );
      return data.data;
    },
  };

  // ─── List ─────────────────────────────────────────────────────────────

  public list = {
    /** Prepend a value to a list */
    lpush: async (key: string, value: JsonValue): Promise<void> => {
      await this.req("POST", "/list/lpush", {
        key,
        value: JSON.stringify(value),
      });
    },
    /** Append a value to a list */
    rpush: async (key: string, value: JsonValue): Promise<void> => {
      await this.req("POST", "/list/rpush", {
        key,
        value: JSON.stringify(value),
      });
    },
    /** Pop from the left (FIFO front) */
    lpop: async <T = JsonValue>(key: string): Promise<T | null> => {
      const data = await this.req<{ value: string | null }>(
        "GET",
        "/list/lpop",
        undefined,
        { key },
      );
      if (!data.value) return null;
      try {
        return JSON.parse(data.value) as T;
      } catch {
        return data.value as unknown as T;
      }
    },
  };

  // ─── Queue (FIFO job queue, built on List) ────────────────────────────

  public queue = {
    /** Enqueue a job payload into a named queue */
    push: async (name: string, data: JsonValue): Promise<void> => {
      await this.list.rpush(`q:${name}`, data);
    },
    /** Dequeue the oldest job from a named queue. Returns `null` if empty. */
    pop: async <T = JsonValue>(name: string): Promise<T | null> => {
      return this.list.lpop<T>(`q:${name}`);
    },
  };

  // ─── PubSub ───────────────────────────────────────────────────────────

  public pubsub = {
    /** Publish a message to a channel */
    publish: async (channel: string, message: JsonValue): Promise<void> => {
      await this.req("POST", "/pubsub/publish", { channel, message });
    },
  };

  // ─── Rate Limiter ─────────────────────────────────────────────────────

  /**
   * Check if an operation is within rate limits.
   * @param key     Identifier (e.g. `"api:org_123"`)
   * @param limit   Maximum allowed operations in the window
   * @param window  Window duration in seconds
   */
  async rateLimit(
    key: string,
    limit: number,
    window: number,
  ): Promise<RateLimitResult> {
    return this.req<RateLimitResult>("POST", "/ratelimit", {
      key,
      limit,
      window,
    });
  }

  // ─── Set ──────────────────────────────────────────────────────────────

  public set_ = {
    /** Add a member to a set */
    sadd: async (key: string, value: string): Promise<{ added: number }> => {
      return this.req("POST", "/set/sadd", { key, value });
    },
    /** Get all members of a set */
    smembers: async (key: string): Promise<string[]> => {
      const data = await this.req<{ members: string[] }>(
        "GET",
        "/set/smembers",
        undefined,
        { key },
      );
      return data.members;
    },
  };
}
