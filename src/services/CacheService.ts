import { EventEmitter } from "events";

export interface CacheEntry<T = any> {
	key: string;
	value: T;
	ttl?: number;
	expiresAt?: Date;
	createdAt: Date;
	lastAccessedAt: Date;
	accessCount: number;
	size: number; // bytes
	tags: Set<string>;
	metadata?: Record<string, any>;
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
	metadata?: Record<string, any>;
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
export class CacheService<T = any> extends EventEmitter {
	private cache = new Map<string, CacheEntry<T>>();
	private tagIndex = new Map<string, Set<string>>(); // tag -> keys
	private options: Required<CacheOptions>;
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

		this.startExpiryChecker();
	}

	/**
	 * Get value from cache
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
			this.stats.size -= this.cache.get(key)?.size;
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
	 * Get or set (cache-aside pattern)
	 */
	async getOrSet(
		key: string,
		factory: () => Promise<T>,
		options: SetOptions = {},
	): Promise<T> {
		const cached = this.get(key);
		if (cached !== null) {
			return cached;
		}

		const value = await factory();
		this.set(key, value, options);
		return value;
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

	private startExpiryChecker(): void {
		setInterval(() => {
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
	 * Cleanup
	 */
	destroy(): void {
		this.clear();
		this.removeAllListeners();
	}
}
