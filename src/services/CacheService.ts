import { EventEmitter } from "events";

export interface CacheEntry<T = unknown> {
	key: string;
	value: T;
	ttl?: number;
	expiresAt?: Date;
	createdAt: Date;
	lastAccessedAt: Date;
	accessCount: number;
	size: number; // bytes
	tags: Set<string>;
	metadata?: Record<string, unknown>;
}

export interface CacheOptions {
	strategy?: "LRU" | "LFU" | "FIFO";
	maxSize?: number; // bytes
	maxEntries?: number;
	defaultTTL?: number; // ms
	enableStats?: boolean;
}

export interface CacheStats {
	hits: number;
	misses: number;
	hitRate: number;
	size: number; // bytes
	entries: number;
	evictions: number;
	expirations: number;
}

export interface SetOptions {
	ttl?: number;
	tags?: string[];
	metadata?: Record<string, unknown>;
	/**
	 * Stale-While-Revalidate: seconds to serve the old value after TTL expires
	 * while a background refresh runs. Callers never block on a cache miss.
	 */
	staleFor?: number;
}

/**
 * Advanced Cache Service
 * Features:
 * - LRU/LFU/FIFO eviction strategies
 * - Tag-based invalidation
 * - Pattern matching invalidation
 * - Cache statistics
 * - Memory management
 * - TTL support
 */
export class CacheService<T = unknown> extends EventEmitter {
	private cache = new Map<string, CacheEntry<T>>();
	private tagIndex = new Map<string, Set<string>>(); // tag -> keys
	private options: Required<CacheOptions>;
	// Stored so destroy() can cancel it and prevent timer leak
	private expiryCheckerInterval: NodeJS.Timeout;
	/** Single-flight map: prevents cache stampede on concurrent misses */
	private inFlight = new Map<string, Promise<unknown>>();
	/** Stale-While-Revalidate: stores values past TTL for graceful background refresh */
	private staleData = new Map<string, { value: unknown; serveUntil: number }>();
	private stats: CacheStats = {
		hits: 0,
		misses: 0,
		hitRate: 0,
		size: 0,
		entries: 0,
		evictions: 0,
		expirations: 0,
	};

	constructor(options: CacheOptions = {}) {
		super();
		this.options = {
			strategy: options.strategy ?? "LRU",
			maxSize: options.maxSize ?? 100 * 1024 * 1024, // 100MB
			maxEntries: options.maxEntries ?? 10000,
			defaultTTL: options.defaultTTL ?? 3600000, // 1 hour
			enableStats: options.enableStats ?? true,
		};

		this.expiryCheckerInterval = this.startExpiryChecker();
	}

	/**
	 * Get value from cache. Returns null on miss (use getOrSet to avoid stampedes).
	 */
	get(key: string): T | null {
		const entry = this.cache.get(key);

		if (!entry) {
			this.recordMiss();
			return null;
		}

		// Check expiry
		if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
			this.delete(key);
			this.recordMiss();
			this.stats.expirations++;
			return null;
		}

		// Update access metadata
		entry.lastAccessedAt = new Date();
		entry.accessCount++;

