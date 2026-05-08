interface RateLimitEntry {
	count: number;
	resetAt: number;
}

export class RateLimiterService {
	private limits = new Map<string, RateLimitEntry>();
	// Prune expired entries every 5 minutes to prevent unbounded Map growth
	private pruneInterval: NodeJS.Timeout;

	constructor() {
		this.pruneInterval = setInterval(() => this.pruneExpired(), 5 * 60 * 1000);
	}

	/**
	 * @param key Unique key for rate limit (e.g. tenant:id:feature)
	 * @param limit Max allowed calls in window
	 * @param windowSeconds Window duration in seconds
	 * @returns { allowed, remaining, resetAt }
	 */
	async check(
		key: string,
		limit: number,
		windowSeconds: number,
	): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
		const now = Date.now();
		let entry = this.limits.get(key);

		if (!entry || now > entry.resetAt) {
			entry = {
				count: 0,
				resetAt: now + windowSeconds * 1000,
			};
		}

		entry.count++;
		this.limits.set(key, entry);

		const allowed = entry.count <= limit;
		const remaining = Math.max(0, limit - entry.count);

		return {
			allowed,
			remaining,
			resetAt: entry.resetAt,
		};
	}

	/** Remove entries whose window has already expired */
	private pruneExpired(): void {
		const now = Date.now();
		for (const [key, entry] of this.limits.entries()) {
			if (now > entry.resetAt) {
				this.limits.delete(key);
			}
		}
	}

	/** Stop the background prune timer (call on shutdown) */
	destroy(): void {
		clearInterval(this.pruneInterval);
	}

	export() {
		return Object.fromEntries(this.limits);
	}

	import(data: Record<string, RateLimitEntry>) {
		this.limits = new Map(Object.entries(data));
	}
}
