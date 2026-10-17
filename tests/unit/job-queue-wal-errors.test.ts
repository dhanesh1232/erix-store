import { describe, expect, it, vi } from "vitest";
import type { BatchedJobWAL } from "../../src/services/BatchedJobWAL.js";
import { JobQueueV2 } from "../../src/services/JobQueueV2.js";

// A full WAL buffer (Postgres down) rejects log(); the queue fires it and
// forgets, so that rejection used to crash the process as unhandled.
describe("JobQueueV2 WAL write failures", () => {
	it("keeps queueing and logs instead of leaving an unhandled rejection", async () => {
		const wal = {
			log: vi.fn().mockRejectedValue(new Error("Buffer overflow")),
		} as unknown as BatchedJobWAL;
		const queue = new JobQueueV2({}, wal);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const job = await queue.add("q", { a: 1 });
			await new Promise((r) => setTimeout(r, 10));
			expect(job.id).toBeTruthy();
			expect(wal.log).toHaveBeenCalledWith("enqueued", expect.objectContaining({ id: job.id }));
			expect(unhandled).not.toHaveBeenCalled();
			expect(errors).toHaveBeenCalledWith(expect.stringContaining("WAL write failed"), "Buffer overflow");
		} finally {
			process.off("unhandledRejection", unhandled);
			errors.mockRestore();
			queue.removeAllListeners();
		}
	});
});
