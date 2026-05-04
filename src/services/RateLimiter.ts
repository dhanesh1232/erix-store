interface RateLimitEntry {
	count: number;
	resetAt: number;
}

export class RateLimiterService {
	private limits = new Map<string, RateLimitEntry>();

	/**
	 * @param key Unique key for rate limit (e.g. tenant:id:feature)
	 * @param limit Max allowed calls in window
	 * @param windowSeconds Window duration in seconds
	 * @returns boolean true if allowed, false if limited
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

	export() {
		return Object.fromEntries(this.limits);
	}

	import(data: Record<string, RateLimitEntry>) {
		this.limits = new Map(Object.entries(data));
	}
}
