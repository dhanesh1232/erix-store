export class RateLimiterService {
    limits = new Map();
    // Prune expired entries every 5 minutes to prevent unbounded Map growth
    pruneInterval;
    constructor() {
        this.pruneInterval = setInterval(() => this.pruneExpired(), 5 * 60 * 1000);
    }
    /**
     * @param key Unique key for rate limit (e.g. tenant:id:feature)
     * @param limit Max allowed calls in window
     * @param windowSeconds Window duration in seconds
     * @returns { allowed, remaining, resetAt }
     */
    async check(key, limit, windowSeconds) {
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
    pruneExpired() {
        const now = Date.now();
        for (const [key, entry] of this.limits.entries()) {
            if (now > entry.resetAt) {
                this.limits.delete(key);
            }
        }
    }
    /** Stop the background prune timer (call on shutdown) */
    destroy() {
        clearInterval(this.pruneInterval);
    }
    export() {
        return Object.fromEntries(this.limits);
    }
    import(data) {
        this.limits = new Map(Object.entries(data));
    }
}
