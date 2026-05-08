import { EventEmitter } from "events";

export interface Job {
	id: string;
	queueName: string;
	data: any;
	priority: number; // 1-10, higher = more important
	attempts: number;
	maxAttempts: number;
	status: "waiting" | "active" | "completed" | "failed" | "delayed";
	runAt: Date;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	failedAt?: Date;
	error?: string;
	result?: any;
	progress?: number;
	clientCode?: string;
	metadata?: Record<string, any>;
}

export interface JobQueueOptions {
	maxConcurrency?: number;
	defaultMaxAttempts?: number;
	retryDelay?: number; // ms
	retryBackoff?: "fixed" | "exponential";
	dlqEnabled?: boolean;
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
 */
export class JobQueueV2 extends EventEmitter {
	private queues = new Map<string, Job[]>();
	private activeJobs = new Map<string, Job[]>();
	private completedJobs = new Map<string, Job[]>();
	private failedJobs = new Map<string, Job[]>();
	private delayedJobs = new Map<string, Job[]>();
	private dlq = new Map<string, Job[]>(); // Dead Letter Queue
	private options: Required<JobQueueOptions>;
	private processingInterval?: NodeJS.Timeout;

	constructor(options: JobQueueOptions = {}) {
		super();
		this.options = {
			maxConcurrency: options.maxConcurrency ?? 5,
			defaultMaxAttempts: options.defaultMaxAttempts ?? 3,
			retryDelay: options.retryDelay ?? 1000,
			retryBackoff: options.retryBackoff ?? "exponential",
			dlqEnabled: options.dlqEnabled ?? true,
		};
	}

	/**
	 * Add a job to the queue
	 */
	async add(
		queueName: string,
		data: any,
		options: {
			priority?: number;
			maxAttempts?: number;
			delayMs?: number;
			runAt?: Date;
			clientCode?: string;
			metadata?: Record<string, any>;
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
	 * Process jobs from a queue
	 */
	async process(
		queueName: string,
		handler: (job: Job) => Promise<any>,
	): Promise<void> {
		// Start delayed job processor
		if (!this.processingInterval) {
			this.startDelayedJobProcessor();
		}

		while (true) {
			// Check concurrency limit
			const activeCount = this.getActiveJobs(queueName).length;
			if (activeCount >= this.options.maxConcurrency) {
				await this.sleep(100);
				continue;
			}

			// Get next job
			const job = this.pop(queueName);
			if (!job) {
				await this.sleep(100);
				continue;
			}

			// Process job
			this.processJob(job, handler);
		}
	}

	/**
	 * Process a single job
	 */
	private async processJob(
		job: Job,
		handler: (job: Job) => Promise<any>,
	): Promise<void> {
		job.status = "active";
		job.startedAt = new Date();
		job.attempts++;

		this.addToActive(job.queueName, job);
		this.emit("job:active", job);

		try {
			const result = await handler(job);

			job.status = "completed";
			job.completedAt = new Date();
			job.result = result;

			this.removeFromActive(job.queueName, job.id);
			this.addToCompleted(job.queueName, job);

			this.emit("job:completed", job);
		} catch (error: any) {
			job.error = error.message;
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
				this.addToFailed(job.queueName, job);

				// Move to DLQ if enabled
				if (this.options.dlqEnabled) {
					this.addToDLQ(job.queueName, job);
					this.emit("job:dlq", job);
				}

				this.emit("job:failed", job);
			}
		}
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

		return queue.shift() ?? null;
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

		this.addToActive(queueName, job);
		this.emit("job:active", job);
		return job;
	}

	/**
	 * Mark a job as completed
	 */
	public complete(jobId: string, result?: any): boolean {
		const job = this.getJob(jobId);
		if (!job || job.status !== "active") return false;

		job.status = "completed";
		job.completedAt = new Date();
		job.result = result;

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
	 * Process delayed jobs
	 */
	private startDelayedJobProcessor(): void {
		this.processingInterval = setInterval(() => {
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
	 * Get job by ID
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

	/**
	 * Get active jobs
	 */
	private getActiveJobs(queueName: string): Job[] {
		return this.activeJobs.get(queueName) ?? [];
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

	private addToCompleted(queueName: string, job: Job): void {
		if (!this.completedJobs.has(queueName)) {
			this.completedJobs.set(queueName, []);
		}
		this.completedJobs.get(queueName)?.push(job);
	}

	private addToFailed(queueName: string, job: Job): void {
		if (!this.failedJobs.has(queueName)) {
			this.failedJobs.set(queueName, []);
		}
		this.failedJobs.get(queueName)?.push(job);
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

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Export all data for persistence
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
	import(data: any): void {
		if (data.queues) this.queues = new Map(Object.entries(data.queues));
		if (data.activeJobs)
			this.activeJobs = new Map(Object.entries(data.activeJobs));
		if (data.completedJobs)
			this.completedJobs = new Map(Object.entries(data.completedJobs));
		if (data.failedJobs)
			this.failedJobs = new Map(Object.entries(data.failedJobs));
		if (data.delayedJobs)
			this.delayedJobs = new Map(Object.entries(data.delayedJobs));
		if (data.dlq) this.dlq = new Map(Object.entries(data.dlq));
	}

	/**
	 * Cleanup
	 */
	destroy(): void {
		if (this.processingInterval) {
			clearInterval(this.processingInterval);
		}
		this.removeAllListeners();
	}
}
