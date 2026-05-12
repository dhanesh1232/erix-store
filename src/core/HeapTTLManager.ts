import { BinaryMaxHeap } from "../structures/BinaryHeap.js";

/**
 * TTL entry stored in the min-heap.
 * The `invalidated` flag supports lazy deletion — when a key is deleted,
 * its heap entry is marked invalid rather than performing an O(n) removal.
 */
interface TTLEntry {
	key: string;
	expiresAt: number; // Unix timestamp in milliseconds
	invalidated: boolean;
}

/**
 * HeapTTLManager uses a min-heap (ordered by expiresAt) for efficient TTL expiry.
 *
 * Instead of scanning all keys on every sweep (O(n)), the sweep only peeks at the
 * heap root and extracts entries while `root.expiresAt <= now`. This guarantees
 * no expired key is missed while avoiding full iteration.
 *
 * Lazy deletion: when a key is deleted before its TTL expires, the heap entry is
 * marked as `invalidated`. During sweep, invalidated entries are silently discarded
 * without invoking the `onExpire` callback.
 *
 * @requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export class HeapTTLManager {
	/**
	 * Min-heap ordered by expiresAt (earliest expiration at root).
	 * Uses BinaryMaxHeap with inverted comparator: (a, b) => b.expiresAt - a.expiresAt
	 * so that the entry with the smallest expiresAt is treated as "maximum" by the heap.
	 */
	private heap: BinaryMaxHeap<TTLEntry>;

	/** Maps key -> TTLEntry for O(1) invalidation lookup and TTL queries. */
	private keyIndex: Map<string, TTLEntry>;

	/** Sweep interval timer handle. */
	private sweepInterval: NodeJS.Timeout | null = null;

	/** Callback invoked when a key expires (not called for invalidated entries). */
	private onExpire: (key: string) => void;

	/**
	 * @param onExpire Callback invoked when a key's TTL expires during sweep.
	 * @param sweepIntervalMs Interval between sweep cycles in milliseconds (default: 500).
	 */
	constructor(onExpire: (key: string) => void, sweepIntervalMs: number = 500) {
		this.onExpire = onExpire;
		this.keyIndex = new Map();

		// Inverted comparator: smaller expiresAt = higher priority (min-heap behavior)
		this.heap = new BinaryMaxHeap<TTLEntry>(
			(a: TTLEntry, b: TTLEntry) => b.expiresAt - a.expiresAt,
		);

		this.startSweep(sweepIntervalMs);
	}

	/**
	 * Set TTL for a key. O(log n) heap insertion.
	 * If the key already has a TTL, the old entry is lazily invalidated
	 * and a new entry is inserted.
	 */
	set(key: string, ttlSeconds: number): void {
		// Invalidate any existing entry for this key
		const existing = this.keyIndex.get(key);
		if (existing) {
			existing.invalidated = true;
		}

		const entry: TTLEntry = {
			key,
			expiresAt: Date.now() + ttlSeconds * 1000,
			invalidated: false,
		};

		this.heap.push(entry);
		this.keyIndex.set(key, entry);
	}

	/**
	 * Invalidate (lazy delete) a key's TTL entry. O(1).
	 * The heap entry remains but will be silently discarded during sweep.
	 */
	delete(key: string): void {
		const entry = this.keyIndex.get(key);
		if (entry) {
			entry.invalidated = true;
			this.keyIndex.delete(key);
		}
	}

	/**
	 * Check if a key is expired (lazy check). O(1).
	 * If expired, triggers onExpire callback and cleans up.
	 */
	isExpired(key: string): boolean {
		const entry = this.keyIndex.get(key);
		if (!entry) return false;

		if (Date.now() >= entry.expiresAt) {
			entry.invalidated = true;
			this.keyIndex.delete(key);
			this.onExpire(key);
			return true;
		}

		return false;
	}

	/**
	 * Get remaining TTL in seconds. O(1).
	 * Returns -1 if the key has no TTL set.
	 */
	getTTL(key: string): number {
		const entry = this.keyIndex.get(key);
		if (!entry) return -1;

		const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
		return remaining > 0 ? remaining : -1;
	}

	/**
	 * Export all active (non-invalidated) expirations for persistence.
	 * Returns a record of key -> expiresAt timestamp.
	 */
	exportExpirations(): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [key, entry] of this.keyIndex.entries()) {
			if (!entry.invalidated) {
				result[key] = entry.expiresAt;
			}
		}
		return result;
	}

	/**
	 * Import expirations from persistence data.
	 * Clears existing state and rebuilds the heap from imported data.
	 */
	importExpirations(data: Record<string, number>): void {
		// Clear existing state
		this.keyIndex.clear();

		// Rebuild heap with fresh entries (create a new heap to avoid stale entries)
		this.heap = new BinaryMaxHeap<TTLEntry>(
			(a: TTLEntry, b: TTLEntry) => b.expiresAt - a.expiresAt,
		);

		for (const [key, expiresAt] of Object.entries(data)) {
			const entry: TTLEntry = {
				key,
				expiresAt,
				invalidated: false,
			};
			this.heap.push(entry);
			this.keyIndex.set(key, entry);
		}
	}

	/**
	 * Stop the sweep timer. Call during shutdown.
	 */
	stopSweep(): void {
		if (this.sweepInterval) {
			clearInterval(this.sweepInterval);
			this.sweepInterval = null;
		}
	}

	/**
	 * Start the periodic sweep.
	 * The sweep only peeks at the heap root and extracts entries while
	 * `root.expiresAt <= now`. Invalidated entries are silently discarded.
	 */
	private startSweep(intervalMs: number): void {
		this.sweepInterval = setInterval(() => {
			this.sweep();
		}, intervalMs);
	}

	/**
	 * Perform a single sweep pass.
	 * Extracts expired entries from the heap root until the root is
	 * either not expired or the heap is empty.
	 */
	private sweep(): void {
		const now = Date.now();

		while (this.heap.size > 0) {
			const root = this.heap.peek();
			if (!root) break;

			// Stop if the earliest expiration is in the future
			if (root.expiresAt > now) break;

			// Extract the expired/invalidated entry
			this.heap.pop();

			// Skip invalidated entries silently (lazy deletion)
			if (root.invalidated) continue;

			// Clean up keyIndex and fire callback for genuinely expired keys
			// Only fire if this entry is still the current one for the key
			const current = this.keyIndex.get(root.key);
			if (current === root) {
				this.keyIndex.delete(root.key);
				this.onExpire(root.key);
			}
			// If current !== root, a newer TTL was set for this key — discard silently
		}
	}
}
