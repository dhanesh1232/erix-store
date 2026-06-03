/**
 * @file aofWriters.ts
 * @module Services/AofWriters
 *
 * Two narrow helpers that the dispatcher and rewrite path share:
 *
 *   1. `MUTATING_VERBS` — the set of verb names that change persisted
 *      state. The dispatcher consults this before calling
 *      `AofLog.append`. Read-only verbs and ephemeral surfaces
 *      (PUBLISH, SLOWLOG, CONFIG, BGSAVE, BGREWRITEAOF, PUBSUB) are
 *      deliberately excluded — replaying them on restart would either
 *      do nothing useful or actively corrupt operator intent.
 *
 *   2. `aofRewriteEntries(store, queue)` — a generator that emits one
 *      logical write per live record. Used by `BGREWRITEAOF` to
 *      produce a compact replacement file from the in-memory state.
 *
 * Tenant key handling
 * -------------------
 * The dispatcher prefixes user-supplied keys with `${tenantId}:` before
 * calling into the store. On replay we go back through the dispatcher
 * with the original tenantId and the original (un-prefixed) key, so
 * rewrite entries strip the tenant prefix the same way `aofTenantSplit`
 * does below. This keeps the on-disk format symmetrical with the wire
 * format and lets a stripped-down operator copy the AOF between hosts
 * without rewriting it.
 */

import type { ErixStore } from "../core/Store.js";
import type { AofEntry } from "./AofLog.js";
import type { PriorityQueue } from "./PriorityQueue.js";

/**
 * Verb names whose effects must be replayed on restart. Membership is
 * the canonical list — adding a new mutating verb to the dispatcher
 * means adding it here.
 */
export const MUTATING_VERBS: ReadonlySet<string> = new Set([
  // Strings
  "SET",
  "DEL",
  "INCR",
  "DECR",
  "INCRBY",
  "DECRBY",
  "APPEND",
  "MSET",
  "GETSET",
  "SETNX",
  "EXPIRE",
  "PERSIST",
  // Hashes
  "HSET",
  "HMSET",
  "HDEL",
  "HINCRBY",
  // Lists
  "LPUSH",
  "RPUSH",
  "LPOP",
  "RPOP",
  "LREM",
  "LTRIM",
  // Sets
  "SADD",
  "SREM",
  // Sorted sets
  "ZADD",
  "ZINCRBY",
  "ZREM",
  // Server-level
  "FLUSHDB",
  // Priority queue
  "ENQUEUE",
  "DEQUEUE",
  "QCLEAR",
]);

/**
 * Split a tenant-prefixed key into `[tenantId, rawKey]`.
 *
 * We never persist the tenant prefix in arg position — replay reuses
 * the dispatcher, which always re-prefixes. Storing the un-prefixed
 * key keeps the on-disk format identical to the wire format.
 */
function aofTenantSplit(fullKey: string): [string, string] {
  const idx = fullKey.indexOf(":");
  if (idx === -1) return ["", fullKey];
  return [fullKey.slice(0, idx), fullKey.slice(idx + 1)];
}

/**
 * Walk the live in-memory state and yield one logical AOF entry per
 * record. Used by `BGREWRITEAOF` to produce a compact file equivalent
 * to the live state without replaying every historical write.
 *
 * The output ordering doesn't matter for correctness — any permutation
 * of these entries will replay to the same final state — but we emit
 * by type for grep-ability.
 */
export function* aofRewriteEntries(
  store: ErixStore,
  queue?: PriorityQueue,
): IterableIterator<Omit<AofEntry, "ts">> {
  const now = Date.now();

  // Strings
  for (const fullKey of store.types.keys()) {
    const type = store.types.getType(fullKey);
    if (type !== "string") continue;
    const [tenantId, key] = aofTenantSplit(fullKey);
    const value = store.strings.get(fullKey);
    if (value === null) continue;
    const ttl = store.ttlManager.getTTL(fullKey);
    const args: unknown[] = [key, value];
    if (ttl > 0) args.push("EX", ttl);
    yield { tenantId, name: "SET", args };
  }

  // Hashes
  for (const fullKey of store.types.keys()) {
    if (store.types.getType(fullKey) !== "hash") continue;
    const [tenantId, key] = aofTenantSplit(fullKey);
    const all = store.hashes.hgetall(fullKey);
    if (!all) continue;
    const args: unknown[] = [key];
    for (const [field, val] of Object.entries(all)) args.push(field, val);
    yield { tenantId, name: "HSET", args };
    const ttl = store.ttlManager.getTTL(fullKey);
    if (ttl > 0) yield { tenantId, name: "EXPIRE", args: [key, ttl] };
  }

  // Lists — replayed in head-to-tail order via RPUSH so the original
  // ordering is preserved exactly.
  for (const fullKey of store.types.keys()) {
    if (store.types.getType(fullKey) !== "list") continue;
    const [tenantId, key] = aofTenantSplit(fullKey);
    const items = store.lists.lrange(fullKey, 0, -1);
    if (items.length === 0) continue;
    yield { tenantId, name: "RPUSH", args: [key, ...items] };
    const ttl = store.ttlManager.getTTL(fullKey);
    if (ttl > 0) yield { tenantId, name: "EXPIRE", args: [key, ttl] };
  }

  // Sets
  for (const fullKey of store.types.keys()) {
    if (store.types.getType(fullKey) !== "set") continue;
    const [tenantId, key] = aofTenantSplit(fullKey);
    const members = store.sets.smembers(fullKey);
    if (members.length === 0) continue;
    yield { tenantId, name: "SADD", args: [key, ...members] };
    const ttl = store.ttlManager.getTTL(fullKey);
    if (ttl > 0) yield { tenantId, name: "EXPIRE", args: [key, ttl] };
  }

  // Sorted sets — emit ZADD with all (score, member) pairs.
  for (const fullKey of store.types.keys()) {
    if (store.types.getType(fullKey) !== "zset") continue;
    const [tenantId, key] = aofTenantSplit(fullKey);
    const members = store.sortedSets.zrange(fullKey, 0, -1);
    if (members.length === 0) continue;
    const args: unknown[] = [key];
    for (const member of members) {
      const score = store.sortedSets.zscore(fullKey, member);
      if (score === null) continue;
      args.push(score, member);
    }
    yield { tenantId, name: "ZADD", args };
    const ttl = store.ttlManager.getTTL(fullKey);
    if (ttl > 0) yield { tenantId, name: "EXPIRE", args: [key, ttl] };
  }

  // Priority queue — exported as a sequence of ENQUEUE entries. We
  // can't observe scores from outside, but `PriorityQueue.export()`
  // gives us heap-ordered entries with their original priorities.
  if (queue) {
    const exported = queue.export();
    for (const [fullName, entries] of Object.entries(exported)) {
      const [tenantId, name] = aofTenantSplit(fullName);
      // Snapshot order matches insertion seq, so re-enqueueing in
      // index order recovers the same dequeue ordering.
      for (const e of entries) {
        yield {
          tenantId,
          name: "ENQUEUE",
          args: [name, e.value, e.priority],
        };
      }
    }
  }

  // Suppress unused-variable warning while keeping `now` available
  // for future timestamp-dependent rewrites. Calling code uses
  // `Date.now()` per-line in `AofLog.append` so we don't need it
  // here, but keeping the variable documents intent.
  void now;
}
