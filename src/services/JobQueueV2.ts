import { EventEmitter } from "events";

export interface Job {
	id: string;
	queueName: string;
	data: unknown;
	priority: number; // 1-10, higher = more important
	attempts: number;
	maxAttempts: number;
	status: "waiting" | "active" | "completed" | "failed" | "delayed";
	runAt: Date;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	failedAt?: Date;
	/** Updated by worker heartbeat — used by reaper to detect zombie jobs */
	heartbeatAt?: Date;
	error?: string;
	result?: unknown;
	progress?: number;
	clientCode?: string;
	metadata?: Record<string, unknown>;
}

export interface JobQueueOptions {
	maxConcurrency?: number;
	defaultMaxAttempts?: number;
	retryDelay?: number; // ms
	retryBackoff?: "fixed" | "exponential";
	dlqEnabled?: boolean;
	/** Max completed/failed jobs to keep per queue before pruning (default: 500) */
	maxCompletedJobs?: number;
}

export interface QueueMetrics {
	waiting: number;
	active: number;
	completed: number;
	failed: number;
	delayed: number;
	dlq: number;
	throughput: number; // jobs/sec
	avgProcessingTime: number; // ms
}

/**
 * Advanced Job Queue Service
 * Features:
 * - Priority queues (heap-based)
 * - Delayed execution
 * - Retry with exponential backoff
 * - Dead Letter Queue (DLQ)
 * - Job progress tracking
 * - Concurrency control
 * - Event emission
 * - Bounded completed/failed job buffers (prevents memory leak)
 */
export class JobQueueV2 extends EventEmitter {
	private queues = new Map<string, Job[]>();
	private activeJobs = new Map<string, Job[]>();
	private completedJobs = new Map<string, Job[]>();
	private failedJobs = new Map<string, Job[]>();
	private delayedJobs = new Map<string, Job[]>();
	private dlq = new Map<string, Job[]>(); // Dead Letter Queue
	private tenantActiveCounts = new Map<string, number>();
	private maxParallelPerTenant = 50;
	private options: Required<JobQueueOptions>;
	private delayedJobInterval?: NodeJS.Timeout;
	/** Detects workers that stopped heartbeating and re-queues their jobs */
	private reaperInterval?: NodeJS.Timeout;
	/** Seconds of silence before an active job is considered a zombie (default: 60) */
	private readonly heartbeatTimeoutMs: number;

	constructor(options: JobQueueOptions = {}) {
		super();
		this.options = {
			maxConcurrency: options.maxConcurrency ?? 5,
			defaultMaxAttempts: options.defaultMaxAttempts ?? 3,
			retryDelay: options.retryDelay ?? 1000,
			retryBackoff: options.retryBackoff ?? "exponential",
			dlqEnabled: options.dlqEnabled ?? true,
			maxCompletedJobs: options.maxCompletedJobs ?? 500,
		};
		this.heartbeatTimeoutMs = 60_000; // 60 seconds

		this.delayedJobInterval = this.startDelayedJobProcessor();
		this.reaperInterval = this.startReaper();
	}

	/**
	 * Add a job to the queue
	 */
	async add(
		queueName: string,
		data: unknown,
		options: {
			priority?: number;
			maxAttempts?: number;
			delayMs?: number;
			runAt?: Date;
			clientCode?: string;
			metadata?: Record<string, unknown>;
		} = {},
	): Promise<Job> {
		const job: Job = {
			id: this.generateId(),
			queueName,
			data,
			priority: options.priority ?? 5,
			attempts: 0,
			maxAttempts: options.maxAttempts ?? this.options.defaultMaxAttempts,
			status: options.delayMs || options.runAt ? "delayed" : "waiting",
			runAt: options.runAt ?? new Date(Date.now() + (options.delayMs ?? 0)),
			createdAt: new Date(),
			clientCode: options.clientCode,
			metadata: options.metadata,
		};

		if (job.status === "delayed") {
			this.addToDelayed(queueName, job);
		} else {
			this.addToQueue(queueName, job);
		}

		this.emit("job:added", job);
		return job;
	}

	/**
	 * Pop next job from queue (priority-based)
	 */
	public pop(queueName: string): Job | null {
		const queue = this.queues.get(queueName);
		if (!queue || queue.length === 0) return null;

		// Sort by priority (descending) then by createdAt (ascending)
		queue.sort((a, b) => {
			if (a.priority !== b.priority) {
				return b.priority - a.priority;
			}
			return a.createdAt.getTime() - b.createdAt.getTime();
		});

		// Fairness: find first job whose tenant isn't saturated
		const jobIndex = queue.findIndex((job) => {
			const tenantId = job.clientCode || "unknown";
			const activeCount = this.tenantActiveCounts.get(tenantId) || 0;
			return activeCount < this.maxParallelPerTenant;
		});

		if (jobIndex === -1) return null;

		const [job] = queue.splice(jobIndex, 1);
		return job;
	}

