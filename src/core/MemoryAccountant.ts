/**
 * @file MemoryAccountant.ts
 * @module Core/MemoryAccountant
 *
 * Tracks approximate memory usage and runs eviction.
 *
 * The accountant sits between the dispatcher / routes and the underlying
 * sub-stores. Every mutation calls `charge(bytes)` before the write and
 * `credit(bytes)` after a delete. When `usedBytes + delta` would exceed
 * `maxBytes`, the accountant runs eviction first; if eviction can't free
 * enough room, the write fails with {@link OOMError}.
 *
 * Eviction policies:
 *
 *   - **noeviction**     — refuse the write, throw OOMError. Default.
 *   - **allkeys-lru**    — evict the least-recently-used key, regardless of TTL.
 *   - **volatile-lru**   — evict the least-recently-used key *that has a TTL*.
 *                          Falls back to OOM if every LRU candidate is permanent.
 *
 * The store provides a single `deleteCb(key)` callback used by both policies;
 * the callback must drop the value and call `accountant.credit(...)` so the
 * loop can see the freed bytes.
 *
 * Re-entrancy
 * -----------
 * `evict()` triggers `deleteCb`, which calls `credit()`. To prevent a
 * recursive `tryCharge()` from looping, eviction is guarded by a flag.
 *
 * Disabled-state semantics
 * --------------------------
 * `maxBytes <= 0` disables the cap entirely (the default). All policies are
 * effectively `noeviction` in that mode — but since `tryCharge` short-circuits
 * before checking the cap, no work is done and no OOM is ever raised.
 *
 * @requirements P2.1 — max-memory cap with LRU eviction
 */

import { LRUList } from "../structures/LRUList.js";
import { keyOverheadCost } from "./byteCost.js";
import { OOMError } from "./errors.js";
import type { TypeRegistry } from "./TypeRegistry.js";

export type EvictionPolicy = "noeviction" | "allkeys-lru" | "volatile-lru";

/**
 * Function the accountant calls to delete a key during eviction.
 * The callback is responsible for dropping the value from its sub-store
 * AND calling `accountant.credit(...)` for the freed bytes.
 */
export type DeleteCallback = (key: string) => void;

/** Function that returns true iff the key currently has a TTL. */
export type HasTTLCallback = (key: string) => boolean;

export interface MemoryAccountantOptions {
  /** Cap in bytes. <= 0 disables enforcement entirely. */
  maxBytes?: number;
  /** Default eviction policy when the cap would be exceeded. */
  policy?: EvictionPolicy;
}

export class MemoryAccountant {
  private _usedBytes = 0;
  private _maxBytes: number;
  private _policy: EvictionPolicy;
  private evictedCount = 0;
  private evicting = false;

  /** LRU index of registered keys — head = MRU, tail = LRU. */
  private readonly lru = new LRUList<string>();

  /** Callbacks supplied by the store after construction (deferred to break cycle). */
  private deleteCb: DeleteCallback | null = null;
  private hasTTLCb: HasTTLCallback | null = null;

  constructor(opts: MemoryAccountantOptions = {}) {
    this._maxBytes = opts.maxBytes ?? 0;
    this._policy = opts.policy ?? "noeviction";
  }

  /** Wire the delete + has-TTL callbacks. Called once by ErixStore at construction. */
  bind(deleteCb: DeleteCallback, hasTTLCb: HasTTLCallback): void {
    this.deleteCb = deleteCb;
    this.hasTTLCb = hasTTLCb;
  }

  // ── Configuration ────────────────────────────────────────────────────────

  get maxBytes(): number {
    return this._maxBytes;
  }
  setMaxBytes(bytes: number): void {
    this._maxBytes = bytes;
  }

  get policy(): EvictionPolicy {
    return this._policy;
  }
  setPolicy(policy: EvictionPolicy): void {
    this._policy = policy;
  }

  // ── Stats (read-only) ────────────────────────────────────────────────────

  get usedBytes(): number {
    return this._usedBytes;
  }

  get evictedKeys(): number {
    return this.evictedCount;
  }

