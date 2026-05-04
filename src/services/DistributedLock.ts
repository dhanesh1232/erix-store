import { EventEmitter } from "events";

export interface LockOptions {
	ttl?: number; // Time to live in milliseconds
	retry?: number; // Number of retry attempts
	retryDelay?: number; // Delay between retries in ms
	autoRenew?: boolean; // Auto-renew lock before expiry
	renewInterval?: number; // Renewal interval (should be < ttl)
}

export interface Lock {
	key: string;
	token: string;
	acquiredAt: Date;
	expiresAt: Date;
	owner: string;
	metadata?: Record<string, any>;
}

export interface ReadWriteLockState {
	readers: Set<string>;
	writer: string | null;
	writerExpiresAt: Date | null;
}

/**
 * Distributed Lock Service
 * Features:
 * - Mutex locks (exclusive)
 * - Read/Write locks (multiple readers, single writer)
 * - Semaphores (limited concurrency)
 * - Lock renewal (heartbeat)
 * - Deadlock detection
 * - Lock monitoring
 */
export class DistributedLockService extends EventEmitter {
	private locks = new Map<string, Lock>();
	private rwLocks = new Map<string, ReadWriteLockState>();
	private semaphores = new Map<
		string,
		{ limit: number; holders: Set<string> }
	>();
	private renewalTimers = new Map<string, NodeJS.Timeout>();
	private lockWaiters = new Map<string, Array<() => void>>();

	constructor() {
		super();
		this.startExpiryChecker();
	}

	/**
	 * Acquire an exclusive lock
	 */
	async acquire(
		key: string,
		options: LockOptions = {},
	): Promise<string | null> {
		const {
			ttl = 30000,
			retry = 3,
			retryDelay = 1000,
			autoRenew = false,
			renewInterval = ttl * 0.7,
		} = options;

		for (let attempt = 0; attempt <= retry; attempt++) {
			const token = this.tryAcquire(key, ttl);

			if (token) {
				// Setup auto-renewal if enabled
				if (autoRenew) {
					this.setupAutoRenewal(key, token, ttl, renewInterval);
				}

				this.emit("lock:acquired", { key, token });
				return token;
			}

			// Wait before retry
			if (attempt < retry) {
				await this.sleep(retryDelay);
			}
		}

		this.emit("lock:failed", { key });
		return null;
	}

	/**
	 * Try to acquire lock (non-blocking)
	 */
	private tryAcquire(key: string, ttl: number): string | null {
		const existingLock = this.locks.get(key);

		// Check if lock exists and is not expired
		if (existingLock && existingLock.expiresAt.getTime() > Date.now()) {
			return null;
		}

		// Acquire lock
		const token = this.generateToken();
		const lock: Lock = {
			key,
			token,
			acquiredAt: new Date(),
			expiresAt: new Date(Date.now() + ttl),
			owner: this.getProcessId(),
		};

		this.locks.set(key, lock);
		return token;
	}

	/**
	 * Release a lock
	 */
	async release(key: string, token: string): Promise<boolean> {
		const lock = this.locks.get(key);

		if (!lock || lock.token !== token) {
			return false;
		}

		this.locks.delete(key);
		this.clearAutoRenewal(key);
		this.emit("lock:released", { key, token });

		// Notify waiters
		this.notifyWaiters(key);

		return true;
	}

	/**
	 * Renew a lock
	 */
	async renew(key: string, token: string, ttl: number): Promise<boolean> {
		const lock = this.locks.get(key);

		if (!lock || lock.token !== token) {
			return false;
		}

		lock.expiresAt = new Date(Date.now() + ttl);
		this.emit("lock:renewed", { key, token });
		return true;
	}

	/**
	 * Execute function with lock
	 */
	async withLock<T>(
		key: string,
		fn: () => Promise<T>,
		options: LockOptions = {},
	): Promise<T> {
		const token = await this.acquire(key, options);

		if (!token) {
			throw new Error(`Failed to acquire lock: ${key}`);
		}

		try {
			return await fn();
		} finally {
			await this.release(key, token);
		}
	}

	/**
	 * Acquire read lock (multiple readers allowed)
	 */
	async acquireRead(
		key: string,
		options: LockOptions = {},
	): Promise<string | null> {
		const { ttl = 30000, retry = 3, retryDelay = 1000 } = options;

		for (let attempt = 0; attempt <= retry; attempt++) {
			const token = this.tryAcquireRead(key, ttl);

			if (token) {
				this.emit("lock:read:acquired", { key, token });
				return token;
			}

			if (attempt < retry) {
				await this.sleep(retryDelay);
			}
		}

		return null;
	}

