import { EventEmitter } from "events";
import type { JobWAL } from "./JobWAL.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  queueName: string;
  data: unknown;
  /** 1–10, higher = more important. Default: 5. */
  priority: number;
  attempts: number;
  maxAttempts: number;
  status: "waiting" | "active" | "completed" | "failed" | "delayed";
  /** When the job is eligible to run (past = immediately). */
  runAt: Date;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  /** Updated by worker heartbeat — used by reaper to detect zombie jobs. */
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
  /** Base delay in ms for retry backoff. Default: 1000. */
  retryDelay?: number;
  retryBackoff?: "fixed" | "exponential";
  dlqEnabled?: boolean;
  /** Max completed/failed jobs to keep per queue in memory (default: 500). */
  maxCompletedJobs?: number;
}

export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  dlq: number;
  throughput: number;
  avgProcessingTime: number;
}

// ─── JobQueueV2 ───────────────────────────────────────────────────────────────

/**
 * Advanced in-memory job queue with:
 * - Priority scheduling (higher priority wins; FIFO on tie)
 * - Per-tenant fairness (max parallel slots per clientCode)
 * - Delayed execution with a 1s tick
 * - Retry with exponential or fixed backoff
 * - Dead Letter Queue (DLQ)
 * - Zombie detection via heartbeat reaper
 * - WAL integration for crash-safe durability (optional, injected)
 * - SSE event emission for push-based worker notification
 */
export class JobQueueV2 extends EventEmitter {
  // ── In-memory state ───────────────────────────────────────────────────────
  private queues = new Map<string, Job[]>();
  private activeJobs = new Map<string, Job[]>();
  private completedJobs = new Map<string, Job[]>();
  private failedJobs = new Map<string, Job[]>();
  private delayedJobs = new Map<string, Job[]>();
  private dlq = new Map<string, Job[]>();

  // ── Tenant fairness ───────────────────────────────────────────────────────
  private tenantActiveCounts = new Map<string, number>();
  private readonly maxParallelPerTenant = 50;

  // ── Config & timers ───────────────────────────────────────────────────────
  private options: Required<JobQueueOptions>;
  private delayedJobInterval?: NodeJS.Timeout;
  private reaperInterval?: NodeJS.Timeout;
  private readonly heartbeatTimeoutMs = 60_000;

  // ── Optional WAL ─────────────────────────────────────────────────────────
  private wal?: JobWAL;

  constructor(options: JobQueueOptions = {}, wal?: JobWAL) {
    super();
    this.options = {
      maxConcurrency: options.maxConcurrency ?? 5,
      defaultMaxAttempts: options.defaultMaxAttempts ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      retryBackoff: options.retryBackoff ?? "exponential",
      dlqEnabled: options.dlqEnabled ?? true,
      maxCompletedJobs: options.maxCompletedJobs ?? 500,
    };
    this.wal = wal;

    this.delayedJobInterval = this.startDelayedJobProcessor();
    this.reaperInterval = this.startReaper();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Add a job to the queue. Returns the created job. */
  async add<T = Record<string, unknown>>(
    queueName: string,
    data: T,
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

    // WAL: log before emitting so the event carries a persisted job
    if (this.wal) void this.wal.log("enqueued", job);

    this.emit("job:added", job);
    return job;
  }

  /**
   * Pop the next eligible job from the queue (priority-ordered, tenant-fair).
   * Does NOT mark the job active — use `claim()` for that.
   */
  public pop(queueName: string): Job | null {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) return null;

    // Sort: descending priority, ascending createdAt on tie
    queue.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    // Fairness: skip tenants that are at their parallel cap
    const jobIndex = queue.findIndex((job) => {
      const tenantId = job.clientCode ?? "unknown";
      return (
        (this.tenantActiveCounts.get(tenantId) ?? 0) < this.maxParallelPerTenant
      );
    });
    if (jobIndex === -1) return null;

    const [job] = queue.splice(jobIndex, 1);
    return job;
  }

  /** Claim the next job — marks it active and returns it for the caller to execute. */
  public claim(queueName: string): Job | null {
    const job = this.pop(queueName);
    if (!job) return null;

    job.status = "active";
    job.startedAt = new Date();
    job.attempts++;

    const tenantId = job.clientCode ?? "unknown";
    this.tenantActiveCounts.set(
      tenantId,
      (this.tenantActiveCounts.get(tenantId) ?? 0) + 1,
    );

    this.addToActive(queueName, job);
    if (this.wal) void this.wal.log("claimed", job);
    this.emit("job:active", job);
    return job;
  }

  /** Mark an active job as completed. */
  public complete(jobId: string, result?: unknown): boolean {
    const job = this.getActiveJob(jobId);
    if (!job) return false;

    job.status = "completed";
    job.completedAt = new Date();
    job.result = result;

    this.decrementTenant(job);
    this.removeFromActive(job.queueName, job.id);
    this.addToCompleted(job.queueName, job);

    if (this.wal) void this.wal.log("completed", job);
    this.emit("job:completed", job);
    return true;
  }

