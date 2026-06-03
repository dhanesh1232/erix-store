/**
 * @file byteCost.ts
 * @module Core/ByteCost
 *
 * Approximate memory accounting for stored values.
 *
 * What this is, and what it isn't
 * --------------------------------
 * `usedBytes` is **not** a true measurement of process RSS. JavaScript
 * gives us no portable way to measure a value's heap footprint. What we
 * have instead is a pure function from a value's *shape* to a budget
 * number. The budget is:
 *
 *   - **Monotonic**: bigger values cost more.
 *   - **Consistent**: the same shape always charges the same.
 *   - **Conservative**: per-entry overhead is included so small payloads
 *     don't undercount the V8 wrapper cost.
 *
 * That makes `maxmemory` enforceable: a configured cap will trip
 * predictably, and the LRU eviction loop will release the same number
 * of bytes that the next write would charge.
 *
 * The constants below are intentionally simple. Tuning them changes
 * the *threshold* at which evictions kick in, not their correctness.
 *
 * @requirements P2.1 — max-memory cap with LRU eviction
 */

/** Per-key bookkeeping overhead (registry entry, LRU node, TTL bookkeeping). */
const PER_KEY_OVERHEAD = 64;

/** Per string-byte cost — V8 strings are 2 bytes/char + a small header. */
const STRING_COST_PER_CHAR = 2;
const STRING_HEADER = 16;

/** Per-entry overhead for hash fields, set members, list nodes, zset members. */
const PER_ENTRY_OVERHEAD = 48;

/** Cost of a UTF-16-style string. */
function stringCost(s: string): number {
	return STRING_HEADER + s.length * STRING_COST_PER_CHAR;
}

/** Total cost of the *key name itself* including bookkeeping overhead. */
export function keyOverheadCost(key: string): number {
	return PER_KEY_OVERHEAD + stringCost(key);
}

/** Cost of a string value stored under a key. */
export function stringValueCost(value: string): number {
	return stringCost(value);
}

/** Cost of a single hash field/value pair. */
export function hashFieldCost(field: string, value: string): number {
	return PER_ENTRY_OVERHEAD + stringCost(field) + stringCost(value);
}

/** Cost of a single list element. */
export function listEntryCost(value: string): number {
	return PER_ENTRY_OVERHEAD + stringCost(value);
}

/** Cost of a single set member. */
export function setMemberCost(value: string): number {
	return PER_ENTRY_OVERHEAD + stringCost(value);
}

/** Cost of a single sorted-set member (member string + score). */
export function zsetMemberCost(value: string): number {
	// 8 bytes for the score (double).
	return PER_ENTRY_OVERHEAD + stringCost(value) + 8;
}
