"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiterService = void 0;
class RateLimiterService {
    limits = new Map();
    /**
     * @param key Unique key for rate limit (e.g. tenant:id:feature)
     * @param limit Max allowed calls in window
     * @param windowSeconds Window duration in seconds
     * @returns boolean true if allowed, false if limited
     */
    async check(key, limit, windowSeconds) {
        const now = Date.now();
        let entry = this.limits.get(key);
        if (!entry || now > entry.resetAt) {
            entry = {
                count: 0,
                resetAt: now + windowSeconds * 1000
            };
        }
        entry.count++;
        this.limits.set(key, entry);
        const allowed = entry.count <= limit;
        const remaining = Math.max(0, limit - entry.count);
        return {
            allowed,
            remaining,
            resetAt: entry.resetAt
        };
    }
    export() {
        return Object.fromEntries(this.limits);
    }
    import(data) {
        this.limits = new Map(Object.entries(data));
    }
}
exports.RateLimiterService = RateLimiterService;
