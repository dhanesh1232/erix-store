/**
 * @file commands.ts
 * @module Server/Commands
 *
 * Synchronous command dispatcher.
 *
 * Why this file exists
 * --------------------
 * MULTI/EXEC needs to execute every command in a transaction inside the
 * same event-loop tick — that's the only way to keep other clients from
 * sneaking requests in between commands on a single-threaded server.
 *
 * Going through the Express stack would defeat that: Express's JSON body
 * parser uses streaming `data`/`end` events that resolve via
 * `process.nextTick`, so any POST command would yield to the microtask
 * queue.
 *
 * `CommandDispatcher` skips that path. It maps command verbs straight
 * to synchronous methods on the in-memory services. Verbs are registered
 * once at boot; the dispatcher is shared by `/tx/exec` and is positioned
 * to power any future RESP-style verb surface.
 *
 * Tenant isolation
 * ----------------
 * The dispatcher only ever sees the tenant ID supplied by the calling
 * route. Per-key tenant prefixing happens here, in one place, so a
 * transaction cannot leak across tenants even if a future caller forgets
 * to scope the inputs.
 *
 * @requirements P1.2 — MULTI/EXEC/DISCARD
 */

import { OOMError, WrongTypeError } from "../core/errors.js";
import type { ErixStore } from "../core/Store.js";
import type { AofLog } from "../services/AofLog.js";
import { MUTATING_VERBS, aofRewriteEntries } from "../services/aofWriters.js";
import type { ConfigRegistry } from "../services/ConfigRegistry.js";
import type { PriorityQueue } from "../services/PriorityQueue.js";
import type { PubSubService } from "../services/PubSub.js";
import type { SlowLog, SlowLogEntry } from "../services/SlowLog.js";
import { getTenantKey } from "./middleware/auth.js";

/** A single command issued inside (or outside) a transaction. */
export interface Command {
  /** Verb name, case-insensitive. e.g. "SET", "lpush", "ZADD". */
  name: string;
  /** Positional arguments. Most match standard command argument order. */
  args: unknown[];
}

/** The result of a command. `error` is set when the command failed. */
export type CommandResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code?: string };

/** Dependencies the dispatcher needs to do its job. */
export interface DispatcherDeps {
  store: ErixStore;
  queue?: PriorityQueue;
  pubsub?: PubSubService;
  slowlog?: SlowLog;
  /** Runtime-tunable parameter catalog. Powers CONFIG GET/SET. */
  config?: ConfigRegistry;
  /**
   * Tenant ID authorised to mutate config (CONFIG SET, BGSAVE).
   * Undefined means CONFIG SET is denied for everyone — the safe default
   * for multi-tenant deployments where no admin tenant is configured.
   */
  adminTenantId?: string;
  /**
   * Optional async snapshot trigger. When provided, BGSAVE fires it and
   * returns immediately. Errors from the snapshot are logged but don't
   * fail BGSAVE — standard background-save behaviour.
   */
  bgsave?: () => Promise<void> | void;
  /**
   * Append-only command log. When wired in, every mutating verb is
   * appended (post-success) before the dispatcher returns. Reads and
   * ephemeral verbs (PUBLISH, SLOWLOG, CONFIG, BGSAVE, BGREWRITEAOF)
   * are excluded — see {@link MUTATING_VERBS}.
   */
  aof?: AofLog;
}

/** Signature of an individual verb handler. */
type Handler = (
  deps: DispatcherDeps,
  tenantId: string,
  args: unknown[],
) => unknown;

// ─── Argument helpers ─────────────────────────────────────────────────────────
//
// Tiny coercion functions with explicit error messages. We accept shapes that
// a client would send (numeric strings) so a transaction body coming over JSON
// doesn't have to know whether the underlying type is number or string.

function expectArgs(name: string, args: unknown[], count: number): void {
  if (args.length !== count) {
    throw new Error(
      `wrong number of arguments for '${name.toLowerCase()}' (expected ${count}, got ${args.length})`,
    );
  }
}

function expectArgsRange(
  name: string,
  args: unknown[],
  min: number,
  max: number,
): void {
  if (args.length < min || args.length > max) {
    throw new Error(
      `wrong number of arguments for '${name.toLowerCase()}' (expected ${min}-${max}, got ${args.length})`,
    );
  }
}

function asString(arg: unknown, label: string): string {
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  throw new Error(`${label} must be a string`);
}

function asInt(arg: unknown, label: string): number {
  const n = typeof arg === "number" ? arg : Number(arg);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${label} must be an integer`);
  }
  return n;
}

function asNumber(arg: unknown, label: string): number {
  const n = typeof arg === "number" ? arg : Number(arg);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a number`);
  }
  return n;
}

// ─── Verb registry ────────────────────────────────────────────────────────────

const HANDLERS: Record<string, Handler> = {};

function register(verb: string, handler: Handler): void {
  HANDLERS[verb.toUpperCase()] = handler;
}

// ── Server ────────────────────────────────────────────────────────────────────

register("PING", (_deps, _tenantId, args) => {
  // PING                → "PONG"
  // PING message        → message
  if (args.length === 0) return "PONG";
  if (args.length === 1) return asString(args[0], "message");
  throw new Error("wrong number of arguments for 'ping'");
});

