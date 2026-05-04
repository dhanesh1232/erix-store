import type { Router } from "express";
import { Router as createRouter } from "express";
import type { DistributedLockService } from "../../services/DistributedLock.js";

export function createLockRoutes(lock: DistributedLockService): Router {
	const router = createRouter();

	/**
	 * Acquire a lock
	 * POST /lock/acquire
	 */
	router.post("/acquire", async (req, res) => {
		try {
			const { key, ttl, retry, retryDelay, autoRenew } = req.body;

			const token = await lock.acquire(key, {
				ttl,
				retry,
				retryDelay,
				autoRenew,
			});

			if (!token) {
				return res
					.status(409)
					.json({ success: false, error: "Failed to acquire lock" });
			}

			res.json({ success: true, token });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Release a lock
	 * POST /lock/release
	 */
	router.post("/release", async (req, res) => {
		try {
			const { key, token } = req.body;
			const success = await lock.release(key, token);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Lock not found or invalid token" });
			}

			res.json({ success: true });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Renew a lock
	 * POST /lock/renew
	 */
	router.post("/renew", async (req, res) => {
		try {
			const { key, token, ttl } = req.body;
			const success = await lock.renew(key, token, ttl);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Lock not found or invalid token" });
			}

			res.json({ success: true });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Acquire read lock
	 * POST /lock/read/acquire
	 */
	router.post("/read/acquire", async (req, res) => {
		try {
			const { key, ttl, retry, retryDelay } = req.body;

			const token = await lock.acquireRead(key, { ttl, retry, retryDelay });

			if (!token) {
				return res
					.status(409)
					.json({ success: false, error: "Failed to acquire read lock" });
			}

			res.json({ success: true, token });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Release read lock
	 * POST /lock/read/release
	 */
	router.post("/read/release", async (req, res) => {
		try {
			const { key, token } = req.body;
			const success = await lock.releaseRead(key, token);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Read lock not found" });
			}

			res.json({ success: true });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Acquire write lock
	 * POST /lock/write/acquire
	 */
	router.post("/write/acquire", async (req, res) => {
		try {
			const { key, ttl, retry, retryDelay } = req.body;

			const token = await lock.acquireWrite(key, { ttl, retry, retryDelay });

			if (!token) {
				return res
					.status(409)
					.json({ success: false, error: "Failed to acquire write lock" });
			}

			res.json({ success: true, token });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Release write lock
	 * POST /lock/write/release
	 */
	router.post("/write/release", async (req, res) => {
		try {
			const { key, token } = req.body;
			const success = await lock.releaseWrite(key, token);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Write lock not found" });
			}

			res.json({ success: true });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Acquire semaphore
	 * POST /lock/semaphore/acquire
	 */
	router.post("/semaphore/acquire", async (req, res) => {
		try {
			const { key, limit, retry, retryDelay } = req.body;

			const token = await lock.acquireSemaphore(key, limit, {
				retry,
				retryDelay,
			});

			if (!token) {
				return res
					.status(409)
					.json({ success: false, error: "Failed to acquire semaphore" });
			}

			res.json({ success: true, token });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Release semaphore
	 * POST /lock/semaphore/release
	 */
	router.post("/semaphore/release", async (req, res) => {
		try {
			const { key, token } = req.body;
			const success = await lock.releaseSemaphore(key, token);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Semaphore not found" });
			}

			res.json({ success: true });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Check if locked
	 * GET /lock/:key/status
	 */
	router.get("/:key/status", (req, res) => {
		try {
			const { key } = req.params;
			const isLocked = lock.isLocked(key);
			const info = lock.getLockInfo(key);

			res.json({ success: true, isLocked, info });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Get all locks
	 * GET /lock/all
	 */
	router.get("/all", (_req, res) => {
		try {
			const locks = lock.getAllLocks();
			res.json({ success: true, locks, count: locks.length });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Detect deadlocks
	 * GET /lock/deadlocks
	 */
	router.get("/deadlocks", (_req, res) => {
		try {
			const deadlocks = lock.detectDeadlocks();
			res.json({ success: true, deadlocks, count: deadlocks.length });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	/**
	 * Force release (admin)
	 * DELETE /lock/:key/force
	 */
	router.delete("/:key/force", (req, res) => {
		try {
			const { key } = req.params;
			const success = lock.forceRelease(key);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Lock not found" });
			}

			res.json({ success: true });
		} catch (error: any) {
			res.status(500).json({ success: false, error: error.message });
		}
	});

	return router;
}
