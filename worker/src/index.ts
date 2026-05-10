/**
 * @ecodrix/erix-worker
 *
 * BullMQ-style worker for erix-store. Polls for jobs, executes handlers,
 * and manages lifecycle (heartbeat, retry, graceful shutdown).
 *
 * @example
 * ```ts
 * import { ErixClient } from '@ecodrix/erix-client'
 * import { ErixWorker } from '@ecodrix/erix-worker'
 *
 * const client = new ErixClient({
 *   baseUrl: 'https://erix-store.onrender.com',
 *   apiKey: process.env.ERIX_API_KEY!,
 *   tenantId: 'org_abc123',
 * })
 *
 * const worker = new ErixWorker(client, 'scrape-queue', async (job) => {
 *   console.log('Processing:', job.data)
 *   await doWork(job.data)
 * })
 *
 * worker.run() // Starts polling automatically
 * ```
 */

import type { ErixClient, JobV2, JsonValue } from "@ecodrix/erix-client";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ErixWorkerOptions {
  /** Polling interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Maximum concurrent jobs (default: 10) */
  maxConcurrentJobs?: number;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Auto-start worker on instantiation (default: false) */
  autoStart?: boolean;
  /** Custom logger (default: console) */
  logger?: WorkerLogger;
}

export interface WorkerLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export type ErixJobHandler<T = JsonValue> = (job: JobV2<T>) => Promise<void>;

export interface WorkerStats {
  totalJobsProcessed: number;
  successfulJobs: number;
  failedJobs: number;
  currentConcurrency: number;
  isRunning: boolean;
  activeJobs: number;
}

// ─── Worker ─────────────────────────────────────────────────────────────────

export class ErixWorker<T = JsonValue> {
  private client: ErixClient;
  private queueName: string;
  private handler: ErixJobHandler<T>;
  private options: Required<Omit<ErixWorkerOptions, "logger">> & {
    logger: WorkerLogger;
  };
  private isRunning = false;
  private activeJobs = new Map<string, NodeJS.Timeout>();
  private pollTimer?: NodeJS.Timeout;
  private stats: Omit<WorkerStats, "isRunning" | "activeJobs"> = {
    totalJobsProcessed: 0,
    successfulJobs: 0,
    failedJobs: 0,
    currentConcurrency: 0,
  };

  constructor(
    client: ErixClient,
    queueName: string,
    handler: ErixJobHandler<T>,
    options: ErixWorkerOptions = {},
  ) {
    this.client = client;
    this.queueName = queueName;
    this.handler = handler;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 5000,
      maxConcurrentJobs: options.maxConcurrentJobs ?? 10,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30000,
      autoStart: options.autoStart ?? false,
      logger: options.logger ?? console,
    };

    // Setup graceful shutdown
    process.on("SIGTERM", () => this.stop());
    process.on("SIGINT", () => this.stop());

    // Auto-start if enabled
    if (this.options.autoStart) {
      this.run();
    }
  }

  /**
   * Start the worker (BullMQ-style)
   */
  run(): void {
    if (this.isRunning) {
      this.options.logger.warn("Worker is already running", {
        queue: this.queueName,
      });
      return;
    }

    this.isRunning = true;
    this.options.logger.info("🚀 ERIX Worker started", {
      queue: this.queueName,
      pollInterval: this.options.pollIntervalMs,
      maxConcurrency: this.options.maxConcurrentJobs,
    });

    this.scheduleNextPoll();
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.options.logger.info("Stopping ERIX Worker...", {
      queue: this.queueName,
    });
    this.isRunning = false;

    // Stop polling
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    // Wait for active jobs (max 30 seconds)
    const maxWait = 30000;
    const startTime = Date.now();

    while (this.activeJobs.size > 0 && Date.now() - startTime < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Force cleanup
    for (const [jobId, heartbeatTimer] of this.activeJobs) {
      clearInterval(heartbeatTimer);
      this.activeJobs.delete(jobId);
    }

    this.options.logger.info("✅ ERIX Worker stopped", {
      queue: this.queueName,
      stats: this.stats,
    });
  }

  /**
   * Schedule next poll
   */
  private scheduleNextPoll(): void {
    if (!this.isRunning) {
      return;
    }

    this.pollTimer = setTimeout(
      () => this.pollForJobs(),
      this.options.pollIntervalMs,
    );
  }

  /**
   * Poll for jobs
   */
  private async pollForJobs(): Promise<void> {
    try {
      // Check concurrency limit
      if (this.activeJobs.size >= this.options.maxConcurrentJobs) {
        this.scheduleNextPoll();
        return;
      }

      // Claim a job
      const job = await this.client.queueV2.claim<T>(this.queueName);

      if (!job) {
        this.scheduleNextPoll();
        return;
      }

      // Process the job
      this.processJob(job);

      // Schedule next poll immediately
      this.scheduleNextPoll();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error("Error polling for jobs", {
        queue: this.queueName,
        error: message,
      });
      this.scheduleNextPoll();
    }
  }

  /**
   * Process a job
   */
  private async processJob(job: JobV2<T>): Promise<void> {
    const jobId = job.id;

    // Start heartbeat
    const heartbeatTimer = setInterval(async () => {
      try {
        await this.client.queueV2.heartbeat(jobId);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.warn("Heartbeat failed", { jobId, error: message });
      }
    }, this.options.heartbeatIntervalMs);

    this.activeJobs.set(jobId, heartbeatTimer);
    this.stats.currentConcurrency = this.activeJobs.size;

    try {
      this.options.logger.info("Processing job", { jobId, data: job.data });

      // Execute the handler
      await this.handler(job);

      // Complete the job
      await this.client.queueV2.complete(jobId, { completedAt: Date.now() });

      this.options.logger.info("✅ Job completed", { jobId });
      this.stats.successfulJobs++;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error("❌ Job failed", { jobId, error: message });

      // Fail the job
      await this.client.queueV2.fail(jobId, message);
      this.stats.failedJobs++;
    } finally {
      // Cleanup
      clearInterval(heartbeatTimer);
      this.activeJobs.delete(jobId);
      this.stats.currentConcurrency = this.activeJobs.size;
      this.stats.totalJobsProcessed++;
    }
  }

  /**
   * Get worker statistics
   */
  getStats(): WorkerStats {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      activeJobs: this.activeJobs.size,
    };
  }
}

/**
 * Create a new ERIX worker (BullMQ-style factory function)
 */
export function createErixWorker<T = JsonValue>(
  client: ErixClient,
  queueName: string,
  handler: ErixJobHandler<T>,
  options: ErixWorkerOptions = {},
): ErixWorker<T> {
  return new ErixWorker(client, queueName, handler, options);
}