	/**
	 * Claim the next job from the queue.
	 * Marks the job as active and returns it.
	 */
	public claim(queueName: string): Job | null {
		const job = this.pop(queueName);
		if (!job) return null;

		job.status = "active";
		job.startedAt = new Date();
		job.attempts++;

		const tenantId = job.clientCode || "unknown";
		this.tenantActiveCounts.set(
			tenantId,
			(this.tenantActiveCounts.get(tenantId) || 0) + 1,
		);

		this.addToActive(queueName, job);
		this.emit("job:active", job);
		return job;
	}

	/**
	 * Mark a job as completed
	 */
	public complete(jobId: string, result?: unknown): boolean {
		const job = this.getJob(jobId);
		if (!job || job.status !== "active") return false;

		job.status = "completed";
		job.completedAt = new Date();
		job.result = result;

		const tenantId = job.clientCode || "unknown";
		this.tenantActiveCounts.set(
			tenantId,
			Math.max(0, (this.tenantActiveCounts.get(tenantId) || 0) - 1),
		);

		this.removeFromActive(job.queueName, job.id);
		this.addToCompleted(job.queueName, job);
		this.emit("job:completed", job);
		return true;
	}

	/**
	 * Mark a job as failed
	 */
	public fail(jobId: string, error: string): boolean {
		const job = this.getJob(jobId);
		if (!job || job.status !== "active") return false;

		job.error = error;
		job.failedAt = new Date();

		this.removeFromActive(job.queueName, job.id);

		// Retry logic
		if (job.attempts < job.maxAttempts) {
			const delay = this.calculateRetryDelay(job.attempts);
			job.status = "delayed";
			job.runAt = new Date(Date.now() + delay);

			this.addToDelayed(job.queueName, job);
			this.emit("job:retry", job);
		} else {
			// Max attempts reached
			job.status = "failed";

			const tenantId = job.clientCode || "unknown";
			this.tenantActiveCounts.set(
				tenantId,
				Math.max(0, (this.tenantActiveCounts.get(tenantId) || 0) - 1),
			);

			this.addToFailed(job.queueName, job);

			// Move to DLQ if enabled
			if (this.options.dlqEnabled) {
				this.addToDLQ(job.queueName, job);
				this.emit("job:dlq", job);
			}

			this.emit("job:failed", job);
		}
		return true;
	}

	/**
	 * Reaper: scans active jobs and fails any whose heartbeat has gone silent.
	 * Only applies to jobs that have received at least one heartbeat (opt-in).
	 */
	private startReaper(): NodeJS.Timeout {
		return setInterval(() => {
			const now = Date.now();
			for (const jobs of this.activeJobs.values()) {
				for (const job of [...jobs]) {
					if (
						job.heartbeatAt &&
						now - job.heartbeatAt.getTime() > this.heartbeatTimeoutMs
					) {
						this.fail(job.id, `Heartbeat timeout after ${this.heartbeatTimeoutMs}ms`);
						this.emit("job:zombie", job);
					}
				}
			}
		}, 15_000); // Check every 15 seconds
	}

	/**
	 * Process delayed jobs — runs on a stored interval so it can be cancelled
	 */
	private startDelayedJobProcessor(): NodeJS.Timeout {
		return setInterval(() => {
			const now = Date.now();

			for (const [queueName, jobs] of this.delayedJobs.entries()) {
				const readyJobs = jobs.filter((job) => job.runAt.getTime() <= now);

				for (const job of readyJobs) {
					job.status = "waiting";
					this.removeFromDelayed(queueName, job.id);
					this.addToQueue(queueName, job);
					this.emit("job:ready", job);
				}
			}
		}, 1000); // Check every second
	}

	/**
	 * Calculate retry delay with backoff
	 */
	private calculateRetryDelay(attempts: number): number {
		if (this.options.retryBackoff === "fixed") {
			return this.options.retryDelay;
		}

		// Exponential backoff: delay * 2^(attempts-1)
		return this.options.retryDelay * 2 ** (attempts - 1);
	}

