/**
 * @file slowlog.test.ts
 *
 * Unit tests for the SlowLog ring buffer.
 *
 * Pinning down:
 *   1. Threshold sampling — sub-threshold commands are not stored.
 *   2. Ring eviction — when the buffer is full, the oldest entry drops.
 *   3. Tenant scoping — `entries(count, tenantId)` and `lengthFor` filter
 *      to a single tenant. `reset(tenantId)` keeps other tenants intact.
 *   4. Argument truncation — long args are clipped, large arg lists are
 *      summarised. The wire format stays a string array.
 *   5. Capacity reconfiguration — `setMaxLen` preserves the most recent
 *      entries if shrinking and never reorders.
 */

import { describe, expect, it } from "vitest";
import { SlowLog } from "../../src/services/SlowLog.js";

describe("SlowLog", () => {
	describe("threshold sampling", () => {
		it("ignores entries below the threshold", () => {
			const log = new SlowLog({ thresholdUs: 1000 });
			log.record({ durationUs: 500, command: "GET", args: [], tenantId: "t" });
			expect(log.length).toBe(0);
		});

		it("records entries at or above the threshold", () => {
			const log = new SlowLog({ thresholdUs: 1000 });
			log.record({ durationUs: 1000, command: "GET", args: [], tenantId: "t" });
			log.record({
				durationUs: 5000,
				command: "SET",
				args: ["k", "v"],
				tenantId: "t",
			});
			expect(log.length).toBe(2);
		});

		it("threshold of 0 disables logging entirely", () => {
			const log = new SlowLog({ thresholdUs: 0 });
			log.record({
				durationUs: 1_000_000,
				command: "GET",
				args: [],
				tenantId: "t",
			});
			expect(log.length).toBe(0);
		});
	});

	describe("ring buffer", () => {
		it("evicts the oldest entry when over capacity (newest-first ordering)", () => {
			const log = new SlowLog({ thresholdUs: 1, maxLen: 3 });
			for (let i = 0; i < 5; i++) {
				log.record({
					durationUs: 100,
					command: "PING",
					args: [`#${i}`],
					tenantId: "t",
				});
			}
			const all = log.entries();
			expect(all.length).toBe(3);
			// Newest-first: most recent insert (#4) at index 0.
			expect(all[0].args).toEqual(["#4"]);
			expect(all[1].args).toEqual(["#3"]);
			expect(all[2].args).toEqual(["#2"]);
		});

		it("monotonically increasing IDs (never reused)", () => {
			const log = new SlowLog({ thresholdUs: 1, maxLen: 2 });
			for (let i = 0; i < 5; i++) {
				log.record({
					durationUs: 100,
					command: "PING",
					args: [],
					tenantId: "t",
				});
			}
			const ids = log.entries().map((e) => e.id);
			expect(ids[0]).toBeGreaterThan(ids[1]);
		});
	});

	describe("tenant scoping", () => {
		it("entries(count, tenantId) returns only that tenant's records", () => {
			const log = new SlowLog({ thresholdUs: 1 });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "a" });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "b" });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "a" });

			expect(log.entries(10, "a").length).toBe(2);
			expect(log.entries(10, "b").length).toBe(1);
		});

		it("lengthFor counts only that tenant's entries", () => {
			const log = new SlowLog({ thresholdUs: 1 });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "a" });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "b" });
			expect(log.lengthFor("a")).toBe(1);
			expect(log.lengthFor("b")).toBe(1);
			expect(log.lengthFor("ghost")).toBe(0);
		});

		it("reset(tenantId) drops only that tenant's entries", () => {
			const log = new SlowLog({ thresholdUs: 1 });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "a" });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "b" });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "a" });

			const dropped = log.reset("a");
			expect(dropped).toBe(2);
			expect(log.lengthFor("a")).toBe(0);
			expect(log.lengthFor("b")).toBe(1);
		});

		it("reset() with no tenantId drops everything", () => {
			const log = new SlowLog({ thresholdUs: 1 });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "a" });
			log.record({ durationUs: 100, command: "GET", args: [], tenantId: "b" });

			expect(log.reset()).toBe(2);
			expect(log.length).toBe(0);
		});
	});

	describe("argument truncation", () => {
		it("clips long string args at maxArgLen", () => {
			const log = new SlowLog({ thresholdUs: 1, maxArgLen: 10 });
			const huge = "x".repeat(100);
			log.record({
				durationUs: 100,
				command: "SET",
				args: ["k", huge],
				tenantId: "t",
			});
			const [entry] = log.entries();
			expect(entry.args[1].length).toBeLessThanOrEqual(10);
			expect(entry.args[1]).toMatch(/\.\.\.$/);
		});

		it("summarises arg lists past maxArgs", () => {
			const log = new SlowLog({ thresholdUs: 1, maxArgs: 3 });
			log.record({
				durationUs: 100,
				command: "MSET",
				args: ["a", "1", "b", "2", "c", "3", "d", "4"],
				tenantId: "t",
			});
			const [entry] = log.entries();
			expect(entry.args.length).toBe(4); // 3 captured + 1 summary line
			expect(entry.args[3]).toMatch(/\+5 more/);
		});

		it("JSON-stringifies non-string args", () => {
			const log = new SlowLog({ thresholdUs: 1 });
			log.record({
				durationUs: 100,
				command: "X",
				args: [42, { nested: true }],
				tenantId: "t",
			});
			const [entry] = log.entries();
			expect(entry.args[0]).toBe("42");
			expect(entry.args[1]).toBe('{"nested":true}');
		});
	});

	describe("setMaxLen", () => {
		it("shrinking keeps the most recent entries", () => {
			const log = new SlowLog({ thresholdUs: 1, maxLen: 5 });
			for (let i = 0; i < 5; i++) {
				log.record({
					durationUs: 100,
					command: "PING",
					args: [`#${i}`],
					tenantId: "t",
				});
			}
			log.setMaxLen(2);
			const remaining = log.entries();
			expect(remaining.length).toBe(2);
			expect(remaining[0].args).toEqual(["#4"]);
			expect(remaining[1].args).toEqual(["#3"]);
		});

		it("growing preserves existing entries and accepts new ones up to the new cap", () => {
			const log = new SlowLog({ thresholdUs: 1, maxLen: 2 });
			log.record({
				durationUs: 100,
				command: "PING",
				args: ["a"],
				tenantId: "t",
			});
			log.setMaxLen(5);
			for (let i = 0; i < 4; i++) {
				log.record({
					durationUs: 100,
					command: "PING",
					args: [`#${i}`],
					tenantId: "t",
				});
			}
			expect(log.length).toBe(5);
		});
	});
});
