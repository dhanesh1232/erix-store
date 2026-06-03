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

import { HttpTransport } from "./transports/HttpTransport.js";
import type {
  TransportLayer,
  TransportMode,
} from "./transports/TransportLayer.js";
import { WebSocketTransport } from "./transports/WebSocketTransport.js";

export { HttpTransport } from "./transports/HttpTransport.js";
export { WebSocketTransport } from "./transports/WebSocketTransport.js";
// Re-export transport types for consumers
export type { TransportLayer, TransportMode };

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
  /** Full URL of the deployed erix-store instance, e.g. https://api.erix.ecodrix.com */
  baseUrl: string;
  /** Shared secret generated at deploy time — must match ERIX_API_KEY on the server */
  apiKey: string;
  /** Tenant namespace — all keys are automatically namespaced under this prefix */
  tenantId: string;
  /** Optional request timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /**
   * Transport mode:
   * - "http": Use HTTP only (original behavior)
   * - "ws": Use WebSocket only
   * - "auto": Attempt WebSocket first, fall back to HTTP if unavailable (default)
   */
  transport?: "http" | "ws" | "auto";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface JobV2<T = JsonValue> {
  id: string;
  queueName: string;
  data: T;
  status: "waiting" | "active" | "completed" | "failed" | "delayed";
  attempts: number;
  maxAttempts: number;
  priority: number;
  createdAt: string;
  runAt: string;
  clientCode?: string;
  progress?: number;
  error?: string;
  result?: JsonValue;
}

export interface EnqueueOptionsV2 {
  priority?: number;
  maxAttempts?: number;
  delayMs?: number;
  runAt?: Date | string;
  clientCode?: string;
  metadata?: Record<string, JsonValue>;
}

export interface CacheSetOptions {
  /** TTL in milliseconds */
  ttl?: number;
  /** Tags for bulk invalidation */
  tags?: string[];
  /**
   * Stale-While-Revalidate window in milliseconds.
   * The server serves the old value for this duration after TTL expires
   * while refreshing in the background.
   */
  staleFor?: number;
}

export interface SemanticGetResult<T = JsonValue> {
  value: T;
  key: string;
  similarity: number;
  isExact: boolean;
}

export interface QueueEventHandlers<T = JsonValue> {
  onAdded?: (job: JobV2<T>) => void;
  onActive?: (job: JobV2<T>) => void;
  onCompleted?: (job: JobV2<T>) => void;
  onFailed?: (job: JobV2<T>) => void;
  onZombie?: (job: JobV2<T>) => void;
  onError?: (err: Error) => void;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ErixClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly transportMode: TransportMode;
  private transport: TransportLayer;

  constructor(options: ErixClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.transportMode = options.transport ?? "auto";
    this.headers = {
      "x-erix-key": options.apiKey,
      "x-tenant-id": options.tenantId,
      "Content-Type": "application/json",
    };

    // Initialize transport based on mode
    this.transport = this.createTransport();
  }

  /**
   * Create the appropriate transport based on the configured mode.
   * In "auto" mode, starts with WebSocket and falls back to HTTP on failure.
   */
  private createTransport(): TransportLayer {
    const httpTransport = new HttpTransport({
      baseUrl: this.baseUrl,
      headers: this.headers,
      timeoutMs: this.timeoutMs,
    });

    if (this.transportMode === "http") {
      return httpTransport;
    }

    // For "ws" and "auto" modes, create a WebSocket transport
    const wsUrl = this.baseUrl
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:");

    try {
      const wsTransport = new WebSocketTransport({
        url: wsUrl,
        headers: this.headers,
        timeoutMs: this.timeoutMs,
        reconnect: {
          initialDelayMs: 1000,
          maxDelayMs: 30000,
          backoffFactor: 2,
        },
      });

      if (this.transportMode === "ws") {
        return wsTransport;
      }

      // "auto" mode: use WebSocket with HTTP as fallback
      return new AutoTransport(wsTransport, httpTransport);
    } catch {
      // If WebSocket creation fails in "auto" mode, fall back to HTTP
      if (this.transportMode === "auto") {
        return httpTransport;
      }
      throw new Error(
        "[erix-store] Failed to create WebSocket transport in 'ws' mode",
      );
    }
  }

