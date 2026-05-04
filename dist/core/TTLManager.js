/**
 * TTLManager handles expiration of keys.
 * Supports both active (sweep) and lazy expiry.
 */
export class TTLManager {
    expirations = new Map();
    sweepInterval = null;
    onExpire;
    constructor(onExpire) {
        this.onExpire = onExpire;
        this.startSweep();
    }
    /**
     * Set TTL for a key in seconds
     */
    set(key, ttlSeconds) {
        const expiry = Date.now() + ttlSeconds * 1000;
        this.expirations.set(key, expiry);
    }
    /**
     * Remove TTL for a key
     */
    delete(key) {
        this.expirations.delete(key);
    }
    /**
     * Check if a key is expired (Lazy check)
     */
    isExpired(key) {
        const expiry = this.expirations.get(key);
        if (!expiry)
            return false;
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
    getTTL(key) {
        const expiry = this.expirations.get(key);
        if (!expiry)
            return -1;
        const remaining = Math.ceil((expiry - Date.now()) / 1000);
        return remaining > 0 ? remaining : -1;
    }
    /**
     * Active sweep to remove expired keys
     * Precision: 100ms as requested
     */
    startSweep() {
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
    exportExpirations() {
        return Object.fromEntries(this.expirations);
    }
    importExpirations(data) {
        this.expirations = new Map(Object.entries(data));
    }
}