	/**
	 * Record a worker heartbeat for an active job.
	 * Workers should call this every 15–30 seconds to signal they are alive.
	 * Jobs that go silent for heartbeatTimeoutMs are re-queued by the reaper.
	 */
	heartbeat(jobId: string): boolean {
		for (const jobs of this.activeJobs.values()) {
			const job = jobs.find((j) => j.id === jobId);
			if (job) {
				job.heartbeatAt = new Date();
				return true;
			}
		}
		return false;
	}

	/**
	 * Add multiple jobs in a single call (bulk enqueue).
	 */
	async addBulk(
		queueName: string,
		items: Array<{ data: unknown; options?: Parameters<JobQueueV2["add"]>[2] }>,
	): Promise<Job[]> {
		return Promise.all(items.map((item) => this.add(queueName, item.data, item.options)));
	}

	/**
	 * Update job progress
	 */
	updateProgress(jobId: string, progress: number): void {
		for (const jobs of this.activeJobs.values()) {
			const job = jobs.find((j) => j.id === jobId);
			if (job) {
				job.progress = Math.min(100, Math.max(0, progress));
				this.emit("job:progress", job);
				return;
			}
		}
	}

	/**
	 * Get job by ID — searches across all state maps
	 */
	getJob(jobId: string): Job | null {
		const allMaps = [
			this.queues,
			this.activeJobs,
			this.completedJobs,
			this.failedJobs,
			this.delayedJobs,
			this.dlq,
		];

		for (const map of allMaps) {
			for (const jobs of map.values()) {
				const job = jobs.find((j) => j.id === jobId);
				if (job) return job;
			}
		}

		return null;
	}

	/**
	 * Get queue metrics
	 */
	getMetrics(queueName: string): QueueMetrics {
		const waiting = this.queues.get(queueName)?.length ?? 0;
		const active = this.activeJobs.get(queueName)?.length ?? 0;
		const completed = this.completedJobs.get(queueName)?.length ?? 0;
		const failed = this.failedJobs.get(queueName)?.length ?? 0;
		const delayed = this.delayedJobs.get(queueName)?.length ?? 0;
		const dlq = this.dlq.get(queueName)?.length ?? 0;

		// Calculate throughput and avg processing time
		const completedJobs = this.completedJobs.get(queueName) ?? [];
		const recentJobs = completedJobs.filter(
			(j) => j.completedAt && Date.now() - j.completedAt.getTime() < 60000,
		);

		const throughput = recentJobs.length / 60; // jobs per second

		const avgProcessingTime =
			recentJobs.length > 0
				? recentJobs.reduce((sum, j) => {
						const duration =
							j.completedAt && j.startedAt
								? j.completedAt.getTime() - j.startedAt.getTime()
								: 0;
						return sum + duration;
					}, 0) / recentJobs.length
				: 0;

		return {
			waiting,
			active,
			completed,
			failed,
			delayed,
			dlq,
			throughput,
			avgProcessingTime,
		};
	}

	/**
	 * Retry a failed job
	 */
	retryJob(jobId: string): boolean {
		for (const [queueName, jobs] of this.failedJobs.entries()) {
			const index = jobs.findIndex((j) => j.id === jobId);
			if (index !== -1) {
				const job = jobs[index];
				job.status = "waiting";
				job.attempts = 0;
				job.error = undefined;
				job.failedAt = undefined;

				jobs.splice(index, 1);
				this.addToQueue(queueName, job);
				this.emit("job:retried", job);
				return true;
			}
		}
		return false;
	}

	/**
	 * Retry all jobs in DLQ
	 */
	retryDLQ(queueName: string): number {
		const dlqJobs = this.dlq.get(queueName) ?? [];
		let count = 0;

		for (const job of [...dlqJobs]) {
			job.status = "waiting";
			job.attempts = 0;
			job.error = undefined;
			job.failedAt = undefined;

			this.removeFromDLQ(queueName, job.id);
			this.addToQueue(queueName, job);
			count++;
		}

		this.emit("dlq:retried", { queueName, count });
		return count;
	}

	/**
	 * Clear completed jobs (cleanup)
	 */
	clearCompleted(queueName: string): number {
		const jobs = this.completedJobs.get(queueName) ?? [];
		const count = jobs.length;
		this.completedJobs.set(queueName, []);
		return count;
	}

	/**
	 * Get all jobs in a queue
	 */
	getJobs(queueName: string, status?: Job["status"]): Job[] {
		const allJobs: Job[] = [];

		if (!status || status === "waiting") {
			allJobs.push(...(this.queues.get(queueName) ?? []));
		}
		if (!status || status === "active") {
			allJobs.push(...(this.activeJobs.get(queueName) ?? []));
		}
		if (!status || status === "completed") {
			allJobs.push(...(this.completedJobs.get(queueName) ?? []));
		}
		if (!status || status === "failed") {
			allJobs.push(...(this.failedJobs.get(queueName) ?? []));
		}
		if (!status || status === "delayed") {
			allJobs.push(...(this.delayedJobs.get(queueName) ?? []));
		}

		return allJobs;
	}