		this.recordHit();
		this.emit("cache:hit", { key });
		return entry.value;
	}

	/**
	 * Get a value or compute it if missing — with stampede protection.
	 *
	 * On a cache miss, only ONE call to `fn()` runs. All concurrent callers
	 * share the same Promise and receive the same result.
	 *
	 * With `staleFor` set: returns the stale value immediately while
	 * triggering a background refresh — zero latency for the caller.
	 *
	 * @example
	 * const user = await cache.getOrSet(
	 *   `user:${id}`,
	 *   () => db.users.findById(id),
	 *   { ttl: 60_000, staleFor: 300_000 }
	 * );
	 */
	async getOrSet<V = T>(
		key: string,
		fn: () => Promise<V>,
		options: SetOptions = {},
	): Promise<V> {
		// Fast path — fresh hit
		const cached = this.get(key);
		if (cached !== null) return cached as unknown as V;

		// Stale-While-Revalidate: serve stale immediately, refresh in background
		const stale = this.staleData.get(key);
		if (stale && Date.now() < stale.serveUntil) {
			// Only trigger one background refresh at a time
			if (!this.inFlight.has(key)) {
				const refresh = fn()
					.then((value) => {
						this.set(key, value as unknown as T, options);
						this.staleData.delete(key);
						return value;
					})
					.finally(() => this.inFlight.delete(key));
				this.inFlight.set(key, refresh);
			}
			this.emit("cache:stale", { key });
			return stale.value as V;
		}

		// Stampede protection: if already fetching, share the same promise
		if (this.inFlight.has(key)) {
			return this.inFlight.get(key) as Promise<V>;
		}

		// Cold miss — we are the designated fetcher
		const promise = fn()
			.then((value) => {
				this.set(key, value as unknown as T, options);
				// Register stale window if requested
				if (options.staleFor && options.ttl) {
					this.staleData.set(key, {
						value,
						serveUntil: Date.now() + options.ttl + options.staleFor,
					});
				}
				return value;
			})
			.finally(() => this.inFlight.delete(key));

		this.inFlight.set(key, promise);
		return promise;
	}

	/**
	 * Set value in cache
	 */
	set(key: string, value: T, options: SetOptions = {}): boolean {
		const { ttl = this.options.defaultTTL, tags = [], metadata } = options;

		const size = this.estimateSize(value);

		// Check if we need to evict
		if (this.shouldEvict(size)) {
			this.evict(size);
		}

		const entry: CacheEntry<T> = {
			key,
			value,
			ttl,
			expiresAt: ttl ? new Date(Date.now() + ttl) : undefined,
			createdAt: new Date(),
			lastAccessedAt: new Date(),
			accessCount: 0,
			size,
			tags: new Set(tags),
			metadata,
		};

		// Remove old entry if exists
		if (this.cache.has(key)) {
			this.removeFromTagIndex(key);
			this.stats.size -= this.cache.get(key)?.size || 0;
		}

		this.cache.set(key, entry);
		this.stats.size += size;
		this.stats.entries = this.cache.size;

		// Update tag index
		for (const tag of tags) {
			if (!this.tagIndex.has(tag)) {
				this.tagIndex.set(tag, new Set());
			}
			this.tagIndex.get(tag)?.add(key);
		}

		this.emit("cache:set", { key, size });
		return true;
	}

	/**
	 * Delete key from cache
	 */
	delete(key: string): boolean {
		const entry = this.cache.get(key);
		if (!entry) return false;

		this.cache.delete(key);
		this.removeFromTagIndex(key);
		this.stats.size -= entry.size;
		this.stats.entries = this.cache.size;

		this.emit("cache:delete", { key });
		return true;
	}

	/**
	 * Check if key exists
	 */
	has(key: string): boolean {
		const entry = this.cache.get(key);
		if (!entry) return false;

		// Check expiry
		if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
			this.delete(key);
			return false;
		}

		return true;
	}

	/**
	 * Get multiple keys
	 */
	mget(keys: string[]): Map<string, T> {
		const result = new Map<string, T>();

		for (const key of keys) {
			const value = this.get(key);
			if (value !== null) {
				result.set(key, value);
			}
		}

		return result;
	}

	/**
	 * Set multiple keys
	 */
	mset(entries: Array<{ key: string; value: T; options?: SetOptions }>): void {
		for (const { key, value, options } of entries) {
			this.set(key, value, options);
		}
	}

	/**
	 * Invalidate by tag
	 */
	invalidateByTag(tag: string): number {
		const keys = this.tagIndex.get(tag);
		if (!keys) return 0;

		let count = 0;
		for (const key of Array.from(keys)) {
			if (this.delete(key)) count++;
		}

		this.tagIndex.delete(tag);
		this.emit("cache:invalidate:tag", { tag, count });
		return count;
	}

	/**
	 * Invalidate by multiple tags
	 */
	invalidateByTags(tags: string[]): number {
		let count = 0;
		for (const tag of tags) {
			count += this.invalidateByTag(tag);
		}
		return count;
	}

	/**
	 * Invalidate by pattern (wildcard matching)
	 */
	invalidateByPattern(pattern: string): number {
		const regex = this.patternToRegex(pattern);
		const keysToDelete: string[] = [];

		for (const key of this.cache.keys()) {
			if (regex.test(key)) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			this.delete(key);
		}

		this.emit("cache:invalidate:pattern", {
			pattern,
			count: keysToDelete.length,
		});
		return keysToDelete.length;
	}

	/**
	 * Warm cache with data
	 */
	async warm(
		keys: string[],
		factory: (key: string) => Promise<T>,
		options: SetOptions = {},
	): Promise<void> {
		const promises = keys.map(async (key) => {
			const value = await factory(key);
			this.set(key, value, options);
		});

		await Promise.all(promises);
		this.emit("cache:warmed", { count: keys.length });
	}

	/**
	 * Get cache statistics
	 */
	getStats(): CacheStats {
		const total = this.stats.hits + this.stats.misses;
		this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
		return { ...this.stats };
	}

	/**
	 * Reset statistics
	 */
	resetStats(): void {
		this.stats = {
			hits: 0,
			misses: 0,
			hitRate: 0,
			size: this.stats.size,
			entries: this.stats.entries,
			evictions: 0,
			expirations: 0,
		};
	}

	/**
	 * Get all keys
	 */
	keys(): string[] {
		return Array.from(this.cache.keys());
	}

	/**
	 * Get keys by tag
	 */
	keysByTag(tag: string): string[] {
		return Array.from(this.tagIndex.get(tag) ?? []);
	}

	/**
	 * Clear all cache
	 */
	clear(): void {
		const count = this.cache.size;
		this.cache.clear();
		this.tagIndex.clear();
		this.stats.size = 0;
		this.stats.entries = 0;
		this.emit("cache:cleared", { count });
	}

	/**
	 * Get cache entry metadata
	 */
	getEntry(key: string): CacheEntry<T> | null {
		return this.cache.get(key) ?? null;
	}

	/**
	 * Get memory usage
	 */
	getMemoryUsage(): {
		used: number;
		max: number;
		percentage: number;
	} {
		return {
			used: this.stats.size,
			max: this.options.maxSize,
			percentage: (this.stats.size / this.options.maxSize) * 100,
		};
	}

	// Private methods

	private shouldEvict(newEntrySize: number): boolean {
		return (
			this.stats.size + newEntrySize > this.options.maxSize ||
			this.cache.size >= this.options.maxEntries
		);
	}

	private evict(requiredSpace: number): void {
		const strategy = this.options.strategy;

		if (strategy === "LRU") {
			this.evictLRU(requiredSpace);
		} else if (strategy === "LFU") {
			this.evictLFU(requiredSpace);
		} else if (strategy === "FIFO") {
			this.evictFIFO(requiredSpace);
		}
	}

	private evictLRU(requiredSpace: number): void {
		const entries = Array.from(this.cache.entries());
		entries.sort(
			([, a], [, b]) => a.lastAccessedAt.getTime() - b.lastAccessedAt.getTime(),
		);

		let freedSpace = 0;
		let count = 0;

		for (const [key] of entries) {
			if (
				freedSpace >= requiredSpace &&
				this.cache.size < this.options.maxEntries
			) {
				break;
			}

			const entry = this.cache.get(key)!;
			freedSpace += entry.size;
			this.delete(key);
			count++;
		}

		this.stats.evictions += count;
		this.emit("cache:evicted", { strategy: "LRU", count, freedSpace });
	}

	private evictLFU(requiredSpace: number): void {
		const entries = Array.from(this.cache.entries());
		entries.sort(([, a], [, b]) => a.accessCount - b.accessCount);

		let freedSpace = 0;
		let count = 0;

		for (const [key] of entries) {
			if (
				freedSpace >= requiredSpace &&
				this.cache.size < this.options.maxEntries
			) {
				break;
			}

			const entry = this.cache.get(key)!;
			freedSpace += entry.size;
			this.delete(key);
			count++;
		}

		this.stats.evictions += count;
		this.emit("cache:evicted", { strategy: "LFU", count, freedSpace });
	}

	private evictFIFO(requiredSpace: number): void {
		const entries = Array.from(this.cache.entries());
		entries.sort(
			([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime(),
		);

		let freedSpace = 0;
		let count = 0;

		for (const [key] of entries) {
			if (
				freedSpace >= requiredSpace &&
				this.cache.size < this.options.maxEntries
			) {
				break;
			}

			const entry = this.cache.get(key)!;
			freedSpace += entry.size;
			this.delete(key);
			count++;
		}

		this.stats.evictions += count;
		this.emit("cache:evicted", { strategy: "FIFO", count, freedSpace });
	}

	private removeFromTagIndex(key: string): void {
		const entry = this.cache.get(key);
		if (!entry) return;

		for (const tag of entry.tags) {
			const keys = this.tagIndex.get(tag);
			if (keys) {
				keys.delete(key);
				if (keys.size === 0) {
					this.tagIndex.delete(tag);
				}
			}
		}
	}

	private estimateSize(value: any): number {
		const json = JSON.stringify(value);
		return new Blob([json]).size;
	}

	private patternToRegex(pattern: string): RegExp {
		const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
		return new RegExp(`^${regex}$`);
	}

	private recordHit(): void {
		if (this.options.enableStats) {
			this.stats.hits++;
		}
	}

	private recordMiss(): void {
		if (this.options.enableStats) {
			this.stats.misses++;
		}
	}

	/** Returns the interval handle so it can be stored and cancelled on destroy() */
	private startExpiryChecker(): NodeJS.Timeout {
		return setInterval(() => {
			const now = Date.now();
			const keysToDelete: string[] = [];

			for (const [key, entry] of this.cache.entries()) {
				if (entry.expiresAt && entry.expiresAt.getTime() <= now) {
					keysToDelete.push(key);
				}
			}

			for (const key of keysToDelete) {
				this.delete(key);
				this.stats.expirations++;
			}

			if (keysToDelete.length > 0) {
				this.emit("cache:expired", { count: keysToDelete.length });
			}
		}, 5000); // Check every 5 seconds
	}

	/**
	 * Export for persistence
	 */
	export() {
		return {
			cache: Array.from(this.cache.entries()).map(([key, entry]) => [
				key,
				{
					...entry,
					tags: Array.from(entry.tags),
				},
			]),
			tagIndex: Array.from(this.tagIndex.entries()).map(([tag, keys]) => [
				tag,
				Array.from(keys),
			]),
			stats: this.stats,
		};
	}

	/**
	 * Import from persistence
	 */
	import(data: any): void {
		if (data.cache) {
			this.cache = new Map(
				data.cache.map(([key, entry]: any) => [
					key,
					{
						...entry,
						tags: new Set(entry.tags),
						createdAt: new Date(entry.createdAt),
						lastAccessedAt: new Date(entry.lastAccessedAt),
						expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : undefined,
					},
				]),
			);
		}

		if (data.tagIndex) {
			this.tagIndex = new Map(
				data.tagIndex.map(([tag, keys]: any) => [tag, new Set(keys)]),
			);
		}

		if (data.stats) {
			this.stats = data.stats;
		}
	}

	/**
	 * Cleanup — cancels timers, clears cache, removes listeners
	 */
	destroy(): void {
		clearInterval(this.expiryCheckerInterval);
		this.clear();
		this.removeAllListeners();
	}
}