	/**
	 * Try to acquire read lock
	 */
	private tryAcquireRead(key: string, _ttl: number): string | null {
		let state = this.rwLocks.get(key);

		if (!state) {
			state = { readers: new Set(), writer: null, writerExpiresAt: null };
			this.rwLocks.set(key, state);
		}

		// Can't acquire read lock if there's an active writer
		if (
			state.writer &&
			state.writerExpiresAt &&
			state.writerExpiresAt.getTime() > Date.now()
		) {
			return null;
		}

		const token = this.generateToken();
		state.readers.add(token);
		return token;
	}

	/**
	 * Release read lock
	 */
	async releaseRead(key: string, token: string): Promise<boolean> {
		const state = this.rwLocks.get(key);

		if (!state?.readers.has(token)) {
			return false;
		}

		state.readers.delete(token);
		this.emit("lock:read:released", { key, token });

		// Cleanup if no more readers
		if (state.readers.size === 0 && !state.writer) {
			this.rwLocks.delete(key);
		}

		this.notifyWaiters(key);
		return true;
	}

	/**
	 * Acquire write lock (exclusive)
	 */
	async acquireWrite(
		key: string,
		options: LockOptions = {},
	): Promise<string | null> {
		const { ttl = 30000, retry = 3, retryDelay = 1000 } = options;

		for (let attempt = 0; attempt <= retry; attempt++) {
			const token = this.tryAcquireWrite(key, ttl);

			if (token) {
				this.emit("lock:write:acquired", { key, token });
				return token;
			}

			if (attempt < retry) {
				await this.sleep(retryDelay);
			}
		}

		return null;
	}

	/**
	 * Try to acquire write lock
	 */
	private tryAcquireWrite(key: string, ttl: number): string | null {
		let state = this.rwLocks.get(key);

		if (!state) {
			state = { readers: new Set(), writer: null, writerExpiresAt: null };
			this.rwLocks.set(key, state);
		}

		// Can't acquire write lock if there are readers or another writer
		if (
			state.readers.size > 0 ||
			(state.writer &&
				state.writerExpiresAt &&
				state.writerExpiresAt.getTime() > Date.now())
		) {
			return null;
		}

		const token = this.generateToken();
		state.writer = token;
		state.writerExpiresAt = new Date(Date.now() + ttl);
		return token;
	}

	/**
	 * Release write lock
	 */
	async releaseWrite(key: string, token: string): Promise<boolean> {
		const state = this.rwLocks.get(key);

		if (!state || state.writer !== token) {
			return false;
		}

		state.writer = null;
		state.writerExpiresAt = null;
		this.emit("lock:write:released", { key, token });

		// Cleanup if no readers
		if (state.readers.size === 0) {
			this.rwLocks.delete(key);
		}

		this.notifyWaiters(key);
		return true;
	}

	/**
	 * Acquire semaphore (limited concurrency)
	 */
	async acquireSemaphore(
		key: string,
		limit: number,
		options: LockOptions = {},
	): Promise<string | null> {
		const { retry = 3, retryDelay = 1000 } = options;

		for (let attempt = 0; attempt <= retry; attempt++) {
			const token = this.tryAcquireSemaphore(key, limit);

			if (token) {
				this.emit("semaphore:acquired", { key, token, limit });
				return token;
			}

			if (attempt < retry) {
				await this.sleep(retryDelay);
			}
		}

		return null;
	}

	/**
	 * Try to acquire semaphore
	 */
	private tryAcquireSemaphore(key: string, limit: number): string | null {
		let semaphore = this.semaphores.get(key);

		if (!semaphore) {
			semaphore = { limit, holders: new Set() };
			this.semaphores.set(key, semaphore);
		}

		if (semaphore.holders.size >= limit) {
			return null;
		}

		const token = this.generateToken();
		semaphore.holders.add(token);
		return token;
	}

	/**
	 * Release semaphore
	 */
	async releaseSemaphore(key: string, token: string): Promise<boolean> {
		const semaphore = this.semaphores.get(key);

		if (!semaphore?.holders.has(token)) {
			return false;
		}

		semaphore.holders.delete(token);
		this.emit("semaphore:released", { key, token });

		// Cleanup if no holders
		if (semaphore.holders.size === 0) {
			this.semaphores.delete(key);
		}

		this.notifyWaiters(key);
		return true;
	}

