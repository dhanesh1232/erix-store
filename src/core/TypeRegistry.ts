/**
 * @file TypeRegistry.ts
 * @module Core/TypeRegistry
 *
 * Single source of truth for the type of every key in ErixStore.
 *
 * Why this exists
 * ---------------
 * Before this registry, the same key could exist in multiple sub-stores
 * simultaneously (e.g. a string and a list with the same name) because each
 * structure owned its own Map. Reads went to whichever route handler the
 * client called, with no cross-checking. That's the WRONGTYPE-shaped hole
 * that was closed long ago.
 *
 * The registry tracks which type owns each key. Mutating routes call
 * `assertType` (or `register`) before touching a sub-store, so a `LPUSH`
 * against an existing string key now fails with WRONGTYPE rather than
 * silently creating a parallel list.
 *
 * Lifecycle:
 *   - register(key, type)    — called by every write path before mutation
 *   - assertType(key, type)  — throws WrongTypeError if registered as something else
 *   - getType(key)           — for the TYPE command
 *   - unregister(key)        — called when a structure is fully drained or deleted
 *
 * Snapshot compatibility
 * ----------------------
 * Old snapshots have no registry. `rebuildFromStores` reconstructs the
 * registry by scanning each sub-store. If a key appears in multiple
 * sub-stores (legacy bug), we keep the first one in priority order
 * `string > hash > list > set > zset` and log a warning so operators
 * can investigate. The other copies are returned for cleanup.
 *
 * @requirements P0.1 — type registry + WRONGTYPE enforcement
 */

import { WrongTypeError } from "./errors.js";

/** All data types ErixStore currently supports. */
export type ErixType = "string" | "hash" | "list" | "set" | "zset";

/** Priority order used when resolving multi-type collisions during snapshot import. */
const RESOLUTION_ORDER: ErixType[] = ["string", "hash", "list", "set", "zset"];

/**
 * Sub-store interface — every concrete store (StringStore, HashStore, etc.)
 * already exposes `delete(key)`. We only need that here.
 */
interface DeletableStore {
  delete(key: string): void;
}

/**
 * Multi-type collision discovered during `rebuildFromStores`.
 * The winning copy stays where it is; losers are deleted from their stores.
 */
export interface TypeCollision {
  key: string;
  winner: ErixType;
  losers: ErixType[];
}

export class TypeRegistry {
  private types = new Map<string, ErixType>();

  /** Register `key` as `type`. If already registered as the same type, no-op.
   *  If registered as a different type, throws WrongTypeError. */
  register(key: string, type: ErixType): void {
    const existing = this.types.get(key);
    if (existing === undefined) {
      this.types.set(key, type);
      return;
    }
    if (existing !== type) {
      throw new WrongTypeError();
    }
  }

  /** Throw WrongTypeError unless `key` is unregistered or registered as `type`. */
  assertType(key: string, type: ErixType): void {
    const existing = this.types.get(key);
    if (existing !== undefined && existing !== type) {
      throw new WrongTypeError();
    }
  }

  /** Returns the registered type for `key`, or `null` if not registered. */
  getType(key: string): ErixType | null {
    return this.types.get(key) ?? null;
  }

  /** Removes the key from the registry. Idempotent. */
  unregister(key: string): void {
    this.types.delete(key);
  }

  /** All registered keys. Used by KEYS/DBSIZE in later batches. */
  keys(): IterableIterator<string> {
    return this.types.keys();
  }

  /** Total number of registered keys. */
  get size(): number {
    return this.types.size;
  }

  /** Reset the registry (used by FLUSHDB and tests). */
  clear(): void {
    this.types.clear();
  }

  /** Export the registry for snapshotting. */
  export(): Record<string, ErixType> {
    return Object.fromEntries(this.types);
  }

  /** Import a previously-exported registry. Replaces existing state. */
  import(data: Record<string, ErixType>): void {
    this.types.clear();
    for (const [key, type] of Object.entries(data)) {
      this.types.set(key, type);
    }
  }

  /**
   * Rebuild the registry by scanning the actual sub-store contents.
   *
   * Used during snapshot restore for snapshots written before the registry
   * existed (no `types` key in the JSON), and as a safety net to detect
   * stale or corrupt data.
   *
   * Resolution rule for multi-type collisions:
   *   1. The earliest type in RESOLUTION_ORDER wins.
   *   2. The losing copies are deleted from their respective stores via
   *      the provided `stores` map so the registry stays consistent.
   *   3. A warning is logged for each collision.
   *
   * @returns A list of collisions that were resolved.
   */
  rebuildFromStores(stores: {
    string: { keys(): IterableIterator<string> } & DeletableStore;
    hash: { keys(): IterableIterator<string> } & DeletableStore;
    list: { keys(): IterableIterator<string> } & DeletableStore;
    set: { keys(): IterableIterator<string> } & DeletableStore;
    zset: { keys(): IterableIterator<string> } & DeletableStore;
  }): TypeCollision[] {
    this.types.clear();

    // Build per-key type set
    const seen = new Map<string, Set<ErixType>>();
    const addKey = (key: string, type: ErixType) => {
      let entry = seen.get(key);
      if (!entry) {
        entry = new Set();
        seen.set(key, entry);
      }
      entry.add(type);
    };

    for (const k of stores.string.keys()) addKey(k, "string");
    for (const k of stores.hash.keys()) addKey(k, "hash");
    for (const k of stores.list.keys()) addKey(k, "list");
    for (const k of stores.set.keys()) addKey(k, "set");
    for (const k of stores.zset.keys()) addKey(k, "zset");

    const collisions: TypeCollision[] = [];

    for (const [key, typeSet] of seen) {
      if (typeSet.size === 1) {
        const [type] = typeSet;
        this.types.set(key, type);
        continue;
      }

      // Collision — pick the earliest type in resolution order
      const winner = RESOLUTION_ORDER.find((t) => typeSet.has(t));
      // `find` always succeeds because typeSet is a non-empty subset of RESOLUTION_ORDER
      if (!winner) continue;

      const losers = RESOLUTION_ORDER.filter(
        (t) => t !== winner && typeSet.has(t),
      );

      // Delete the losing copies so reads no longer see them
      for (const loser of losers) {
        stores[loser].delete(key);
      }

      this.types.set(key, winner);
      collisions.push({ key, winner, losers });

      console.warn(
        `[TypeRegistry] Multi-type collision for key "${key}": kept ${winner}, dropped ${losers.join(", ")}`,
      );
    }

    return collisions;
  }
}