  /** Mark an active job as failed. Retries with backoff if attempts remain; moves to DLQ otherwise. */
  public fail(jobId: string, error: string): boolean {
    const job = this.getActiveJob(jobId);
    if (!job) return false;

    job.error = error;
    job.failedAt = new Date();

    this.removeFromActive(job.queueName, job.id);

    if (job.attempts < job.maxAttempts) {
      // Retry with backoff
      const delay = this.calculateRetryDelay(job.attempts);
      job.status = "delayed";
      job.runAt = new Date(Date.now() + delay);
      this.addToDelayed(job.queueName, job);
      if (this.wal) void this.wal.log("retry", job);
      this.emit("job:retry", job);
    } else {
      // Exhausted — terminal failure
      job.status = "failed";
      this.decrementTenant(job);
      this.addToFailed(job.queueName, job);
      if (this.options.dlqEnabled) {
        this.addToDLQ(job.queueName, job);
        this.emit("job:dlq", job);
      }
      if (this.wal) void this.wal.log("failed", job);
      this.emit("job:failed", job);
    }
    return true;
  }

  /**
   * Rebuild the in-memory queue from a WAL replay result.
   * Called once during bootstrap, before the HTTP server starts.
   * Jobs replayed from WAL are inserted directly without re-logging to WAL.
   */
  public rebuildFromWAL(jobs: Job[]): void {
    for (const job of jobs) {
      switch (job.status) {
        case "waiting":
          this.addToQueue(job.queueName, job);
          break;
        case "delayed":
          this.addToDelayed(job.queueName, job);
          break;
        // active jobs were reset to waiting by JobWAL.replay()
        // completed/failed are excluded by JobWAL.replay()
        default:
          break;
      }
    }
    console.log(`[JobQueueV2] Rebuilt ${jobs.length} jobs from WAL ✓`);
  }

  /** Record a worker heartbeat. Prevents the reaper from killing a long-running job. */
  public heartbeat(jobId: string): boolean {
    for (const jobs of this.activeJobs.values()) {
      const job = jobs.find((j) => j.id === jobId);
      if (job) {
        job.heartbeatAt = new Date();
        return true;
      }
    }
    return false;
  }

  /** Update the progress (0–100) of an active job. Emits `job:progress`. */
  public updateProgress(jobId: string, progress: number): void {
    for (const jobs of this.activeJobs.values()) {
      const job = jobs.find((j) => j.id === jobId);
      if (job) {
        job.progress = Math.min(100, Math.max(0, progress));
        this.emit("job:progress", job);
        return;
      }
    }
  }