	// Helper methods for managing job collections

	private addToQueue(queueName: string, job: Job): void {
		if (!this.queues.has(queueName)) {
			this.queues.set(queueName, []);
		}
		this.queues.get(queueName)?.push(job);
	}

	private addToActive(queueName: string, job: Job): void {
		if (!this.activeJobs.has(queueName)) {
			this.activeJobs.set(queueName, []);
		}
		this.activeJobs.get(queueName)?.push(job);
	}

	private removeFromActive(queueName: string, jobId: string): void {
		const jobs = this.activeJobs.get(queueName);
		if (jobs) {
			const index = jobs.findIndex((j) => j.id === jobId);
			if (index !== -1) jobs.splice(index, 1);
		}
	}

	/**
	 * Add to completed jobs, pruning oldest entries when the buffer is full.
	 * This prevents unbounded memory growth at high throughput.
	 */
	private addToCompleted(queueName: string, job: Job): void {
		if (!this.completedJobs.has(queueName)) {
			this.completedJobs.set(queueName, []);
		}
		const jobs = this.completedJobs.get(queueName)!;
		jobs.push(job);

		// Prune oldest entries when over the cap
		if (jobs.length > this.options.maxCompletedJobs) {
			jobs.splice(0, jobs.length - this.options.maxCompletedJobs);
		}
	}

	private addToFailed(queueName: string, job: Job): void {
		if (!this.failedJobs.has(queueName)) {
			this.failedJobs.set(queueName, []);
		}
		const jobs = this.failedJobs.get(queueName)!;
		jobs.push(job);

		// Prune oldest failed entries when over cap
		if (jobs.length > this.options.maxCompletedJobs) {
			jobs.splice(0, jobs.length - this.options.maxCompletedJobs);
		}
	}

	private addToDelayed(queueName: string, job: Job): void {
		if (!this.delayedJobs.has(queueName)) {
			this.delayedJobs.set(queueName, []);
		}
		this.delayedJobs.get(queueName)?.push(job);
	}

	private removeFromDelayed(queueName: string, jobId: string): void {
		const jobs = this.delayedJobs.get(queueName);
		if (jobs) {
			const index = jobs.findIndex((j) => j.id === jobId);
			if (index !== -1) jobs.splice(index, 1);
		}
	}

	private addToDLQ(queueName: string, job: Job): void {
		if (!this.dlq.has(queueName)) {
			this.dlq.set(queueName, []);
		}
		this.dlq.get(queueName)?.push(job);
	}

	private removeFromDLQ(queueName: string, jobId: string): void {
		const jobs = this.dlq.get(queueName);
		if (jobs) {
			const index = jobs.findIndex((j) => j.id === jobId);
			if (index !== -1) jobs.splice(index, 1);
		}
	}

	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	/**
	 * Export all data for persistence.
	 * Note: completed/failed are already bounded by maxCompletedJobs.
	 */
	export() {
		return {
			queues: Object.fromEntries(this.queues),
			activeJobs: Object.fromEntries(this.activeJobs),
			completedJobs: Object.fromEntries(this.completedJobs),
			failedJobs: Object.fromEntries(this.failedJobs),
			delayedJobs: Object.fromEntries(this.delayedJobs),
			dlq: Object.fromEntries(this.dlq),
		};
	}

	/**
	 * Import data from persistence
	 */
	import(data: Record<string, unknown>): void {
		const d = data as Record<string, Record<string, Job[]>>;
		if (d.queues) this.queues = new Map(Object.entries(d.queues));
		if (d.activeJobs) this.activeJobs = new Map(Object.entries(d.activeJobs));
		if (d.completedJobs) this.completedJobs = new Map(Object.entries(d.completedJobs));
		if (d.failedJobs) this.failedJobs = new Map(Object.entries(d.failedJobs));
		if (d.delayedJobs) this.delayedJobs = new Map(Object.entries(d.delayedJobs));
		if (d.dlq) this.dlq = new Map(Object.entries(d.dlq));
	}

	/**
	 * Cleanup — cancels all intervals and removes listeners
	 */
	destroy(): void {
		if (this.delayedJobInterval) clearInterval(this.delayedJobInterval);
		if (this.reaperInterval) clearInterval(this.reaperInterval);
		this.removeAllListeners();
	}
}