register("EXISTS", (deps, tenantId, args) => {
  expectArgs("EXISTS", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  return deps.store.types.getType(k) !== null ? 1 : 0;
});

register("TYPE", (deps, tenantId, args) => {
  expectArgs("TYPE", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  return deps.store.types.getType(k);
});

register("EXPIRE", (deps, tenantId, args) => {
  expectArgs("EXPIRE", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  const ttl = asInt(args[1], "seconds");
  if (ttl <= 0) throw new Error("seconds must be a positive integer");
  if (deps.store.isExpired(k) || deps.store.types.getType(k) === null) {
    return 0;
  }
  deps.store.ttlManager.set(k, ttl);
  return 1;
});

register("TTL", (deps, tenantId, args) => {
  expectArgs("TTL", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k) || deps.store.types.getType(k) === null) {
    return -2;
  }
  return deps.store.ttlManager.getTTL(k);
});

register("PERSIST", (deps, tenantId, args) => {
  expectArgs("PERSIST", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k) || deps.store.types.getType(k) === null) {
    return 0;
  }
  return deps.store.ttlManager.persist(k) ? 1 : 0;
});

register("FLUSHDB", (deps, tenantId, args) => {
  expectArgs("FLUSHDB", args, 0);
  return deps.store.flushTenant(tenantId);
});

register("DEL", (deps, tenantId, args) => {
  expectArgsRange("DEL", args, 1, Number.POSITIVE_INFINITY);
  let count = 0;
  for (const a of args) {
    const k = getTenantKey(tenantId, asString(a, "key"));
    if (deps.store.deleteKey(k)) count++;
  }
  return count;
});

// ── Strings ───────────────────────────────────────────────────────────────────

register("SET", (deps, tenantId, args) => {
  // Minimal subset of SET: SET key value [EX seconds]
  if (args.length !== 2 && args.length !== 4) {
    throw new Error("wrong number of arguments for 'set'");
  }
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  const v = asString(args[1], "value");
  let ttl: number | null = null;
  if (args.length === 4) {
    const opt = asString(args[2], "option").toUpperCase();
    if (opt !== "EX") throw new Error(`unsupported SET option: ${opt}`);
    ttl = asInt(args[3], "seconds");
    if (ttl <= 0) throw new Error("seconds must be a positive integer");
  }
  deps.store.reserveKey(k, "string");
  deps.store.strings.set(k, v);
  if (ttl !== null) deps.store.ttlManager.set(k, ttl);
  else deps.store.ttlManager.delete(k);
  return "OK";
});

register("GET", (deps, tenantId, args) => {
  expectArgs("GET", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  deps.store.types.assertType(k, "string");
  return deps.store.strings.get(k);
});

// String mutation helpers shared by INCR / DECR / INCRBY / DECRBY.
function incrBy(
  deps: DispatcherDeps,
  tenantId: string,
  rawKey: string,
  delta: number,
): number {
  const k = getTenantKey(tenantId, rawKey);
  // Lazy expiry first — an expired numeric counter must reset, not WRONGTYPE.
  deps.store.isExpired(k);
  deps.store.types.assertType(k, "string");
  const existing = deps.store.strings.get(k);
  const current = existing === null ? 0 : Number(existing);
  if (
    existing !== null &&
    (!Number.isFinite(current) || !Number.isInteger(current))
  ) {
    throw new Error("value is not an integer or out of range");
  }
  const next = current + delta;
  if (!Number.isSafeInteger(next)) {
    throw new Error("increment would overflow safe integer range");
  }
  deps.store.types.register(k, "string");
  deps.store.strings.set(k, String(next));
  return next;
}

register("INCR", (deps, tenantId, args) => {
  expectArgs("INCR", args, 1);
  return incrBy(deps, tenantId, asString(args[0], "key"), 1);
});

register("DECR", (deps, tenantId, args) => {
  expectArgs("DECR", args, 1);
  return incrBy(deps, tenantId, asString(args[0], "key"), -1);
});

register("INCRBY", (deps, tenantId, args) => {
  expectArgs("INCRBY", args, 2);
  return incrBy(
    deps,
    tenantId,
    asString(args[0], "key"),
    asInt(args[1], "increment"),
  );
});

register("DECRBY", (deps, tenantId, args) => {
  expectArgs("DECRBY", args, 2);
  return incrBy(
    deps,
    tenantId,
    asString(args[0], "key"),
    -asInt(args[1], "decrement"),
  );
});

register("APPEND", (deps, tenantId, args) => {
  expectArgs("APPEND", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  const v = asString(args[1], "value");
  deps.store.reserveKey(k, "string");
  return deps.store.strings.append(k, v);
});

register("STRLEN", (deps, tenantId, args) => {
  expectArgs("STRLEN", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "string");
  return deps.store.strings.get(k)?.length ?? 0;
});

register("MSET", (deps, tenantId, args) => {
  // MSET key1 val1 [key2 val2 ...]
  if (args.length < 2 || args.length % 2 !== 0) {
    throw new Error("wrong number of arguments for 'mset'");
  }
  const tenantKeys: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    tenantKeys.push(getTenantKey(tenantId, asString(args[i], "key")));
    values.push(asString(args[i + 1], "value"));
  }
  // Pre-flight: every key must be either unbound or already a string.
  // MSET is documented as atomic; we mirror that — no partial writes.
  for (const tk of tenantKeys) {
    deps.store.isExpired(tk); // lazy clean before the type check
    deps.store.types.assertType(tk, "string");
  }
  for (let i = 0; i < tenantKeys.length; i++) {
    deps.store.types.register(tenantKeys[i], "string");
    deps.store.strings.set(tenantKeys[i], values[i]);
    deps.store.ttlManager.delete(tenantKeys[i]); // SET semantics: clears any prior TTL
  }
  return "OK";
});

register("MGET", (deps, tenantId, args) => {
  expectArgsRange("MGET", args, 1, Number.POSITIVE_INFINITY);
  const out: Array<string | null> = new Array(args.length);
  for (let i = 0; i < args.length; i++) {
    const k = getTenantKey(tenantId, asString(args[i], "key"));
    if (deps.store.isExpired(k) || deps.store.types.getType(k) !== "string") {
      out[i] = null;
      continue;
    }
    out[i] = deps.store.strings.get(k);
  }
  return out;
});

register("GETSET", (deps, tenantId, args) => {
  expectArgs("GETSET", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  const v = asString(args[1], "value");
  // Type check first (pre-existing non-string is a WRONGTYPE).
  deps.store.isExpired(k);
  deps.store.types.assertType(k, "string");
  const previous = deps.store.strings.get(k);
  deps.store.types.register(k, "string");
  deps.store.strings.set(k, v);
  deps.store.ttlManager.delete(k); // SET semantics
  return previous;
});

register("SETNX", (deps, tenantId, args) => {
  // SET if Not eXists. Does NOT WRONGTYPE on existing non-string keys —
  // it just fails to set and returns 0, matching expected behaviour.
  expectArgs("SETNX", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  const v = asString(args[1], "value");
  deps.store.isExpired(k);
  if (deps.store.types.getType(k) !== null) return 0;
  deps.store.types.register(k, "string");
  deps.store.strings.set(k, v);
  return 1;
});

// ── Hashes ────────────────────────────────────────────────────────────────────

register("HSET", (deps, tenantId, args) => {
  // HSET allows HSET key field1 value1 [field2 value2 ...].
  if (args.length < 3 || (args.length - 1) % 2 !== 0) {
    throw new Error("wrong number of arguments for 'hset'");
  }
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  deps.store.reserveKey(k, "hash");
  let added = 0;
  for (let i = 1; i < args.length; i += 2) {
    const field = asString(args[i], "field");
    const value = asString(args[i + 1], "value");
    const existed = deps.store.hashes.hget(k, field) !== null;
    deps.store.hashes.hset(k, field, value);
    if (!existed) added++;
  }
  return added;
});

register("HGET", (deps, tenantId, args) => {
  expectArgs("HGET", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  deps.store.types.assertType(k, "hash");
  return deps.store.hashes.hget(k, asString(args[1], "field"));
});

register("HGETALL", (deps, tenantId, args) => {
  expectArgs("HGETALL", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  deps.store.types.assertType(k, "hash");
  return deps.store.hashes.hgetall(k);
});

register("HDEL", (deps, tenantId, args) => {
  expectArgsRange("HDEL", args, 2, Number.POSITIVE_INFINITY);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "hash");
  let removed = 0;
  for (let i = 1; i < args.length; i++) {
    const field = asString(args[i], "field");
    if (deps.store.hashes.hget(k, field) !== null) {
      deps.store.hashes.hdel(k, field);
      removed++;
    }
  }
  // hdel may have drained the hash — keep registry in sync.
  if (deps.store.hashes.hgetall(k) === null) {
    deps.store.types.unregister(k);
  }
  return removed;
});

register("HMSET", (deps, tenantId, args) => {
  // Legacy verb; deprecated but still expected by clients.
  if (args.length < 3 || (args.length - 1) % 2 !== 0) {
    throw new Error("wrong number of arguments for 'hmset'");
  }
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  deps.store.reserveKey(k, "hash");
  for (let i = 1; i < args.length; i += 2) {
    deps.store.hashes.hset(
      k,
      asString(args[i], "field"),
      asString(args[i + 1], "value"),
    );
  }
  return "OK";
});

register("HMGET", (deps, tenantId, args) => {
  expectArgsRange("HMGET", args, 2, Number.POSITIVE_INFINITY);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  // For a missing or expired key, every field returns null.
  const exists =
    !deps.store.isExpired(k) && deps.store.types.getType(k) !== null;
  if (exists) deps.store.types.assertType(k, "hash");
  const out: Array<string | null> = new Array(args.length - 1);
  for (let i = 1; i < args.length; i++) {
    out[i - 1] = exists
      ? deps.store.hashes.hget(k, asString(args[i], "field"))
      : null;
  }
  return out;
});

register("HEXISTS", (deps, tenantId, args) => {
  expectArgs("HEXISTS", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "hash");
  return deps.store.hashes.hexists(k, asString(args[1], "field")) ? 1 : 0;
});

register("HKEYS", (deps, tenantId, args) => {
  expectArgs("HKEYS", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return [];
  if (deps.store.types.getType(k) === null) return [];
  deps.store.types.assertType(k, "hash");
  return deps.store.hashes.hkeys(k);
});

register("HVALS", (deps, tenantId, args) => {
  expectArgs("HVALS", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return [];
  if (deps.store.types.getType(k) === null) return [];
  deps.store.types.assertType(k, "hash");
  return deps.store.hashes.hvals(k);
});

register("HLEN", (deps, tenantId, args) => {
  expectArgs("HLEN", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "hash");
  return deps.store.hashes.hlen(k);
});

register("HINCRBY", (deps, tenantId, args) => {
  expectArgs("HINCRBY", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  const field = asString(args[1], "field");
  const delta = asInt(args[2], "increment");
  deps.store.reserveKey(k, "hash");
  const current = deps.store.hashes.hget(k, field);
  const base = current === null ? 0 : Number(current);
  if (current !== null && (!Number.isFinite(base) || !Number.isInteger(base))) {
    throw new Error("hash value is not an integer");
  }
  const next = base + delta;
  if (!Number.isSafeInteger(next)) {
    throw new Error("increment would overflow safe integer range");
  }
  deps.store.hashes.hset(k, field, String(next));
  return next;
});

// ── Lists ─────────────────────────────────────────────────────────────────────

register("LPUSH", (deps, tenantId, args) => {
  expectArgsRange("LPUSH", args, 2, Number.POSITIVE_INFINITY);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  deps.store.reserveKey(k, "list");
  let length = 0;
  for (let i = 1; i < args.length; i++) {
    length = deps.store.lists.lpush(k, asString(args[i], "value"));
  }
  return length;
});

register("RPUSH", (deps, tenantId, args) => {
  expectArgsRange("RPUSH", args, 2, Number.POSITIVE_INFINITY);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  deps.store.reserveKey(k, "list");
  let length = 0;
  for (let i = 1; i < args.length; i++) {
    length = deps.store.lists.rpush(k, asString(args[i], "value"));
  }
  return length;
});

function popList(
  deps: DispatcherDeps,
  tenantId: string,
  args: unknown[],
  end: "head" | "tail",
  verb: string,
): unknown {
  expectArgs(verb, args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  if (deps.store.types.getType(k) === null) return null;
  deps.store.types.assertType(k, "list");
  const value =
    end === "head" ? deps.store.lists.lpop(k) : deps.store.lists.rpop(k);
  if (!deps.store.lists.has(k)) {
    deps.store.types.unregister(k);
  }
  return value;
}

register("LPOP", (deps, tenantId, args) =>
  popList(deps, tenantId, args, "head", "LPOP"),
);
register("RPOP", (deps, tenantId, args) =>
  popList(deps, tenantId, args, "tail", "RPOP"),
);

register("LLEN", (deps, tenantId, args) => {
  expectArgs("LLEN", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "list");
  return deps.store.lists.llen(k);
});

register("LINDEX", (deps, tenantId, args) => {
  expectArgs("LINDEX", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  if (deps.store.types.getType(k) === null) return null;
  deps.store.types.assertType(k, "list");
  return deps.store.lists.lindex(k, asInt(args[1], "index"));
});

register("LRANGE", (deps, tenantId, args) => {
  expectArgs("LRANGE", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return [];
  if (deps.store.types.getType(k) === null) return [];
  deps.store.types.assertType(k, "list");
  return deps.store.lists.lrange(
    k,
    asInt(args[1], "start"),
    asInt(args[2], "stop"),
  );
});

register("LREM", (deps, tenantId, args) => {
  expectArgs("LREM", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "list");
  const count = asInt(args[1], "count");
  const value = asString(args[2], "value");
  const removed = deps.store.lists.lrem(k, count, value);
  if (!deps.store.lists.has(k)) deps.store.types.unregister(k);
  return removed;
});

register("LTRIM", (deps, tenantId, args) => {
  expectArgs("LTRIM", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return "OK";
  if (deps.store.types.getType(k) === null) return "OK";
  deps.store.types.assertType(k, "list");
  deps.store.lists.ltrim(k, asInt(args[1], "start"), asInt(args[2], "stop"));
  if (!deps.store.lists.has(k)) deps.store.types.unregister(k);
  return "OK";
});

// ── Sets ──────────────────────────────────────────────────────────────────────

register("SADD", (deps, tenantId, args) => {
  expectArgsRange("SADD", args, 2, Number.POSITIVE_INFINITY);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  deps.store.reserveKey(k, "set");
  let added = 0;
  for (let i = 1; i < args.length; i++) {
    added += deps.store.sets.sadd(k, asString(args[i], "member"));
  }
  return added;
});

register("SMEMBERS", (deps, tenantId, args) => {
  expectArgs("SMEMBERS", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return [];
  if (deps.store.types.getType(k) === null) return [];
  deps.store.types.assertType(k, "set");
  return deps.store.sets.smembers(k);
});

register("SREM", (deps, tenantId, args) => {
  expectArgsRange("SREM", args, 2, Number.POSITIVE_INFINITY);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "set");
  let removed = 0;
  for (let i = 1; i < args.length; i++) {
    removed += deps.store.sets.srem(k, asString(args[i], "member"));
  }
  // srem auto-deletes the empty bucket — keep registry in sync.
  if (deps.store.sets.smembers(k).length === 0) {
    deps.store.types.unregister(k);
  }
  return removed;
});

register("SISMEMBER", (deps, tenantId, args) => {
  expectArgs("SISMEMBER", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "set");
  return deps.store.sets.sismember(k, asString(args[1], "member")) ? 1 : 0;
});

register("SCARD", (deps, tenantId, args) => {
  expectArgs("SCARD", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "set");
  return deps.store.sets.scard(k);
});

/** Resolve a list of raw keys to the live underlying Sets, treating
 *  missing or expired keys as empty. WRONGTYPE-throws on non-set keys. */
function resolveSets(
  deps: DispatcherDeps,
  tenantId: string,
  rawKeys: string[],
): Set<string>[] {
  const out: Set<string>[] = [];
  for (const raw of rawKeys) {
    const k = getTenantKey(tenantId, raw);
    if (deps.store.isExpired(k)) {
      out.push(new Set());
      continue;
    }
    if (deps.store.types.getType(k) === null) {
      out.push(new Set());
      continue;
    }
    deps.store.types.assertType(k, "set");
    out.push(deps.store.sets.getSet(k) ?? new Set());
  }
  return out;
}

register("SINTER", (deps, tenantId, args) => {
  expectArgsRange("SINTER", args, 1, Number.POSITIVE_INFINITY);
  const sets = resolveSets(
    deps,
    tenantId,
    args.map((a) => asString(a, "key")),
  );
  if (sets.some((s) => s.size === 0)) return [];
  // Iterate the smallest set; check membership in the rest.
  const sorted = sets.slice().sort((a, b) => a.size - b.size);
  const result: string[] = [];
  outer: for (const v of sorted[0]) {
    for (let i = 1; i < sorted.length; i++) {
      if (!sorted[i].has(v)) continue outer;
    }
    result.push(v);
  }
  return result;
});

register("SUNION", (deps, tenantId, args) => {
  expectArgsRange("SUNION", args, 1, Number.POSITIVE_INFINITY);
  const sets = resolveSets(
    deps,
    tenantId,
    args.map((a) => asString(a, "key")),
  );
  const out = new Set<string>();
  for (const s of sets) for (const v of s) out.add(v);
  return Array.from(out);
});

register("SDIFF", (deps, tenantId, args) => {
  // SDIFF k1 k2 [k3 ...] — returns members in k1 not in any other set.
  expectArgsRange("SDIFF", args, 1, Number.POSITIVE_INFINITY);
  const sets = resolveSets(
    deps,
    tenantId,
    args.map((a) => asString(a, "key")),
  );
  const [first, ...rest] = sets;
  const result: string[] = [];
  for (const v of first) {
    if (rest.every((r) => !r.has(v))) result.push(v);
  }
  return result;
});

// ── Sorted sets ───────────────────────────────────────────────────────────────

register("ZADD", (deps, tenantId, args) => {
  // Subset: ZADD key score member [score member ...]
  if (args.length < 3 || (args.length - 1) % 2 !== 0) {
    throw new Error("wrong number of arguments for 'zadd'");
  }
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  deps.store.reserveKey(k, "zset");
  let added = 0;
  for (let i = 1; i < args.length; i += 2) {
    const score = asNumber(args[i], "score");
    const member = asString(args[i + 1], "member");
    added += deps.store.sortedSets.zadd(k, score, member);
  }
  return added;
});

register("ZRANGE", (deps, tenantId, args) => {
  expectArgs("ZRANGE", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return [];
  if (deps.store.types.getType(k) === null) return [];
  deps.store.types.assertType(k, "zset");
  return deps.store.sortedSets.zrange(
    k,
    asInt(args[1], "start"),
    asInt(args[2], "stop"),
  );
});

register("ZSCORE", (deps, tenantId, args) => {
  expectArgs("ZSCORE", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  if (deps.store.types.getType(k) === null) return null;
  deps.store.types.assertType(k, "zset");
  return deps.store.sortedSets.zscore(k, asString(args[1], "member"));
});

register("ZREM", (deps, tenantId, args) => {
  expectArgsRange("ZREM", args, 2, Number.POSITIVE_INFINITY);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "zset");
  let removed = 0;
  for (let i = 1; i < args.length; i++) {
    removed += deps.store.sortedSets.zrem(k, asString(args[i], "member"));
  }
  return removed;
});

register("ZCARD", (deps, tenantId, args) => {
  expectArgs("ZCARD", args, 1);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "zset");
  return deps.store.sortedSets.zcard(k);
});

register("ZCOUNT", (deps, tenantId, args) => {
  expectArgs("ZCOUNT", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return 0;
  if (deps.store.types.getType(k) === null) return 0;
  deps.store.types.assertType(k, "zset");
  return deps.store.sortedSets.zcount(
    k,
    asNumber(args[1], "min"),
    asNumber(args[2], "max"),
  );
});

register("ZRANK", (deps, tenantId, args) => {
  expectArgs("ZRANK", args, 2);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return null;
  if (deps.store.types.getType(k) === null) return null;
  deps.store.types.assertType(k, "zset");
  return deps.store.sortedSets.zrank(k, asString(args[1], "member"));
});

register("ZREVRANGE", (deps, tenantId, args) => {
  expectArgs("ZREVRANGE", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return [];
  if (deps.store.types.getType(k) === null) return [];
  deps.store.types.assertType(k, "zset");
  return deps.store.sortedSets.zrevrange(
    k,
    asInt(args[1], "start"),
    asInt(args[2], "stop"),
  );
});

register("ZRANGEBYSCORE", (deps, tenantId, args) => {
  expectArgs("ZRANGEBYSCORE", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  if (deps.store.isExpired(k)) return [];
  if (deps.store.types.getType(k) === null) return [];
  deps.store.types.assertType(k, "zset");
  return deps.store.sortedSets.zrangeByScore(
    k,
    asNumber(args[1], "min"),
    asNumber(args[2], "max"),
  );
});

register("ZINCRBY", (deps, tenantId, args) => {
  expectArgs("ZINCRBY", args, 3);
  const k = getTenantKey(tenantId, asString(args[0], "key"));
  const delta = asNumber(args[1], "increment");
  const member = asString(args[2], "member");
  deps.store.reserveKey(k, "zset");
  return deps.store.sortedSets.zincrby(k, delta, member);
});

// ── Priority queue ────────────────────────────────────────────────────────────
//
// Available inside transactions only when a PriorityQueue is wired in.
// Throws a helpful error otherwise.

function requireQueue(deps: DispatcherDeps): PriorityQueue {
  if (!deps.queue) {
    throw new Error("priority queue is not enabled on this server");
  }
  return deps.queue;
}

register("ENQUEUE", (deps, tenantId, args) => {
  // ENQUEUE name value [priority]
  expectArgsRange("ENQUEUE", args, 2, 3);
  const q = requireQueue(deps);
  const name = getTenantKey(tenantId, asString(args[0], "name"));
  const value = asString(args[1], "value");
  const priority = args.length === 3 ? asNumber(args[2], "priority") : 0;
  return q.enqueue(name, value, priority);
});

register("DEQUEUE", (deps, tenantId, args) => {
  expectArgs("DEQUEUE", args, 1);
  const q = requireQueue(deps);
  const name = getTenantKey(tenantId, asString(args[0], "name"));
  return q.dequeue(name);
});

register("QLEN", (deps, tenantId, args) => {
  expectArgs("QLEN", args, 1);
  const q = requireQueue(deps);
  const name = getTenantKey(tenantId, asString(args[0], "name"));
  return q.len(name);
});

register("QPEEK", (deps, tenantId, args) => {
  expectArgs("QPEEK", args, 1);
  const q = requireQueue(deps);
  const name = getTenantKey(tenantId, asString(args[0], "name"));
  return q.peek(name);
});

register("QCLEAR", (deps, tenantId, args) => {
  expectArgs("QCLEAR", args, 1);
  const q = requireQueue(deps);
  const name = getTenantKey(tenantId, asString(args[0], "name"));
  return q.clear(name);
});

// ── Pub/Sub ───────────────────────────────────────────────────────────────────
//
// PUBLISH and the introspection sub-commands of PUBSUB live in the dispatcher
// so they work inside transactions and via `client.cmd()`. SSE subscribe
// streams stay HTTP-only — they need a long-lived connection, which the
// synchronous dispatch path can't provide.

function requirePubsub(deps: DispatcherDeps): PubSubService {
  if (!deps.pubsub) {
    throw new Error("pub/sub is not enabled on this server");
  }
  return deps.pubsub;
}

register("PUBLISH", (deps, tenantId, args) => {
  // PUBLISH channel message — message is forwarded as-is (any JSON value).
  expectArgs("PUBLISH", args, 2);
  const pubsub = requirePubsub(deps);
  const channel = getTenantKey(tenantId, asString(args[0], "channel"));
  return pubsub.publish(channel, args[1] as never);
});

register("PUBSUB", (deps, tenantId, args) => {
  // PUBSUB CHANNELS [pattern]    → string[]   (tenant-scoped, prefix stripped)
  // PUBSUB NUMSUB [c1 c2 ...]    → Record<channel, count>
  // PUBSUB NUMPAT                → number     (server-wide)
  if (args.length < 1)
    throw new Error("wrong number of arguments for 'pubsub'");
  const pubsub = requirePubsub(deps);
  const sub = asString(args[0], "subcommand").toUpperCase();
  const prefix = `${tenantId}:`;

  if (sub === "CHANNELS") {
    expectArgsRange("PUBSUB CHANNELS", args, 1, 2);
    const rawPattern = args.length === 2 ? asString(args[1], "pattern") : "*";
    const tenantPattern = `${prefix}${rawPattern}`;
    return pubsub
      .listChannels(tenantPattern)
      .map((c) => (c.startsWith(prefix) ? c.slice(prefix.length) : c));
  }

  if (sub === "NUMSUB") {
    // Zero channels → empty record (matches expected behaviour for `PUBSUB NUMSUB`).
    const channels: string[] = [];
    for (let i = 1; i < args.length; i++) {
      channels.push(getTenantKey(tenantId, asString(args[i], "channel")));
    }
    const counts = pubsub.numSub(channels);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(counts)) {
      out[k.startsWith(prefix) ? k.slice(prefix.length) : k] = v;
    }
    return out;
  }

  if (sub === "NUMPAT") {
    expectArgs("PUBSUB NUMPAT", args, 1);
    return pubsub.numPat();
  }

  throw new Error(`unknown PUBSUB subcommand '${sub}'`);
});

// ── Slowlog ───────────────────────────────────────────────────────────────────
//
// SLOWLOG itself is intentionally *not* timed by the dispatcher — see the
// `dispatchCommand` body below. That avoids a feedback loop where calling
// `SLOWLOG GET` under load fills the slowlog with itself.

function requireSlowlog(deps: DispatcherDeps): SlowLog {
  if (!deps.slowlog) {
    throw new Error("slowlog is not enabled on this server");
  }
  return deps.slowlog;
}

register("SLOWLOG", (deps, tenantId, args) => {
  // SLOWLOG GET [count]   → entries[]  (tenant-scoped)
  // SLOWLOG LEN           → number     (tenant-scoped)
  // SLOWLOG RESET         → number     (count of entries dropped for this tenant)
  // SLOWLOG HELP          → string[]
  if (args.length < 1) {
    throw new Error("wrong number of arguments for 'slowlog'");
  }
  const slowlog = requireSlowlog(deps);
  const sub = asString(args[0], "subcommand").toUpperCase();

  if (sub === "GET") {
    expectArgsRange("SLOWLOG GET", args, 1, 2);
    const count = args.length === 2 ? asInt(args[1], "count") : 128;
    if (count < 0) throw new Error("count must be non-negative");
    // Strip tenantId on output — clients only ever see their own
    // entries, so the field would be redundant anyway.
    return slowlog.entries(count, tenantId).map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      durationUs: e.durationUs,
      command: e.command,
      args: e.args,
      source: e.source,
    }));
  }

  if (sub === "LEN") {
    expectArgs("SLOWLOG LEN", args, 1);
    return slowlog.lengthFor(tenantId);
  }

  if (sub === "RESET") {
    expectArgs("SLOWLOG RESET", args, 1);
    return slowlog.reset(tenantId);
  }

  if (sub === "HELP") {
    return [
      "SLOWLOG GET [count]   - Return the most recent slow commands",
      "SLOWLOG LEN           - Number of stored entries for this tenant",
      "SLOWLOG RESET         - Drop this tenant's entries",
      "SLOWLOG HELP          - This help text",
    ];
  }

  throw new Error(`unknown SLOWLOG subcommand '${sub}'`);
});

// ── Config / Admin ────────────────────────────────────────────────────────────

function requireConfig(deps: DispatcherDeps): ConfigRegistry {
  if (!deps.config) {
    throw new Error("CONFIG is not enabled on this server");
  }
  return deps.config;
}

/**
 * Confirm the calling tenant is allowed to mutate config / trigger admin
 * actions. When no admin tenant is configured, mutations are denied —
 * a safe default that prevents any tenant from yanking another's tunables.
 */
function requireAdmin(deps: DispatcherDeps, tenantId: string): void {
  if (!deps.adminTenantId) {
    throw new Error(
      "admin operations are disabled (set ERIX_ADMIN_TENANT_ID to enable)",
    );
  }
  if (deps.adminTenantId !== tenantId) {
    throw new Error("admin operations require the admin tenant");
  }
}

register("CONFIG", (deps, tenantId, args) => {
  // CONFIG GET <pattern>      → [{ name, value }]   any authenticated tenant
  // CONFIG SET <name> <value> → "OK"                admin tenant only
  // CONFIG RESETSTAT          → "OK"                no-op for now (placeholder)
  // CONFIG HELP               → string[]
  if (args.length < 1) {
    throw new Error("wrong number of arguments for 'config'");
  }
  const config = requireConfig(deps);
  const sub = asString(args[0], "subcommand").toUpperCase();

  if (sub === "GET") {
    expectArgsRange("CONFIG GET", args, 1, 2);
    const pattern = args.length === 2 ? asString(args[1], "pattern") : "*";
    return config.entries(pattern);
  }

  if (sub === "SET") {
    expectArgs("CONFIG SET", args, 3);
    requireAdmin(deps, tenantId);
    const name = asString(args[1], "parameter");
    const value = asString(args[2], "value");
    config.set(name, value);
    return "OK";
  }

  if (sub === "RESETSTAT") {
    expectArgs("CONFIG RESETSTAT", args, 1);
    requireAdmin(deps, tenantId);
    // Reserved for the day we accumulate per-command counters. For now it's
    // just a recognised verb so clients that expect it get OK.
    return "OK";
  }

  if (sub === "HELP") {
    return [
      "CONFIG GET <pattern>     - Return tunables matching the glob pattern",
      "CONFIG SET <name> <val>  - Update a tunable (admin tenant only)",
      "CONFIG RESETSTAT         - Reset counters (admin tenant only)",
      "CONFIG HELP              - This help text",
    ];
  }

  throw new Error(`unknown CONFIG subcommand '${sub}'`);
});

register("BGSAVE", (deps, tenantId, args) => {
  // BGSAVE — fire a non-blocking snapshot. Admin tenant only because a
  // background save can stall the Postgres connection pool under load.
  expectArgs("BGSAVE", args, 0);
  requireAdmin(deps, tenantId);
  if (!deps.bgsave) {
    throw new Error("BGSAVE is not configured on this server");
  }
  // Fire-and-forget. Errors are logged; the verb itself always succeeds
  // once we've kicked off the work — standard "Background saving
  // started" reply.
  Promise.resolve()
    .then(() => deps.bgsave!())
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ErixStore] BGSAVE failed: ${message}`);
    });
  return "Background saving started";
});

register("BGREWRITEAOF", (deps, tenantId, args) => {
  // BGREWRITEAOF — replace the AOF with a compact rewrite of the live
  // state. Synchronous in this implementation: AofLog.rewrite is sync
  // and the cost is bounded by the number of live keys. We still gate
  // on the admin tenant because rewriting blocks the event loop.
  expectArgs("BGREWRITEAOF", args, 0);
  requireAdmin(deps, tenantId);
  if (!deps.aof) {
    throw new Error("AOF is not enabled on this server");
  }
  deps.aof.rewrite(aofRewriteEntries(deps.store, deps.queue));
  return "Background append only file rewriting started";
});

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a single command synchronously. Returns a CommandResult — never throws
 * for known error shapes (WrongTypeError, validation, unknown verb). Unknown
 * exceptions bubble up as `{ ok: false, error: ... }`.
 *
 * If a `SlowLog` is wired into `deps`, every command is timed with
 * `process.hrtime.bigint()` and submitted to the log when its duration
 * meets or exceeds the configured threshold. SLOWLOG itself is never
 * recorded — preventing a feedback loop where reading the log refills it.
 */
export function dispatchCommand(
  deps: DispatcherDeps,
  tenantId: string,
  command: Command,
  source: SlowLogEntry["source"] = "single",
): CommandResult {
  const handler = HANDLERS[command.name.toUpperCase()];
  if (!handler) {
    return {
      ok: false,
      error: `unknown command '${command.name}'`,
      code: "UNKNOWN_COMMAND",
    };
  }

  // Timing path — only enabled when a SlowLog is wired AND the command
  // is not SLOWLOG itself (avoids self-amplification).
  const shouldTime =
    deps.slowlog !== undefined && command.name.toUpperCase() !== "SLOWLOG";
  const start = shouldTime ? process.hrtime.bigint() : 0n;

  let result: CommandResult;
  try {
    const value = handler(deps, tenantId, command.args ?? []);
    result = { ok: true, value };
  } catch (err) {
    if (err instanceof WrongTypeError) {
      result = { ok: false, error: err.message, code: err.code };
    } else if (err instanceof OOMError) {
      result = { ok: false, error: err.message, code: err.code };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: message };
    }
  }

  // Append to the AOF after a successful mutation. Read verbs and
  // ephemeral surfaces are excluded by `MUTATING_VERBS`. Failures
  // (WRONGTYPE/OOM/validation) are not logged — replay would just
  // reproduce the same failure with no side-effect.
  if (result.ok && deps.aof) {
    const upper = command.name.toUpperCase();
    if (MUTATING_VERBS.has(upper)) {
      try {
        deps.aof.append({
          tenantId,
          name: upper,
          args: command.args ?? [],
        });
      } catch (err) {
        // A failed AOF append is logged but does not roll back the
        // already-applied mutation — standard append-only-log behaviour.
        // Operators should monitor the log for these messages.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[AofLog] append failed for ${upper}: ${message}`);
      }
    }
  }

  if (shouldTime) {
    const elapsedNs = process.hrtime.bigint() - start;
    // Convert to microseconds (integer). 1_000n = 1 µs in ns.
    const durationUs = Number(elapsedNs / 1_000n);
    deps.slowlog!.record({
      durationUs,
      command: command.name,
      args: command.args ?? [],
      tenantId,
      source,
    });
  }

  return result;
}

/**
 * Run a batch of commands as an atomic transaction. Every command executes
 * inside this synchronous loop — no other request can interleave because
 * none of these handlers ever yield to the event loop.
 *
 * Per-command errors are captured into the result but do **not** abort the
 * batch (matching MULTI/EXEC semantics, where a runtime error on
 * one command doesn't stop the others).
 */
export function dispatchTransaction(
  deps: DispatcherDeps,
  tenantId: string,
  commands: Command[],
): CommandResult[] {
  const results: CommandResult[] = new Array(commands.length);
  for (let i = 0; i < commands.length; i++) {
    results[i] = dispatchCommand(deps, tenantId, commands[i], "transaction");
  }
  return results;
}

/** Internal — used by tests to verify the registered verb set. */
export function listVerbs(): string[] {
  return Object.keys(HANDLERS).sort();
}
