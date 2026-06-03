import { zsetMemberCost } from "../core/byteCost.js";
import type { MemoryAccountant } from "../core/MemoryAccountant.js";
import { SkipList } from "./SkipList.js";

interface SortedSetMember {
  value: string;
  score: number;
}

/**
 * Composite key for the skip list: orders by score ascending, then by value lexicographically.
 */
interface CompositeKey {
  score: number;
  value: string;
}

function compareCompositeKeys(a: CompositeKey, b: CompositeKey): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return 0;
}

/**
 * Internal structure holding a SkipList and a value-to-score lookup map for a single sorted set key.
 */
interface SortedSetEntry {
  skipList: SkipList<CompositeKey, string>;
  scoreMap: Map<string, number>;
}

/**
 * SortedSetStore backed by SkipList for O(log n) zadd, zrem, and O(log n + k) zrange.
 * Maintains the same public API as the previous array-based implementation.
 */
export class SortedSetStore {
  private data = new Map<string, SortedSetEntry>();

  constructor(private readonly accountant?: MemoryAccountant) {}

  private getOrCreate(key: string): SortedSetEntry {
    let entry = this.data.get(key);
    if (!entry) {
      entry = {
        skipList: new SkipList<CompositeKey, string>(compareCompositeKeys),
        scoreMap: new Map<string, number>(),
      };
      this.data.set(key, entry);
    }
    return entry;
  }

  zadd(key: string, score: number, value: string): number {
    this.accountant?.touch(key);
    const entry = this.getOrCreate(key);
    const existingScore = entry.scoreMap.get(value);

    if (existingScore !== undefined) {
      // Score-only update — member cost (which is independent of the
      // numeric score) is unchanged, so no charge/credit needed.
      entry.skipList.delete({ score: existingScore, value });
      entry.skipList.set({ score, value }, value);
      entry.scoreMap.set(value, score);
      return 0;
    }

    // New member — charge for it.
    this.accountant?.tryCharge(zsetMemberCost(value));
    entry.skipList.set({ score, value }, value);
    entry.scoreMap.set(value, score);
    return 1;
  }

  zrange(key: string, start: number, stop: number): string[] {
    const entry = this.data.get(key);
    if (!entry) return [];
    this.accountant?.touch(key);

    const results = entry.skipList.range(start, stop);
    return results.map((r) => r.value);
  }

  zscore(key: string, value: string): number | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    const score = entry.scoreMap.get(value);
    return score !== undefined ? score : null;
  }

  zrem(key: string, value: string): number {
    const entry = this.data.get(key);
    if (!entry) return 0;

    const score = entry.scoreMap.get(value);
    if (score === undefined) return 0;

    this.accountant?.credit(zsetMemberCost(value));
    entry.skipList.delete({ score, value });
    entry.scoreMap.delete(value);

    // Clean up empty sets
    if (entry.scoreMap.size === 0) {
      this.data.delete(key);
    }

    return 1;
  }

  /** Number of members in the sorted set. 0 for missing keys. */
  zcard(key: string): number {
    return this.data.get(key)?.scoreMap.size ?? 0;
  }

  /**
   * Number of members whose score falls in [min, max] (inclusive).
   * Linear in the size of the sorted set; can be tightened later if needed.
   */
  zcount(key: string, min: number, max: number): number {
    const entry = this.data.get(key);
    if (!entry) return 0;
    let n = 0;
    for (const score of entry.scoreMap.values()) {
      if (score >= min && score <= max) n++;
    }
    return n;
  }

  /**
   * 0-based rank of `value` (lowest score = rank 0). Ties broken
   * lexicographically. Returns null if the member doesn't exist.
   */
  zrank(key: string, value: string): number | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    const score = entry.scoreMap.get(value);
    if (score === undefined) return null;

    // Skip-list is already in (score asc, value asc) order.
    const sorted = entry.skipList.toArray();
    for (let i = 0; i < sorted.length; i++) {
      const k = sorted[i].key;
      if (k.score === score && k.value === value) return i;
    }
    return null;
  }

  /** Same as zrange but in descending order. */
  zrevrange(key: string, start: number, stop: number): string[] {
    const entry = this.data.get(key);
    if (!entry) return [];
    const all = entry.skipList.toArray();
    const reversed = all.slice().reverse();

    const len = reversed.length;
    const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (s > e || len === 0) return [];

    return reversed.slice(s, e + 1).map((item) => item.key.value);
  }

  /** Members whose score falls in [min, max] (inclusive), ascending. */
  zrangeByScore(key: string, min: number, max: number): string[] {
    const entry = this.data.get(key);
    if (!entry) return [];
    const out: string[] = [];
    for (const item of entry.skipList.toArray()) {
      const s = item.key.score;
      if (s < min) continue;
      if (s > max) break;
      out.push(item.key.value);
    }
    return out;
  }

  /**
   * Increment the score of `value` by `delta`. Creates the member with
   * score `delta` when it doesn't exist (standard ZINCRBY semantics).
   * @returns the new score.
   */
  zincrby(key: string, delta: number, value: string): number {
    this.accountant?.touch(key);
    const entry = this.getOrCreate(key);
    const current = entry.scoreMap.get(value);
    if (current === undefined) {
      // New member — charge for it before inserting.
      this.accountant?.tryCharge(zsetMemberCost(value));
      entry.skipList.set({ score: delta, value }, value);
      entry.scoreMap.set(value, delta);
      return delta;
    }
    const next = current + delta;
    // Member already exists; updating score doesn't change byte cost.
    entry.skipList.delete({ score: current, value });
    entry.skipList.set({ score: next, value }, value);
    entry.scoreMap.set(value, next);
    return next;
  }

  delete(key: string) {
    const entry = this.data.get(key);
    if (entry) {
      for (const v of entry.scoreMap.keys()) {
        this.accountant?.credit(zsetMemberCost(v));
      }
    }
    this.data.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  export(): Record<string, SortedSetMember[]> {
    const result: Record<string, SortedSetMember[]> = {};
    for (const [key, entry] of this.data) {
      const members: SortedSetMember[] = entry.skipList
        .toArray()
        .map((item) => ({ value: item.key.value, score: item.key.score }));
      result[key] = members;
    }
    return result;
  }

  import(data: Record<string, SortedSetMember[]>) {
    // Credit existing entries.
    for (const entry of this.data.values()) {
      for (const v of entry.scoreMap.keys()) {
        this.accountant?.credit(zsetMemberCost(v));
      }
    }
    this.data.clear();
    for (const [key, members] of Object.entries(data)) {
      const entry = this.getOrCreate(key);
      for (const member of members) {
        entry.skipList.set(
          { score: member.score, value: member.value },
          member.value,
        );
        entry.scoreMap.set(member.value, member.score);
        this.accountant?.forceCharge(zsetMemberCost(member.value));
      }
    }
  }
}