  // ── Internal fetch helper ─────────────────────────────────────────────

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    return this.transport.request(method, path, body, params) as Promise<T>;
  }

  /**
   * Execute multiple operations in a single round-trip (pipeline).
   * Over WebSocket, this sends all requests in one frame.
   * Over HTTP, requests are executed concurrently via Promise.all.
   */
  async pipeline(
    requests: Array<{
      method: string;
      path: string;
      body?: unknown;
      params?: Record<string, string>;
    }>,
  ): Promise<unknown[]> {
    return this.transport.pipeline(requests);
  }

  /**
   * Begin a new transaction.
   *
   * Returns a builder you can queue commands onto with `.cmd(name, ...args)`,
   * then send with `.exec()`. Every queued command runs atomically inside
   * a single event-loop tick on the server — no other client request can
   * interleave between them.
   *
   * Per-command failures are captured into the result array but do not
   * abort the batch (matching Redis MULTI/EXEC).
   *
   * @example
   * ```ts
   * const results = await client
   *   .multi()
   *   .cmd("SET", "k", "v")
   *   .cmd("EXPIRE", "k", 60)
   *   .cmd("GET", "k")
   *   .exec();
   * // → [{ ok: true, value: "OK" }, { ok: true, value: 1 }, { ok: true, value: "v" }]
   * ```
   */
  multi(): Transaction {
    return new Transaction(this);
  }

  /** Alias for {@link multi}. */
  tx(): Transaction {
    return this.multi();
  }

  /** @internal — called by Transaction.exec(). Keeps tx wire format private. */
  async _execTransaction(
    commands: TransactionCommand[],
  ): Promise<TransactionResult[]> {
    const res = await this.req<{ results: TransactionResult[] }>(
      "POST",
      "/tx/exec",
      { commands },
    );
    return res.results;
  }

  /**
   * Run a single Redis-style command synchronously.
   *
   * Lightweight escape hatch for verbs we have not surfaced as named
   * methods. Forwards the call through `/tx/exec` as a one-element
   * transaction and unwraps the per-command result.
   *
   * Throws on per-command errors (`WRONGTYPE`, unknown verb, validation)
   * so it composes naturally with `try`/`catch`. For multi-command
   * batches use {@link multi} instead — that surface keeps each command's
   * error isolated.
   *
   * @example
   * ```ts
   * const newLen = await client.cmd<number>("APPEND", "log", "entry");
   * const all = await client.cmd<Record<string,string>>("HGETALL", "user");
   * ```
   */
  async cmd<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const [result] = await this._execTransaction([{ name, args }]);
    if (!result.ok) {
      const err = new Error(
        `[erix-store] ${name}: ${result.error}`,
      ) as Error & {
        code?: string;
      };
      if (result.code) err.code = result.code;
      throw err;
    }
    return result.value as T;
  }

  /**
   * Close the transport and release resources.
   */
  close(): void {
    this.transport.close();
  }

  // ─── Health ───────────────────────────────────────────────────────────

  /** Check if the erix-store instance is reachable */
  async ping(): Promise<{ status: string; uptime: number }> {
    return this.req("GET", "/health");
  }

  // ─── Server Commands (Redis-style) ────────────────────────────────────

  public server = {
    /** Round-trip ping. Resolves to `true` on success. */
    ping: async (): Promise<boolean> => {
      const res = await this.req<{ pong: boolean }>("GET", "/server/ping");
      return res.pong === true;
    },
    /**
     * Server-wide info — version, memory, total keys, and a per-tenant
     * key breakdown for the calling tenant.
     */
    info: async (): Promise<{
      server: { version: string; node: string; uptime_seconds: number };
      memory: {
        rss: number;
        heap_used: number;
        heap_total: number;
        external: number;
        /** Approximate accounted bytes (not RSS). See server INFO docs. */
        used_memory: number;
        /** Configured cap; 0 = disabled. */
        maxmemory: number;
        maxmemory_policy: "noeviction" | "allkeys-lru" | "volatile-lru";
        evicted_keys: number;
      };
      keyspace: {
        total_keys: number;
        tenant: {
          id: string;
          keys: {
            string: number;
            hash: number;
            list: number;
            set: number;
            zset: number;
          };
        };
      };
    }> => {
      return this.req("GET", "/server/info");
    },
    /** Number of keys in the calling tenant's namespace. */
    dbsize: async (): Promise<number> => {
      const res = await this.req<{ size: number }>("GET", "/server/dbsize");
      return res.size;
    },
    /** Whether `key` exists in the calling tenant's namespace. */
    exists: async (key: string): Promise<boolean> => {
      const res = await this.req<{ exists: boolean }>(
        "GET",
        "/server/exists",
        undefined,
        { key },
      );
      return res.exists;
    },
    /** The data type of `key`, or `null` if it does not exist. */
    type: async (
      key: string,
    ): Promise<"string" | "hash" | "list" | "set" | "zset" | null> => {
      const res = await this.req<{
        type: "string" | "hash" | "list" | "set" | "zset" | null;
      }>("GET", "/server/type", undefined, { key });
      return res.type;
    },
    /**
     * List keys matching a glob pattern. Tenant-scoped — never returns
     * keys from other tenants. Default pattern `*` returns every key.
     *
     * Supported glob syntax: `*`, `?`, `[abc]`, `[^abc]`, `[a-z]`, `\\<char>`.
     */
    keys: async (pattern: string = "*"): Promise<string[]> => {
      const res = await this.req<{ keys: string[] }>(
        "GET",
        "/server/keys",
        undefined,
        { pattern },
      );
      return res.keys;
    },
    /**
     * Wipe every key in the calling tenant's namespace.
     * Returns the number of keys deleted. There is intentionally no
     * `flushall` — tenants cannot affect each other.
     */
    flushdb: async (): Promise<number> => {
      const res = await this.req<{ success: boolean; flushed: number }>(
        "POST",
        "/server/flushdb",
      );
      return res.flushed;
    },
    /**
     * Set a TTL (in seconds) on an existing key.
     * @returns true if the TTL was applied, false if the key didn't exist.
     */
    expire: async (key: string, ttlSeconds: number): Promise<boolean> => {
      const res = await this.req<{ applied: boolean }>(
        "POST",
        "/server/expire",
        {
          key,
          ttl: ttlSeconds,
        },
      );
      return res.applied;
    },
    /**
     * Remaining TTL in seconds. Redis convention:
     *   -2 → key does not exist
     *   -1 → key exists but has no TTL
     *   >0 → seconds remaining
     */
    ttl: async (key: string): Promise<number> => {
      const res = await this.req<{ ttl: number }>(
        "GET",
        "/server/ttl",
        undefined,
        { key },
      );
      return res.ttl;
    },
    /**
     * Remove the TTL from a key. Returns true if a TTL was removed,
     * false if the key did not exist or had no TTL.
     */
    persist: async (key: string): Promise<boolean> => {
      const res = await this.req<{ removed: boolean }>(
        "POST",
        "/server/persist",
        { key },
      );
      return res.removed;
    },
    /**
     * Read the slow-command log for the calling tenant. Newest entries
     * first. Pass `count` to cap the result.
     *
     * Each entry's `args` are truncated server-side (max 32 args, 128
     * chars each) so an MSET/HSET with a giant payload doesn't bloat
     * the log buffer.
     */
    slowlogGet: async (
      count: number = 128,
    ): Promise<
      Array<{
        id: number;
        timestamp: number;
        durationUs: number;
        command: string;
        args: string[];
        source: "single" | "transaction";
      }>
    > => {
      return this.cmd("SLOWLOG", "GET", count);
    },
    /** Number of slowlog entries currently stored for this tenant. */
    slowlogLen: async (): Promise<number> => {
      return this.cmd<number>("SLOWLOG", "LEN");
    },
    /** Drop this tenant's slowlog entries. Returns the number dropped. */
    slowlogReset: async (): Promise<number> => {
      return this.cmd<number>("SLOWLOG", "RESET");
    },
    /**
     * Read runtime tunables. Pass a glob pattern to filter; default `*`
     * returns every registered parameter.
     *
     * @example
     * const all = await client.server.configGet();
     * const memory = await client.server.configGet("max*");
     */
    configGet: async (
      pattern: string = "*",
    ): Promise<Array<{ name: string; value: string }>> => {
      return this.cmd<Array<{ name: string; value: string }>>(
        "CONFIG",
        "GET",
        pattern,
      );
    },
    /**
     * Update a runtime tunable.
     *
     * Server-side, this command is only accepted from the calling tenant
     * if it matches the server's `ERIX_ADMIN_TENANT_ID`. Other tenants
     * receive an error result. Resolves to `true` on success and throws
     * on failure (matching `client.cmd` semantics).
     */
    configSet: async (name: string, value: string | number): Promise<true> => {
      await this.cmd<"OK">("CONFIG", "SET", name, String(value));
      return true;
    },
    /**
     * Trigger a non-blocking snapshot save (admin tenant only).
     * Resolves immediately with the server's reply once the work is
     * dispatched — actual persistence happens in the background.
     */
    bgsave: async (): Promise<string> => {
      return this.cmd<string>("BGSAVE");
    },
    /**
     * Rewrite the AOF in place (admin tenant only).
     *
     * The server walks the live in-memory state and emits a compact
     * sequence of writes equivalent to it, then atomically replaces
     * the on-disk log. The verb is admin-gated because the rewrite
     * cost is bounded by the number of live keys.
     */
    bgrewriteaof: async (): Promise<string> => {
      return this.cmd<string>("BGREWRITEAOF");
    },
  };

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

  /**
   * Atomic increment. Creates the counter at 1 when missing.
   * Throws on non-integer values or overflow.
   */
  async incr(key: string): Promise<number> {
    return this.cmd<number>("INCR", key);
  }

  /** Atomic decrement. Creates the counter at -1 when missing. */
  async decr(key: string): Promise<number> {
    return this.cmd<number>("DECR", key);
  }

  /** Atomic increment by `delta`. */
  async incrBy(key: string, delta: number): Promise<number> {
    return this.cmd<number>("INCRBY", key, delta);
  }

  /** Atomic decrement by `delta`. */
  async decrBy(key: string, delta: number): Promise<number> {
    return this.cmd<number>("DECRBY", key, delta);
  }

  /** Append `value` to the existing string at `key`. Returns the new length. */
  async append(key: string, value: string): Promise<number> {
    return this.cmd<number>("APPEND", key, value);
  }

  /** Length of the string at `key`. 0 for missing keys. */
  async strlen(key: string): Promise<number> {
    return this.cmd<number>("STRLEN", key);
  }

  /**
   * Set multiple keys atomically. Either all writes succeed or none do
   * (e.g. on WRONGTYPE for any of the target keys). Clears any prior TTL.
   */
  async mset(entries: Record<string, JsonValue>): Promise<void> {
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(entries)) {
      args.push(k, JSON.stringify(v));
    }
    await this.cmd<"OK">("MSET", ...args);
  }

  /** Get multiple keys at once. Missing/non-string keys come back as `null`. */
  async mget<T = JsonValue>(keys: string[]): Promise<Array<T | null>> {
    const raw = await this.cmd<Array<string | null>>("MGET", ...keys);
    return raw.map((v) => {
      if (v === null) return null;
      try {
        return JSON.parse(v) as T;
      } catch {
        return v as unknown as T;
      }
    });
  }

  /**
   * Atomic compare-and-set: returns the previous value (or `null`) and
   * stores `value`. Clears any prior TTL.
   */
  async getSet<T = JsonValue>(
    key: string,
    value: JsonValue,
  ): Promise<T | null> {
    const prev = await this.cmd<string | null>(
      "GETSET",
      key,
      JSON.stringify(value),
    );
    if (prev === null) return null;
    try {
      return JSON.parse(prev) as T;
    } catch {
      return prev as unknown as T;
    }
  }

  /**
   * Set only if the key does not already exist. Returns true on success,
   * false when the key was already taken (any type — no WRONGTYPE).
   */
  async setNx(key: string, value: JsonValue): Promise<boolean> {
    const r = await this.cmd<number>("SETNX", key, JSON.stringify(value));
    return r === 1;
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
    /** Set multiple fields atomically (HMSET). */
    hmset: async (
      key: string,
      fields: Record<string, JsonValue>,
    ): Promise<void> => {
      const args: unknown[] = [key];
      for (const [f, v] of Object.entries(fields)) {
        args.push(f, JSON.stringify(v));
      }
      await this.cmd<"OK">("HMSET", ...args);
    },
    /** Get multiple fields at once. Missing fields return `null`. */
    hmget: async <T = JsonValue>(
      key: string,
      fields: string[],
    ): Promise<Array<T | null>> => {
      const raw = await this.cmd<Array<string | null>>("HMGET", key, ...fields);
      return raw.map((v) => {
        if (v === null) return null;
        try {
          return JSON.parse(v) as T;
        } catch {
          return v as unknown as T;
        }
      });
    },
    /** Whether `field` exists in the hash. */
    hexists: async (key: string, field: string): Promise<boolean> => {
      const r = await this.cmd<number>("HEXISTS", key, field);
      return r === 1;
    },
    /** All field names in the hash (no order guarantee). */
    hkeys: async (key: string): Promise<string[]> => {
      return this.cmd<string[]>("HKEYS", key);
    },
    /** All field values in the hash (no order guarantee). */
    hvals: async (key: string): Promise<string[]> => {
      return this.cmd<string[]>("HVALS", key);
    },
    /** Number of fields in the hash. */
    hlen: async (key: string): Promise<number> => {
      return this.cmd<number>("HLEN", key);
    },
    /** Delete one or more fields. Returns the count actually removed. */
    hdel: async (key: string, ...fields: string[]): Promise<number> => {
      return this.cmd<number>("HDEL", key, ...fields);
    },
    /**
     * Atomic increment of a hash field by `delta`. Creates the field
     * at `delta` when missing. Throws on non-integer values.
     */
    hincrBy: async (
      key: string,
      field: string,
      delta: number,
    ): Promise<number> => {
      return this.cmd<number>("HINCRBY", key, field, delta);
    },
  };

  // ─── List ─────────────────────────────────────────────────────────────

  public list = {
    /** Prepend a value to a list. Returns the new list length. */
    lpush: async (key: string, value: JsonValue): Promise<number> => {
      const res = await this.req<{ success: boolean; length: number }>(
        "POST",
        "/list/lpush",
        {
          key,
          value: JSON.stringify(value),
        },
      );
      return res.length;
    },
    /** Append a value to a list. Returns the new list length. */
    rpush: async (key: string, value: JsonValue): Promise<number> => {
      const res = await this.req<{ success: boolean; length: number }>(
        "POST",
        "/list/rpush",
        {
          key,
          value: JSON.stringify(value),
        },
      );
      return res.length;
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
    /** Pop from the right (LIFO back) */
    rpop: async <T = JsonValue>(key: string): Promise<T | null> => {
      const data = await this.req<{ value: string | null }>(
        "GET",
        "/list/rpop",
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
    /** List length. Returns 0 for missing keys. */
    llen: async (key: string): Promise<number> => {
      const data = await this.req<{ length: number }>(
        "GET",
        "/list/llen",
        undefined,
        { key },
      );
      return data.length;
    },
    /**
     * Element at `index` (negative indices count from the tail).
     * Returns `null` if out of bounds.
     */
    lindex: async <T = JsonValue>(
      key: string,
      index: number,
    ): Promise<T | null> => {
      const data = await this.req<{ value: string | null }>(
        "GET",
        "/list/lindex",
        undefined,
        { key, index: String(index) },
      );
      if (!data.value) return null;
      try {
        return JSON.parse(data.value) as T;
      } catch {
        return data.value as unknown as T;
      }
    },
    /**
     * Inclusive range from `start` to `stop`, supporting negative indices
     * (e.g. -1 = last element). Values stored as JSON are parsed; raw strings
     * pass through unchanged.
     */
    lrange: async <T = JsonValue>(
      key: string,
      start: number,
      stop: number,
    ): Promise<T[]> => {
      const data = await this.req<{ values: string[] }>(
        "GET",
        "/list/lrange",
        undefined,
        { key, start: String(start), stop: String(stop) },
      );
      return data.values.map((v) => {
        try {
          return JSON.parse(v) as T;
        } catch {
          return v as unknown as T;
        }
      });
    },
    /**
     * Remove up to `count` occurrences of `value`.
     *   count > 0 → remove from head
     *   count < 0 → remove from tail
     *   count = 0 → remove all
     * Returns the number of elements removed.
     */
    lrem: async (
      key: string,
      count: number,
      value: JsonValue,
    ): Promise<number> => {
      const data = await this.req<{ removed: number }>("POST", "/list/lrem", {
        key,
        count,
        value: JSON.stringify(value),
      });
      return data.removed;
    },
    /**
     * Trim the list to the inclusive range [start, stop].
     * Negative indices count from the tail. Drops the key if the range
     * leaves the list empty.
     */
    ltrim: async (key: string, start: number, stop: number): Promise<void> => {
      await this.req("POST", "/list/ltrim", { key, start, stop });
    },
  };

  // ─── Queue (FIFO job queue, built on List) ────────────────────────────

  public queue = {
    /**
     * Enqueue a value with optional priority. Higher priority dequeues first;
     * ties resolve FIFO.
     *
     * The value is JSON-serialized server-side; pass any JSON-compatible
     * shape and `dequeue` returns the parsed result.
     *
     * @returns the new queue length
     */
    enqueue: async (
      name: string,
      value: JsonValue,
      priority: number = 0,
    ): Promise<number> => {
      const res = await this.req<{ success: boolean; length: number }>(
        "POST",
        "/q/enqueue",
        { name, value: JSON.stringify(value), priority },
      );
      return res.length;
    },
    /**
     * Pop the highest-priority entry. Returns `null` when the queue is empty.
     */
    dequeue: async <T = JsonValue>(name: string): Promise<T | null> => {
      const res = await this.req<{ value: string | null }>(
        "POST",
        "/q/dequeue",
        { name },
      );
      if (res.value === null) return null;
      try {
        return JSON.parse(res.value) as T;
      } catch {
        return res.value as unknown as T;
      }
    },
    /** Inspect the next entry without removing it. */
    peek: async <T = JsonValue>(name: string): Promise<T | null> => {
      const res = await this.req<{ value: string | null }>(
        "GET",
        "/q/peek",
        undefined,
        { name },
      );
      if (res.value === null) return null;
      try {
        return JSON.parse(res.value) as T;
      } catch {
        return res.value as unknown as T;
      }
    },
    /** Number of entries in the queue. 0 for empty/missing queues. */
    len: async (name: string): Promise<number> => {
      const res = await this.req<{ length: number }>(
        "GET",
        "/q/len",
        undefined,
        { name },
      );
      return res.length;
    },
    /** Drop every entry. Returns the number cleared. */
    clear: async (name: string): Promise<number> => {
      const res = await this.req<{ success: boolean; cleared: number }>(
        "POST",
        "/q/clear",
        { name },
      );
      return res.cleared;
    },
    /**
     * Legacy push — kept for source compatibility with SDK 1.2.x. Forwards
     * to {@link enqueue} with priority 0. Prefer `enqueue` in new code.
     * @deprecated Use `enqueue` instead.
     */
    push: async (name: string, data: JsonValue): Promise<void> => {
      await this.req("POST", "/q/enqueue", {
        name,
        value: JSON.stringify(data),
        priority: 0,
      });
    },
    /**
     * Legacy pop — kept for source compatibility with SDK 1.2.x. Forwards
     * to {@link dequeue}. Prefer `dequeue` in new code.
     * @deprecated Use `dequeue` instead.
     */
    pop: async <T = JsonValue>(name: string): Promise<T | null> => {
      return this.queue.dequeue<T>(name);
    },
  };

  /** Advanced Queue (v2) — supports priority, delay, retries, heartbeat, and SSE push */
  public queueV2 = {
    /** Enqueue a job into an advanced queue */
    push: async <T = JsonValue>(
      queueName: string,
      data: T,
      options: EnqueueOptionsV2 = {},
    ): Promise<JobV2<T>> => {
      const res = await this.req<{ success: boolean; job: JobV2<T> }>(
        "POST",
        `/queue/v2/${queueName}/jobs`,
        { data, ...options },
      );
      return res.job;
    },
    /** Claim the next eligible job from the queue */
    claim: async <T = JsonValue>(
      queueName: string,
    ): Promise<JobV2<T> | null> => {
      const res = await this.req<{ success: boolean; job: JobV2<T> | null }>(
        "POST",
        `/queue/v2/${queueName}/claim`,
      );
      return res.job;
    },
    /** Mark a job as completed */
    complete: async (jobId: string, result?: JsonValue): Promise<void> => {
      await this.req("POST", `/queue/v2/jobs/${jobId}/complete`, { result });
    },
    /** Mark a job as failed */
    fail: async (jobId: string, error: string): Promise<void> => {
      await this.req("POST", `/queue/v2/jobs/${jobId}/fail`, { error });
    },
    /** Update job progress (0-100) */
    updateProgress: async (jobId: string, progress: number): Promise<void> => {
      await this.req("PATCH", `/queue/v2/jobs/${jobId}/progress`, { progress });
    },
    /**
     * Send a worker heartbeat to keep the job alive in the reaper.
     * Call every 15–30 seconds from inside a long-running job handler.
     * If silent for 60s the reaper will fail and requeue the job.
     */
    heartbeat: async (jobId: string): Promise<void> => {
      await this.req("PATCH", `/queue/v2/jobs/${jobId}/heartbeat`);
    },
    /** Get job by ID */
    get: async <T = JsonValue>(jobId: string): Promise<JobV2<T> | null> => {
      const res = await this.req<{ success: boolean; job: JobV2<T> | null }>(
        "GET",
        `/queue/v2/jobs/${jobId}`,
      );
      return res.job;
    },
    /**
     * Subscribe to queue events via Server-Sent Events.
     * Returns an EventSource-like object — call `.close()` to unsubscribe.
     *
     * Workers should use this instead of polling `claim()` on an interval.
     * On `job:added` or `job:active` events, call `claim()` to get the job.
     *
     * @example
     * const sub = client.queueV2.subscribe('crm', {
     *   onAdded: () => processNextJob(),
     *   onError: (e) => console.error(e),
     * });
     * // later:
     * sub.close();
     */
    subscribe: <T = JsonValue>(
      queueName: string,
      handlers: QueueEventHandlers<T>,
    ): { close: () => void } => {
      return this.openEventStream(
        `/queue/v2/${queueName}/events`,
        (event, data) => {
          const job = data as JobV2<T>;
          if (event === "job:added") handlers.onAdded?.(job);
          else if (event === "job:active") handlers.onActive?.(job);
          else if (event === "job:completed") handlers.onCompleted?.(job);
          else if (event === "job:failed") handlers.onFailed?.(job);
          else if (event === "job:zombie") handlers.onZombie?.(job);
        },
        handlers.onError,
      );
    },
  };

  // ─── PubSub ───────────────────────────────────────────────────────────

  public pubsub = {
    /**
     * Publish a message to a channel.
     * @returns the number of subscribers that received the message
     *          (exact + pattern combined).
     */
    publish: async (channel: string, message: JsonValue): Promise<number> => {
      const res = await this.req<{ success: boolean; delivered: number }>(
        "POST",
        "/pubsub/publish",
        { channel, message },
      );
      return res.delivered;
    },
    /**
     * Subscribe to a pub/sub channel via Server-Sent Events.
     * Returns a controller with a `.close()` method.
     *
     * @example
     * const sub = client.pubsub.subscribe('alerts', (msg) => console.log(msg));
     * sub.close(); // unsubscribe
     */
    subscribe: (
      channel: string,
      onMessage: (message: JsonValue) => void,
      onError?: (err: Error) => void,
    ): { close: () => void } => {
      return this.openEventStream(
        `/pubsub/${encodeURIComponent(channel)}/stream`,
        (_event, data) => onMessage(data as JsonValue),
        onError,
      );
    },
    /**
     * Pattern subscribe (PSUBSCRIBE). The handler is invoked once per
     * message, with the matched channel name (tenant prefix stripped).
     *
     * Supports the same glob syntax as `client.server.keys`:
     * `*`, `?`, `[abc]`, `[^abc]`, `[a-z]`, `\\<char>`.
     *
     * @example
     * const sub = client.pubsub.psubscribe("alerts:*", (msg, channel) => {
     *   console.log(`[${channel}]`, msg);
     * });
     * sub.close();
     */
    psubscribe: (
      pattern: string,
      onMessage: (message: JsonValue, channel: string) => void,
      onError?: (err: Error) => void,
    ): { close: () => void } => {
      return this.openEventStream(
        `/pubsub/p/${encodeURIComponent(pattern)}/stream`,
        (_event, data) => {
          const payload = data as { channel: string; message: JsonValue };
          onMessage(payload.message, payload.channel);
        },
        onError,
      );
    },
    /**
     * List exact-subscriber channels in this tenant's namespace,
     * optionally filtered by a glob pattern (default `*`).
     */
    channels: async (pattern: string = "*"): Promise<string[]> => {
      const res = await this.req<{ channels: string[] }>(
        "GET",
        "/pubsub/channels",
        undefined,
        { pattern },
      );
      return res.channels;
    },
    /** Per-channel exact-subscriber counts (0 for channels with none). */
    numsub: async (channels: string[]): Promise<Record<string, number>> => {
      const res = await this.req<{ counts: Record<string, number> }>(
        "POST",
        "/pubsub/numsub",
        { channels },
      );
      return res.counts;
    },
    /** Number of distinct active patterns (server-wide; matches Redis). */
    numpat: async (): Promise<number> => {
      const res = await this.req<{ count: number }>("GET", "/pubsub/numpat");
      return res.count;
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
    /** Remove one or more members. Returns the count actually removed. */
    srem: async (key: string, ...members: string[]): Promise<number> => {
      return this.cmd<number>("SREM", key, ...members);
    },
    /** Whether `member` is in the set. */
    sismember: async (key: string, member: string): Promise<boolean> => {
      const r = await this.cmd<number>("SISMEMBER", key, member);
      return r === 1;
    },
    /** Number of members in the set. */
    scard: async (key: string): Promise<number> => {
      return this.cmd<number>("SCARD", key);
    },
    /** Intersection across the supplied sets. */
    sinter: async (...keys: string[]): Promise<string[]> => {
      return this.cmd<string[]>("SINTER", ...keys);
    },
    /** Union across the supplied sets. */
    sunion: async (...keys: string[]): Promise<string[]> => {
      return this.cmd<string[]>("SUNION", ...keys);
    },
    /** Members in the first set that are not in any of the others. */
    sdiff: async (...keys: string[]): Promise<string[]> => {
      return this.cmd<string[]>("SDIFF", ...keys);
    },
  };

  // ─── Sorted Set ───────────────────────────────────────────────────────

  public zset = {
    /** Add or update a member's score. Returns the count of newly added members. */
    zadd: async (
      key: string,
      score: number,
      member: string,
    ): Promise<number> => {
      return this.cmd<number>("ZADD", key, score, member);
    },
    /** Inclusive range by 0-based rank (lowest score first). Negative indices supported. */
    zrange: async (
      key: string,
      start: number,
      stop: number,
    ): Promise<string[]> => {
      return this.cmd<string[]>("ZRANGE", key, start, stop);
    },
    /** Same as zrange but in descending score order. */
    zrevrange: async (
      key: string,
      start: number,
      stop: number,
    ): Promise<string[]> => {
      return this.cmd<string[]>("ZREVRANGE", key, start, stop);
    },
    /** Members whose score is in [min, max], ascending. */
    zrangeByScore: async (
      key: string,
      min: number,
      max: number,
    ): Promise<string[]> => {
      return this.cmd<string[]>("ZRANGEBYSCORE", key, min, max);
    },
    /** Score for a member; `null` if missing. */
    zscore: async (key: string, member: string): Promise<number | null> => {
      return this.cmd<number | null>("ZSCORE", key, member);
    },
    /** 0-based rank of `member`; `null` if missing. */
    zrank: async (key: string, member: string): Promise<number | null> => {
      return this.cmd<number | null>("ZRANK", key, member);
    },
    /** Number of members in the sorted set. */
    zcard: async (key: string): Promise<number> => {
      return this.cmd<number>("ZCARD", key);
    },
    /** Number of members whose score is in [min, max]. */
    zcount: async (key: string, min: number, max: number): Promise<number> => {
      return this.cmd<number>("ZCOUNT", key, min, max);
    },
    /** Increment a member's score by `delta`. Returns the new score. */
    zincrBy: async (
      key: string,
      delta: number,
      member: string,
    ): Promise<number> => {
      return this.cmd<number>("ZINCRBY", key, delta, member);
    },
    /** Remove one or more members. Returns the count actually removed. */
    zrem: async (key: string, ...members: string[]): Promise<number> => {
      return this.cmd<number>("ZREM", key, ...members);
    },
  };

  // ─── Cache (advanced) ────────────────────────────────────────────────

  public cache = {
    /** Get a cached value */
    get: async <T = JsonValue>(key: string): Promise<T | null> => {
      try {
        const res = await this.req<{ success: boolean; value: T }>(
          "GET",
          `/cache/${encodeURIComponent(key)}`,
        );
        return res.value ?? null;
      } catch {
        return null;
      }
    },
    /** Set a cached value with optional TTL, tags, and stale-while-revalidate */
    set: async (
      key: string,
      value: JsonValue,
      options: CacheSetOptions = {},
    ): Promise<void> => {
      await this.req("POST", `/cache/${encodeURIComponent(key)}`, {
        value,
        ...options,
      });
    },
    /** Delete a cached key */
    del: async (key: string): Promise<void> => {
      await this.req("DELETE", `/cache/${encodeURIComponent(key)}`);
    },
    /** Invalidate all keys with a specific tag */
    invalidateByTag: async (tag: string): Promise<number> => {
      const res = await this.req<{ success: boolean; count: number }>(
        "DELETE",
        `/cache/tags/${encodeURIComponent(tag)}`,
      );
      return res.count;
    },
    /** Invalidate all keys matching multiple tags */
    invalidateByTags: async (tags: string[]): Promise<number> => {
      const res = await this.req<{ success: boolean; count: number }>(
        "POST",
        "/cache/tags/invalidate",
        { tags },
      );
      return res.count;
    },
    /** Get cache statistics (hit rate, size, evictions) */
    stats: async () => {
      const res = await this.req<{ success: boolean; stats: unknown }>(
        "GET",
        "/cache/_stats",
      );
      return res.stats;
    },
  };

  // ─── Semantic Cache (AI layer) ────────────────────────────────────────

  public semantic = {
    /**
     * Store a value with its embedding for similarity lookups.
     * @param key    Unique cache key
     * @param text   Text to embed (the query/question this entry answers)
     * @param value  The value to cache
     * @param ttlMs  Optional TTL in milliseconds
     * @param tags   Optional tags for bulk invalidation
     */
    set: async (
      key: string,
      text: string,
      value: JsonValue,
      ttlMs?: number,
      tags?: string[],
    ): Promise<void> => {
      await this.req("POST", `/semantic/${encodeURIComponent(key)}`, {
        text,
        value,
        ttlMs,
        tags,
      });
    },
    /**
     * Exact key lookup in semantic cache.
     */
    get: async <T = JsonValue>(key: string): Promise<T | null> => {
      try {
        const res = await this.req<{ success: boolean; value: T }>(
          "GET",
          `/semantic/${encodeURIComponent(key)}`,
        );
        return res.value ?? null;
      } catch {
        return null;
      }
    },
    /**
     * Find the most similar cached entry to a query string.
     * Returns null if no entry exceeds the similarity threshold.
     *
     * @example
     * // Stored: "What are your pricing plans?" → { starter: '$29', pro: '$99' }
     * // Query:  "How much does it cost?"
     * const result = await client.semantic.search("How much does it cost?");
     * // → { value: {...}, similarity: 0.97, isExact: false }
     */
    search: async <T = JsonValue>(
      query: string,
      threshold?: number,
    ): Promise<SemanticGetResult<T> | null> => {
      try {
        const res = await this.req<SemanticGetResult<T> & { success: boolean }>(
          "POST",
          "/semantic/search",
          { query, threshold },
        );
        return res;
      } catch {
        return null;
      }
    },
    /** Invalidate all semantic cache entries with a specific tag */
    invalidateByTag: async (tag: string): Promise<number> => {
      const res = await this.req<{ success: boolean; count: number }>(
        "DELETE",
        `/semantic/tags/${encodeURIComponent(tag)}`,
      );
      return res.count;
    },
    /** Delete a single semantic cache entry */
    del: async (key: string): Promise<void> => {
      await this.req("DELETE", `/semantic/${encodeURIComponent(key)}`);
    },
    /** Get semantic cache stats */
    stats: async () => {
      return this.req<{ success: boolean; size: number; keys: string[] }>(
        "GET",
        "/semantic/_stats",
      );
    },
  };

  // ─── Analytics ────────────────────────────────────────────────────────

  public analytics = {
    /**
     * Get live usage counts for this tenant (from in-memory buffer).
     * Updated in real time — no waiting for the 10s DB flush.
     */
    usage: async (): Promise<Record<string, number>> => {
      const res = await this.req<{
        success: boolean;
        usage: Record<string, number>;
      }>("GET", "/analytics/usage");
      return res.usage;
    },
    /**
     * Get anomaly detector stats — mean, stddev, and sample count
     * for each monitored metric of this tenant.
     */
    anomalies: async () => {
      return this.req<{
        success: boolean;
        metrics: Array<{
          metric: string;
          mean: number;
          stddev: number;
          n: number;
        }>;
      }>("GET", "/analytics/anomalies");
    },
    /**
     * Subscribe to real-time anomaly alerts via SSE.
     * The server fires an event whenever a metric exceeds 3σ.
     *
     * @example
     * const sub = client.analytics.subscribeAlerts((alert) => {
     *   console.log(`ALERT: ${alert.message}`);
     * });
     * sub.close();
     */
    subscribeAlerts: (
      onAlert: (alert: {
        metric: string;
        current: number;
        mean: number;
        zScore: number;
        message: string;
      }) => void,
      onError?: (err: Error) => void,
    ): { close: () => void } => {
      return this.openEventStream(
        "/analytics/anomalies/stream",
        (_event, data) => onAlert(data as Parameters<typeof onAlert>[0]),
        onError,
      );
    },
  };

  // ─── Internal SSE helper ─────────────────────────────────────────────

  /**
   * Opens a persistent SSE connection and dispatches named events to a handler.
   * Returns a controller with `.close()` to terminate the connection.
   *
   * Uses native fetch with a ReadableStream reader — works in Node 18+.
   */
  private openEventStream(
    path: string,
    onEvent: (event: string, data: unknown) => void,
    onError?: (err: Error) => void,
  ): { close: () => void } {
    const controller = new AbortController();
    const url = `${this.baseUrl}${path}`;

    const run = async () => {
      try {
        const res = await fetch(url, {
          headers: this.headers,
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(
            `[erix-store] SSE ${path} → ${res.status}: ${res.statusText}`,
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "message";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                onEvent(currentEvent, data);
              } catch {
                // non-JSON data line, skip
              }
              currentEvent = "message";
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };

    run();
    return { close: () => controller.abort() };
  }
}

// ─── Transactions ──────────────────────────────────────────────────────────

/** Wire shape for a single command inside a transaction. */
export interface TransactionCommand {
  /** Verb name, case-insensitive. */
  name: string;
  /** Positional arguments, mostly mirroring Redis's argument order. */
  args: unknown[];
}

/** Result of a single command — `ok: true` carries the return value. */
export type TransactionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code?: string };

/**
 * Builder returned by {@link ErixClient.multi}.
 *
 * Chain `.cmd(name, ...args)` for each command, then `.exec()` to run
 * them atomically server-side, or `.discard()` to drop the batch
 * locally without sending a request.
 */
export class Transaction {
  private commands: TransactionCommand[] = [];
  private finalized = false;

  constructor(private readonly client: ErixClient) {}

  /** Number of commands queued. */
  get size(): number {
    return this.commands.length;
  }

  /**
   * Queue a command. Returns `this` for chaining.
   *
   * The verb is validated server-side; unknown verbs come back as a
   * per-command error in the result array, not a thrown exception.
   */
  cmd(name: string, ...args: unknown[]): this {
    if (this.finalized) {
      throw new Error(
        "[erix-store] Transaction already finalized — create a new one with client.multi()",
      );
    }
    this.commands.push({ name, args });
    return this;
  }

  /** Drop the queued commands locally. No server request is issued. */
  discard(): void {
    this.finalized = true;
    this.commands = [];
  }

  /**
   * Send the queued commands to the server and run them atomically.
   *
   * Per-command errors are captured into the result array; the call as
   * a whole still resolves successfully unless the network or auth
   * layer fails.
   */
  async exec(): Promise<TransactionResult[]> {
    if (this.finalized) {
      throw new Error("[erix-store] Transaction already finalized");
    }
    this.finalized = true;
    return this.client._execTransaction(this.commands);
  }
}

// ─── AutoTransport (internal) ────────────────────────────────────────────

/**
 * Internal transport that tries WebSocket first and falls back to HTTP
 * if the WebSocket is not connected. Used in "auto" mode.
 */
class AutoTransport implements TransportLayer {
  constructor(
    private readonly ws: WebSocketTransport,
    private readonly http: HttpTransport,
  ) {}

  get isConnected(): boolean {
    return this.ws.isConnected || this.http.isConnected;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<unknown> {
    // If WebSocket is connected, use it
    if (this.ws.isConnected) {
      try {
        return await this.ws.request(method, path, body, params);
      } catch {
        // Fall back to HTTP on WebSocket failure
        return this.http.request(method, path, body, params);
      }
    }
    // Otherwise use HTTP
    return this.http.request(method, path, body, params);
  }

  async pipeline(
    requests: Array<{
      method: string;
      path: string;
      body?: unknown;
      params?: Record<string, string>;
    }>,
  ): Promise<unknown[]> {
    if (this.ws.isConnected) {
      try {
        return await this.ws.pipeline(requests);
      } catch {
        return this.http.pipeline(requests);
      }
    }
    return this.http.pipeline(requests);
  }

  close(): void {
    this.ws.close();
    this.http.close();
  }
}
