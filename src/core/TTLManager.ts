/**
 * TTLManager handles expiration of keys.
 * Supports both active (sweep) and lazy expiry.
 */
export class TTLManager {
	private expirations = new Map<string, number>();
	private sweepInterval: NodeJS.Timeout | null = null;
	private onExpire: (key: string) => void;

	constructor(onExpire: (key: string) => void) {
		this.onExpire = onExpire;
		this.startSweep();
	}

	/**
	 * Set TTL for a key in seconds
	 */
	set(key: string, ttlSeconds: number) {
		const expiry = Date.now() + ttlSeconds * 1000;
		this.expirations.set(key, expiry);
	}

	/**
	 * Remove TTL for a key
	 */
	delete(key: string) {
		this.expirations.delete(key);
	}

	/**
	 * Check if a key is expired (Lazy check)
	 */
	isExpired(key: string): boolean {
		const expiry = this.expirations.get(key);
		if (!expiry) return false;

		if (Date.now() > expiry) {
			this.delete(key);
			this.onExpire(key);
			return true;
		}
		return false;
	}

	/**
	 * Get remaining TTL in seconds
	 */
	getTTL(key: string): number {
		const expiry = this.expirations.get(key);
		if (!expiry) return -1;
		const remaining = Math.ceil((expiry - Date.now()) / 1000);
		return remaining > 0 ? remaining : -1;
	}

	/**
	 * Active sweep to remove expired keys
	 * Precision: 100ms as requested
	 */
	private startSweep() {
		this.sweepInterval = setInterval(() => {
			const now = Date.now();
			for (const [key, expiry] of this.expirations.entries()) {
				if (now > expiry) {
					this.delete(key);
					this.onExpire(key);
				}
			}
		}, 100);
	}

	stopSweep() {
		if (this.sweepInterval) {
			clearInterval(this.sweepInterval);
		}
	}

	// For persistence
	exportExpirations(): Record<string, number> {
		return Object.fromEntries(this.expirations);
	}

	importExpirations(data: Record<string, number>) {
		this.expirations = new Map(Object.entries(data));
	}
}