  /** Retry a single failed job. Resets attempts and re-queues it. */
  public retryJob(jobId: string): boolean {
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
        if (this.wal) void this.wal.log("retry", job);
        this.emit("job:retried", job);
        return true;
      }
    }
    return false;
  }

  /** Retry all jobs currently in the DLQ for a given queue. */
  public retryDLQ(queueName: string): number {
    const dlqJobs = this.dlq.get(queueName) ?? [];
    let count = 0;
    for (const job of [...dlqJobs]) {
      job.status = "waiting";
      job.attempts = 0;
      job.error = undefined;
      job.failedAt = undefined;
      this.removeFromDLQ(queueName, job.id);
      this.addToQueue(queueName, job);
      if (this.wal) void this.wal.log("retry", job);
      count++;
    }
    this.emit("dlq:retried", { queueName, count });
    return count;
  }

  /** Clear all completed jobs for a queue. Returns number cleared. */
  public clearCompleted(queueName: string): number {
    const jobs = this.completedJobs.get(queueName) ?? [];
    const count = jobs.length;
    this.completedJobs.set(queueName, []);
    return count;
  }

  /** Get a job by ID — searches all state maps. */
  public getJob(jobId: string): Job | null {
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

  /** Get all jobs in a queue, optionally filtered by status. */
  public getJobs(queueName: string, status?: Job["status"]): Job[] {
    const all: Job[] = [];
    if (!status || status === "waiting")
      all.push(...(this.queues.get(queueName) ?? []));
    if (!status || status === "active")
      all.push(...(this.activeJobs.get(queueName) ?? []));
    if (!status || status === "completed")
      all.push(...(this.completedJobs.get(queueName) ?? []));
    if (!status || status === "failed")
      all.push(...(this.failedJobs.get(queueName) ?? []));
    if (!status || status === "delayed")
      all.push(...(this.delayedJobs.get(queueName) ?? []));
    return all;
  }

  /** Get real-time metrics for a queue. */
  public getMetrics(queueName: string): QueueMetrics {
    const waiting = this.queues.get(queueName)?.length ?? 0;
    const active = this.activeJobs.get(queueName)?.length ?? 0;
    const completed = this.completedJobs.get(queueName)?.length ?? 0;
    const failed = this.failedJobs.get(queueName)?.length ?? 0;
    const delayed = this.delayedJobs.get(queueName)?.length ?? 0;
    const dlq = this.dlq.get(queueName)?.length ?? 0;

    const completedJobs = this.completedJobs.get(queueName) ?? [];
    const recentJobs = completedJobs.filter(
      (j) => j.completedAt && Date.now() - j.completedAt.getTime() < 60_000,
    );
    const throughput = recentJobs.length / 60;
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

  /** Add multiple jobs atomically. */
  async addBulk(
    queueName: string,
    items: Array<{ data: unknown; options?: Parameters<JobQueueV2["add"]>[2] }>,
  ): Promise<Job[]> {
    return Promise.all(
      items.map((item) => this.add(queueName, item.data, item.options)),
    );
  }

  /** Cancel all intervals and remove all listeners. Call on graceful shutdown. */
  public destroy(): void {
    if (this.delayedJobInterval) clearInterval(this.delayedJobInterval);
    if (this.reaperInterval) clearInterval(this.reaperInterval);
    this.removeAllListeners();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /** Find a job that is currently active, by ID. */
  private getActiveJob(jobId: string): Job | null {
    for (const jobs of this.activeJobs.values()) {
      const job = jobs.find((j) => j.id === jobId);
      if (job) return job;
    }
    return null;
  }

  private decrementTenant(job: Job): void {
    const tenantId = job.clientCode ?? "unknown";
    this.tenantActiveCounts.set(
      tenantId,
      Math.max(0, (this.tenantActiveCounts.get(tenantId) ?? 0) - 1),
    );
  }

  /** Promote delayed jobs whose runAt has passed. Runs every 1 second. */
  private startDelayedJobProcessor(): NodeJS.Timeout {
    return setInterval(() => {
      const now = Date.now();
      for (const [queueName, jobs] of this.delayedJobs.entries()) {
        const ready = jobs.filter((j) => j.runAt.getTime() <= now);
        for (const job of ready) {
          job.status = "waiting";
          this.removeFromDelayed(queueName, job.id);
          this.addToQueue(queueName, job);
          this.emit("job:ready", job);
        }
      }
    }, 1000);
  }

  /**
   * Reaper: scans active jobs every 15 seconds and fails any whose heartbeat
   * has gone silent for longer than `heartbeatTimeoutMs`.
   * Only applies to jobs that have received at least one heartbeat (opt-in pattern).
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
            this.fail(
              job.id,
              `Heartbeat timeout after ${this.heartbeatTimeoutMs}ms`,
            );
            this.emit("job:zombie", job);
          }
        }
      }
    }, 15_000);
  }

  private calculateRetryDelay(attempts: number): number {
    if (this.options.retryBackoff === "fixed") return this.options.retryDelay;
    return this.options.retryDelay * 2 ** (attempts - 1);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  // ─── Collection helpers ───────────────────────────────────────────────────

  private addToQueue(queueName: string, job: Job): void {
    if (!this.queues.has(queueName)) this.queues.set(queueName, []);
    this.queues.get(queueName)!.push(job);
  }

  private addToActive(queueName: string, job: Job): void {
    if (!this.activeJobs.has(queueName)) this.activeJobs.set(queueName, []);
    this.activeJobs.get(queueName)!.push(job);
  }

  private removeFromActive(queueName: string, jobId: string): void {
    const jobs = this.activeJobs.get(queueName);
    if (jobs) {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobs.splice(idx, 1);
    }
  }

  /** Bounded completed buffer — prunes oldest when over cap. */
  private addToCompleted(queueName: string, job: Job): void {
    if (!this.completedJobs.has(queueName))
      this.completedJobs.set(queueName, []);
    const jobs = this.completedJobs.get(queueName)!;
    jobs.push(job);
    if (jobs.length > this.options.maxCompletedJobs) {
      jobs.splice(0, jobs.length - this.options.maxCompletedJobs);
    }
  }

  /** Bounded failed buffer — prunes oldest when over cap. */
  private addToFailed(queueName: string, job: Job): void {
    if (!this.failedJobs.has(queueName)) this.failedJobs.set(queueName, []);
    const jobs = this.failedJobs.get(queueName)!;
    jobs.push(job);
    if (jobs.length > this.options.maxCompletedJobs) {
      jobs.splice(0, jobs.length - this.options.maxCompletedJobs);
    }
  }

  private addToDelayed(queueName: string, job: Job): void {
    if (!this.delayedJobs.has(queueName)) this.delayedJobs.set(queueName, []);
    this.delayedJobs.get(queueName)!.push(job);
  }

  private removeFromDelayed(queueName: string, jobId: string): void {
    const jobs = this.delayedJobs.get(queueName);
    if (jobs) {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobs.splice(idx, 1);
    }
  }

  private addToDLQ(queueName: string, job: Job): void {
    if (!this.dlq.has(queueName)) this.dlq.set(queueName, []);
    this.dlq.get(queueName)!.push(job);
  }

  private removeFromDLQ(queueName: string, jobId: string): void {
    const jobs = this.dlq.get(queueName);
    if (jobs) {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobs.splice(idx, 1);
    }
  }
}
