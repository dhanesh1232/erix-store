import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchedJobWAL } from "../../src/services/BatchedJobWAL.js";
import type { Job } from "../../src/services/JobQueueV2.js";

// ─── Mock Pool ───────────────────────────────────────────────────────────────

interface MockPool {
	query: ReturnType<typeof vi.fn>;
}

function createMockPool(): MockPool {
	const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
	return { query: queryFn };
}

function asPgPool(mock: MockPool): Pool {
	return mock as unknown as Pool;
}

function createJob(overrides: Partial<Job> = {}): Job {
	return {
		id: `job-${Math.random().toString(36).slice(2, 8)}`,
		queueName: "test-queue",
		data: { foo: "bar" },
		priority: 5,
		attempts: 0,
		maxAttempts: 3,
		status: "waiting",
		runAt: new Date("2024-01-01T00:00:00Z"),
		createdAt: new Date("2024-01-01T00:00:00Z"),
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BatchedJobWAL", () => {
	let pool: MockPool;
	let wal: BatchedJobWAL;

	beforeEach(() => {
		vi.useFakeTimers();
		pool = createMockPool();
	});

	afterEach(() => {
		wal?.destroy();
		vi.useRealTimers();
	});

	describe("initialize()", () => {
		it("should execute CREATE TABLE SQL", async () => {
			wal = new BatchedJobWAL(asPgPool(pool));
			await wal.initialize();
			expect(pool.query).toHaveBeenCalledTimes(1);
			const sql = pool.query.mock.calls[0][0] as string;
			expect(sql).toContain("CREATE TABLE IF NOT EXISTS erix_job_wal");
			expect(sql).toContain(
				"CREATE INDEX IF NOT EXISTS idx_erix_job_wal_job_id",
			);
		});
	});

	describe("log() buffering", () => {
		it("should buffer entries without flushing immediately", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 100,
				maxBufferAgeMs: 50,
			});
			await wal.log("enqueued", createJob());
			// No INSERT should have been issued yet
			expect(pool.query).not.toHaveBeenCalled();
			expect(wal.bufferSize).toBe(1);
		});

		it("should flush when buffer reaches maxBufferSize", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 5,
				maxBufferAgeMs: 50,
			});
			for (let i = 0; i < 5; i++) {
				await wal.log("enqueued", createJob());
			}
			// Should have flushed
			expect(pool.query).toHaveBeenCalledTimes(1);
			expect(wal.bufferSize).toBe(0);
		});

		it("should flush when maxBufferAgeMs elapses", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 100,
				maxBufferAgeMs: 50,
			});
			await wal.log("enqueued", createJob());
			await wal.log("claimed", createJob());

			expect(pool.query).not.toHaveBeenCalled();

			// Advance time past the flush interval
			await vi.advanceTimersByTimeAsync(50);

			expect(pool.query).toHaveBeenCalledTimes(1);
			expect(wal.bufferSize).toBe(0);
		});
	});

	describe("flush() SQL generation", () => {
		it("should generate a single multi-row INSERT", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 100,
				maxBufferAgeMs: 50,
			});
			const job1 = createJob({ id: "job-1", queueName: "q1" });
			const job2 = createJob({ id: "job-2", queueName: "q2" });

			await wal.log("enqueued", job1);
			await wal.log("claimed", job2);
			await wal.flush();

			expect(pool.query).toHaveBeenCalledTimes(1);
			const [sql, params] = pool.query.mock.calls[0];

			// Single INSERT with two value rows
			expect(sql).toContain("INSERT INTO erix_job_wal");
			expect(sql).toContain("($1, $2, $3, $4), ($5, $6, $7, $8)");

			// Params: 4 per row × 2 rows = 8
			expect(params).toHaveLength(8);
			expect(params[0]).toBe("job-1");
			expect(params[1]).toBe("q1");
			expect(params[2]).toBe("enqueued");
			expect(params[4]).toBe("job-2");
			expect(params[5]).toBe("q2");
			expect(params[6]).toBe("claimed");
		});

		it("should not issue a query when buffer is empty", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 100,
				maxBufferAgeMs: 50,
			});
			await wal.flush();
			expect(pool.query).not.toHaveBeenCalled();
		});
	});

	describe("overflow protection", () => {
		it("should reject log() when buffer is at capacity", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 100,
				maxBufferAgeMs: 50,
				maxBufferCap: 3,
			});

			// Make flush fail so buffer fills up
			pool.query.mockRejectedValue(new Error("connection refused"));

			// Fill buffer to cap (3 entries, but flush triggers at 100 so no auto-flush)
			await wal.log("enqueued", createJob());
			await wal.log("enqueued", createJob());
			await wal.log("enqueued", createJob());

			// Next log should throw
			await expect(wal.log("enqueued", createJob())).rejects.toThrow(
				"Buffer overflow",
			);
		});
	});

	describe("retry logic", () => {
		it("should retry flush up to maxRetries times on failure", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 100,
				maxBufferAgeMs: 50,
				maxRetries: 3,
				retryBackoffMs: 100,
			});

			pool.query
				.mockRejectedValueOnce(new Error("connection lost"))
				.mockRejectedValueOnce(new Error("connection lost"))
				.mockResolvedValueOnce({ rows: [], rowCount: 1 });

			await wal.log("enqueued", createJob());

			// Flush with retries (need to advance timers for sleep)
			const flushPromise = wal.flush();
			// First retry backoff: 100ms
			await vi.advanceTimersByTimeAsync(100);
			// Second retry backoff: 200ms
			await vi.advanceTimersByTimeAsync(200);
			await flushPromise;

			// 3 attempts total
			expect(pool.query).toHaveBeenCalledTimes(3);
			expect(wal.bufferSize).toBe(0);
		});

		it("should return entries to buffer when all retries fail", async () => {
			wal = new BatchedJobWAL(asPgPool(pool), {
				maxBufferSize: 100,
				maxBufferAgeMs: 50,
				maxRetries: 3,
				retryBackoffMs: 100,
			});

			pool.query.mockRejectedValue(new Error("connection refused"));

			await wal.log("enqueued", createJob());
			expect(wal.bufferSize).toBe(1);

			const flushPromise = wal.flush();
			// Advance through all retry backoffs
			await vi.advanceTimersByTimeAsync(100); // attempt 2 backoff
			await vi.advanceTimersByTimeAsync(200); // attempt 3 backoff
			await flushPromise;

			// Entries should be back in the buffer
			expect(wal.bufferSize).toBe(1);
		});
	});

	describe("replay()", () => {
		it("should query for non-terminal jobs and rehydrate dates", async () => {
			const mockJob = {
				id: "job-1",
				queueName: "q1",
				data: {},
				priority: 5,
				attempts: 1,
				maxAttempts: 3,
				status: "waiting",
				runAt: "2024-01-01T00:00:00.000Z",
				createdAt: "2024-01-01T00:00:00.000Z",
			};

			pool.query.mockResolvedValueOnce({
				rows: [{ data: mockJob }],
				rowCount: 1,
			});

			wal = new BatchedJobWAL(asPgPool(pool));
			const jobs = await wal.replay();

			expect(jobs).toHaveLength(1);
			expect(jobs[0].runAt).toBeInstanceOf(Date);
			expect(jobs[0].createdAt).toBeInstanceOf(Date);
		});

		it("should reset active jobs to waiting", async () => {
			const mockJob = {
				id: "job-1",
				queueName: "q1",
				data: {},
				priority: 5,
				attempts: 1,
				maxAttempts: 3,
				status: "active",
				runAt: "2024-01-01T00:00:00.000Z",
				createdAt: "2024-01-01T00:00:00.000Z",
				startedAt: "2024-01-01T00:00:01.000Z",
			};

			pool.query.mockResolvedValueOnce({
				rows: [{ data: mockJob }],
				rowCount: 1,
			});

			wal = new BatchedJobWAL(asPgPool(pool));
			const jobs = await wal.replay();

			expect(jobs[0].status).toBe("waiting");
			expect(jobs[0].startedAt).toBeUndefined();
		});
	});

	describe("prune()", () => {
		it("should delete terminal events older than retention period", async () => {
			pool.query.mockResolvedValueOnce({ rowCount: 5 });

			wal = new BatchedJobWAL(asPgPool(pool));
			const pruned = await wal.prune(60_000);

			expect(pruned).toBe(5);
			expect(pool.query).toHaveBeenCalledTimes(1);
			const [sql, params] = pool.query.mock.calls[0];
			expect(sql).toContain("DELETE FROM erix_job_wal");
			expect(params[0]).toEqual(["completed", "failed"]);
		});
	});
});