  // ── Charge / credit ──────────────────────────────────────────────────────

  /**
   * Reserve `bytes` for an upcoming write. Runs eviction if the cap would
   * be exceeded; throws {@link OOMError} if eviction cannot free enough.
   *
   * Call this BEFORE mutating the underlying store. Pair with `credit`
   * on the matching delete.
   */
  tryCharge(bytes: number): void {
    if (bytes <= 0) return;
    if (this._maxBytes <= 0) {
      // Cap disabled — track usage for INFO, but never refuse.
      this._usedBytes += bytes;
      return;
    }

    while (this._usedBytes + bytes > this._maxBytes) {
      if (!this.tryEvict()) {
        throw new OOMError();
      }
    }
    this._usedBytes += bytes;
  }

  /**
   * Charge bytes without checking the cap. Used during snapshot import,
   * where we accept restoring data even if it temporarily exceeds the
   * configured `maxBytes` — operators don't expect a restore to silently
   * drop entries.
   */
  forceCharge(bytes: number): void {
    if (bytes <= 0) return;
    this._usedBytes += bytes;
  }

  /**
   * Release `bytes` previously charged. Idempotent for `bytes <= 0`.
   * Clamps `_usedBytes` at zero — accounting drift due to over/undercount
   * should never produce negative usage.
   */
  credit(bytes: number): void {
    if (bytes <= 0) return;
    this._usedBytes = Math.max(0, this._usedBytes - bytes);
  }

  // ── LRU index ────────────────────────────────────────────────────────────

  /** Mark `key` as most-recently-used. Reads and writes both call this. */
  touch(key: string): void {
    this.lru.add(key);
  }

  /** Remove `key` from the LRU index. Called on DEL/expiry/eviction. */
  forget(key: string): void {
    this.lru.remove(key);
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /** Reset accounting (used during snapshot import). */
  reset(): void {
    this._usedBytes = 0;
    this.evictedCount = 0;
  }

  // ── Internal: eviction ────────────────────────────────────────────────────

  /**
   * Pop one eviction candidate and delete it. Returns true on success,
   * false when no candidate is available (empty index or volatile-only
   * with no TTL'd keys remaining).
   */
  private tryEvict(): boolean {
    if (this._policy === "noeviction") return false;
    if (this.evicting) {
      // The delete callback should never re-enter eviction. If it does
      // (e.g. broken store integration), bail out rather than loop.
      return false;
    }
    if (!this.deleteCb || !this.hasTTLCb) return false;

    this.evicting = true;
    try {
      if (this._policy === "allkeys-lru") {
        const victim = this.lru.evict();
        if (victim === undefined) return false;
        this.deleteCb(victim);
        this.evictedCount++;
        return true;
      }

      if (this._policy === "volatile-lru") {
        // Walk from least-recently-used toward most-recently-used. The
        // first key we hit that has a TTL is the victim. Iteration is
        // safe against `lru.remove` of the yielded key because the
        // iterator caches the prev pointer before yielding.
        for (const candidate of this.lru.tailToHead()) {
          if (!this.hasTTLCb(candidate)) continue;
          this.lru.remove(candidate);
          this.deleteCb(candidate);
          this.evictedCount++;
          return true;
        }
        return false;
      }

      return false;
    } finally {
      this.evicting = false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Re-export key-name overhead so call sites don't import byteCost separately. */
  static keyOverhead(key: string): number {
    return keyOverheadCost(key);
  }

  /**
   * Wire the LRU index into the type registry's lifecycle.
   *
   * Most cleanup paths run through the registry: when a key is unregistered
   * we want it dropped from the LRU index too. This is a one-time wiring
   * helper rather than a runtime hook to keep the registry hot path free
   * of accountant calls.
   *
   * Currently a no-op: `Store.deleteKey` and `handleExpiry` invoke
   * `accountant.forget` directly, which is enough. Kept here so future
   * callers can opt into automatic cleanup if needed.
   */
  static wireRegistry(_registry: TypeRegistry): void {
    // Reserved for future use.
  }
}
