import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Job, JobQueueV2 } from "../../services/JobQueueV2.js";

export function createQueueV2Routes(queue: JobQueueV2): Router {
	const router = createRouter();

	/**
	 * Add a job to the queue
	 * POST /queue/v2/:queueName/jobs
	 */
	router.post("/:queueName/jobs", async (req, res) => {
		try {
			const { queueName } = req.params;
			const {
				data,
				priority,
				maxAttempts,
				delayMs,
				runAt,
				clientCode,
				metadata,
			} = req.body;

			const job = await queue.add(queueName, data, {
				priority,
				maxAttempts,
				delayMs,
				runAt: runAt ? new Date(runAt) : undefined,
				clientCode,
				metadata,
			});

			res.json({ success: true, job });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get job by ID
	 * GET /queue/v2/jobs/:jobId
	 */
	router.get("/jobs/:jobId", (req, res) => {
		try {
			const { jobId } = req.params;
			const job = queue.getJob(jobId);

			if (!job) {
				return res.status(404).json({ success: false, error: "Job not found" });
			}

			res.json({ success: true, job });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get queue metrics
	 * GET /queue/v2/:queueName/metrics
	 */
	router.get("/:queueName/metrics", (req, res) => {
		try {
			const { queueName } = req.params;
			const metrics = queue.getMetrics(queueName);
			res.json({ success: true, metrics });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get jobs in a queue
	 * GET /queue/v2/:queueName/jobs?status=waiting
	 */
	router.get("/:queueName/jobs", (req, res) => {
		try {
			const { queueName } = req.params;
			const { status } = req.query;
			const jobs = queue.getJobs(queueName, status as Job["status"]);
			res.json({ success: true, jobs, count: jobs.length });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Update job progress
	 * PATCH /queue/v2/jobs/:jobId/progress
	 */
	router.patch("/jobs/:jobId/progress", (req, res) => {
		try {
			const { jobId } = req.params;
			const { progress } = req.body;

			queue.updateProgress(jobId, progress);
			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Claim the next job from the queue
	 * POST /queue/v2/:queueName/claim
	 */
	router.post("/:queueName/claim", (req, res) => {
		try {
			const { queueName } = req.params;
			const job = queue.claim(queueName);

			if (!job) {
				return res.json({ success: true, job: null });
			}

			res.json({ success: true, job });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Mark a job as completed
	 * POST /queue/v2/jobs/:jobId/complete
	 */
	router.post("/jobs/:jobId/complete", (req, res) => {
		try {
			const { jobId } = req.params;
			const { result } = req.body;
			const success = queue.complete(jobId, result);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Job not found or not active" });
			}

			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Mark a job as failed
	 * POST /queue/v2/jobs/:jobId/fail
	 */
	router.post("/jobs/:jobId/fail", (req, res) => {
		try {
			const { jobId } = req.params;
			const { error } = req.body;
			const success = queue.fail(jobId, error);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Job not found or not active" });
			}

			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Retry a failed job
	 * POST /queue/v2/jobs/:jobId/retry
	 */
	router.post("/jobs/:jobId/retry", (req, res) => {
		try {
			const { jobId } = req.params;
			const success = queue.retryJob(jobId);

			if (!success) {
				return res
					.status(404)
					.json({ success: false, error: "Job not found or not failed" });
			}

			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Retry all DLQ jobs
	 * POST /queue/v2/:queueName/dlq/retry
	 */
	router.post("/:queueName/dlq/retry", (req, res) => {
		try {
			const { queueName } = req.params;
			const count = queue.retryDLQ(queueName);
			res.json({ success: true, count });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Clear completed jobs
	 * DELETE /queue/v2/:queueName/completed
	 */
	router.delete("/:queueName/completed", (req, res) => {
		try {
			const { queueName } = req.params;
			const count = queue.clearCompleted(queueName);
			res.json({ success: true, count });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	return router;
}