	/**
	 * Wait for lock to become available
	 */
	async waitForLock(key: string, timeout: number = 30000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.removeWaiter(key, waiter);
				reject(new Error(`Lock wait timeout: ${key}`));
			}, timeout);

			const waiter = () => {
				clearTimeout(timer);
				resolve();
			};

			if (!this.lockWaiters.has(key)) {
				this.lockWaiters.set(key, []);
			}
			this.lockWaiters.get(key)?.push(waiter);
		});
	}

	/**
	 * Check if lock is held
	 */
	isLocked(key: string): boolean {
		const lock = this.locks.get(key);
		return lock ? lock.expiresAt.getTime() > Date.now() : false;
	}

	/**
	 * Get lock info
	 */
	getLockInfo(key: string): Lock | null {
		return this.locks.get(key) ?? null;
	}

	/**
	 * Get all locks
	 */
	getAllLocks(): Lock[] {
		return Array.from(this.locks.values());
	}

	/**
	 * Detect potential deadlocks
	 */
	detectDeadlocks(): string[] {
		const deadlocks: string[] = [];
		const now = Date.now();

		// Simple deadlock detection: locks held for too long
		for (const [key, lock] of this.locks.entries()) {
			const holdTime = now - lock.acquiredAt.getTime();
			if (holdTime > 300000) {
				// 5 minutes
				deadlocks.push(key);
			}
		}

		return deadlocks;
	}

	/**
	 * Force release a lock (admin operation)
	 */
	forceRelease(key: string): boolean {
		const lock = this.locks.get(key);
		if (!lock) return false;

		this.locks.delete(key);
		this.clearAutoRenewal(key);
		this.emit("lock:force:released", { key });
		this.notifyWaiters(key);
		return true;
	}

	// Private helper methods

	private setupAutoRenewal(
		key: string,
		token: string,
		ttl: number,
		interval: number,
	): void {
		const timer = setInterval(async () => {
			const renewed = await this.renew(key, token, ttl);
			if (!renewed) {
				this.clearAutoRenewal(key);
			}
		}, interval);

		this.renewalTimers.set(key, timer);
	}

	private clearAutoRenewal(key: string): void {
		const timer = this.renewalTimers.get(key);
		if (timer) {
			clearInterval(timer);
			this.renewalTimers.delete(key);
		}
	}

	private notifyWaiters(key: string): void {
		const waiters = this.lockWaiters.get(key);
		if (waiters && waiters.length > 0) {
			const waiter = waiters.shift();
			if (waiter) waiter();
		}
	}

	private removeWaiter(key: string, waiter: () => void): void {
		const waiters = this.lockWaiters.get(key);
		if (waiters) {
			const index = waiters.indexOf(waiter);
			if (index !== -1) waiters.splice(index, 1);
		}
	}

	private startExpiryChecker(): void {
		setInterval(() => {
			const now = Date.now();

			// Check mutex locks
			for (const [key, lock] of this.locks.entries()) {
				if (lock.expiresAt.getTime() <= now) {
					this.locks.delete(key);
					this.clearAutoRenewal(key);
					this.emit("lock:expired", { key });
					this.notifyWaiters(key);
				}
			}

			// Check write locks
			for (const [key, state] of this.rwLocks.entries()) {
				if (
					state.writer &&
					state.writerExpiresAt &&
					state.writerExpiresAt.getTime() <= now
				) {
					state.writer = null;
					state.writerExpiresAt = null;
					this.emit("lock:write:expired", { key });
					this.notifyWaiters(key);
				}
			}
		}, 1000); // Check every second
	}

	private generateToken(): string {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	private getProcessId(): string {
		return `${process.pid}-${Date.now()}`;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Export for persistence
	 */
	export() {
		return {
			locks: Array.from(this.locks.entries()),
			rwLocks: Array.from(this.rwLocks.entries()).map(([key, state]) => [
				key,
				{
					readers: Array.from(state.readers),
					writer: state.writer,
					writerExpiresAt: state.writerExpiresAt,
				},
			]),
			semaphores: Array.from(this.semaphores.entries()).map(([key, sem]) => [
				key,
				{ limit: sem.limit, holders: Array.from(sem.holders) },
			]),
		};
	}

	/**
	 * Import from persistence
	 */
	import(data: any): void {
		if (data.locks) {
			this.locks = new Map(data.locks);
		}
		if (data.rwLocks) {
			this.rwLocks = new Map(
				data.rwLocks.map(([key, state]: any) => [
					key,
					{
						readers: new Set(state.readers),
						writer: state.writer,
						writerExpiresAt: state.writerExpiresAt
							? new Date(state.writerExpiresAt)
							: null,
					},
				]),
			);
		}
		if (data.semaphores) {
			this.semaphores = new Map(
				data.semaphores.map(([key, sem]: any) => [
					key,
					{ limit: sem.limit, holders: new Set(sem.holders) },
				]),
			);
		}
	}

	/**
	 * Cleanup
	 */
	destroy(): void {
		for (const timer of this.renewalTimers.values()) {
			clearInterval(timer);
		}
		this.renewalTimers.clear();
		this.removeAllListeners();
	}
}
