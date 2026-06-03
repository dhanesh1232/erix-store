/**
 * @file command-dispatcher-extras.test.ts
 *
 * Per-verb correctness for the P1.3 expansion: arithmetic / multi-key
 * strings, full hash surface, set algebra, and zset rank/range/incr.
 *
 * Why a separate file: the existing `command-dispatcher.test.ts` pins
 * down core behavior and tenant isolation. This one focuses on the
 * Redis-flavored edge cases — overflow protection, atomicity of MSET,
 * SETNX-vs-WRONGTYPE asymmetry, ZREVRANGE negative indices, etc.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { dispatchCommand } from "../../src/server/commands.js";

describe("Strings P1.3", () => {
	let store: ErixStore;
	afterEach(() => store.ttlManager.stopSweep());
	const cmd = (name: string, ...args: unknown[]) =>
		dispatchCommand({ store }, "t", { name, args });

	describe("INCR / DECR / INCRBY / DECRBY", () => {
		it("INCR creates a counter at 1 when missing", () => {
			store = new ErixStore();
			expect(cmd("INCR", "n")).toEqual({ ok: true, value: 1 });
			expect(cmd("INCR", "n")).toEqual({ ok: true, value: 2 });
		});

		it("DECR creates a counter at -1 when missing", () => {
			store = new ErixStore();
			expect(cmd("DECR", "n")).toEqual({ ok: true, value: -1 });
		});

		it("INCRBY / DECRBY apply the supplied delta", () => {
			store = new ErixStore();
			expect(cmd("INCRBY", "n", 5)).toEqual({ ok: true, value: 5 });
			expect(cmd("DECRBY", "n", 2)).toEqual({ ok: true, value: 3 });
		});

		it("rejects existing values that are not integers", () => {
			store = new ErixStore();
			cmd("SET", "n", "not-a-number");
			const r = cmd("INCR", "n");
			expect(r.ok).toBe(false);
			expect((r as { error: string }).error).toMatch(/not an integer/);
		});

		it("rejects increments that overflow the safe-integer range", () => {
			store = new ErixStore();
			cmd("SET", "n", String(Number.MAX_SAFE_INTEGER));
			const r = cmd("INCR", "n");
			expect(r.ok).toBe(false);
			expect((r as { error: string }).error).toMatch(/overflow/);
		});

		it("INCR on a non-string key is WRONGTYPE", () => {
			store = new ErixStore();
			cmd("RPUSH", "l", "a");
			const r = cmd("INCR", "l");
			expect(r.ok).toBe(false);
			expect((r as { code: string }).code).toBe("WRONGTYPE");
		});
	});

	describe("APPEND / STRLEN", () => {
		it("APPEND creates the key when missing and returns the new length", () => {
			store = new ErixStore();
			expect(cmd("APPEND", "k", "hello")).toEqual({ ok: true, value: 5 });
			expect(cmd("APPEND", "k", " world")).toEqual({ ok: true, value: 11 });
			expect(cmd("GET", "k")).toEqual({ ok: true, value: "hello world" });
		});

		it("STRLEN returns 0 for missing keys", () => {
			store = new ErixStore();
			expect(cmd("STRLEN", "nope")).toEqual({ ok: true, value: 0 });
		});

		it("STRLEN on a non-string key is WRONGTYPE", () => {
			store = new ErixStore();
			cmd("RPUSH", "l", "a");
			const r = cmd("STRLEN", "l");
			expect(r.ok).toBe(false);
			expect((r as { code: string }).code).toBe("WRONGTYPE");
		});
	});

	describe("MSET / MGET", () => {
		it("MSET writes every key atomically", () => {
			store = new ErixStore();
			expect(cmd("MSET", "a", "1", "b", "2", "c", "3")).toEqual({
				ok: true,
				value: "OK",
			});
			expect(cmd("MGET", "a", "b", "c")).toEqual({
				ok: true,
				value: ["1", "2", "3"],
			});
		});

		it("MGET returns null for missing or non-string keys (no WRONGTYPE)", () => {
			store = new ErixStore();
			cmd("SET", "s", "v");
			cmd("RPUSH", "l", "a");
			expect(cmd("MGET", "s", "missing", "l")).toEqual({
				ok: true,
				value: ["v", null, null],
			});
		});

		it("MSET is atomic on WRONGTYPE — partial writes do not happen", () => {
			store = new ErixStore();
			cmd("RPUSH", "l", "a"); // l is now a list

			const r = cmd("MSET", "first", "1", "l", "2", "third", "3");
			expect(r.ok).toBe(false);
			expect((r as { code: string }).code).toBe("WRONGTYPE");

			// None of the keys must have been written.
			expect(cmd("EXISTS", "first")).toEqual({ ok: true, value: 0 });
			expect(cmd("EXISTS", "third")).toEqual({ ok: true, value: 0 });
		});

		it("MSET clears any prior TTL on the affected keys", () => {
			store = new ErixStore();
			cmd("SET", "k", "old", "EX", 30);
			cmd("MSET", "k", "new");
			expect(cmd("TTL", "k")).toEqual({ ok: true, value: -1 });
		});
	});

	describe("GETSET / SETNX", () => {
		it("GETSET returns the previous value and stores the new one", () => {
			store = new ErixStore();
			expect(cmd("GETSET", "k", "first")).toEqual({ ok: true, value: null });
			expect(cmd("GETSET", "k", "second")).toEqual({
				ok: true,
				value: "first",
			});
			expect(cmd("GET", "k")).toEqual({ ok: true, value: "second" });
		});

		it("GETSET clears any TTL (matches Redis SET semantics)", () => {
			store = new ErixStore();
			cmd("SET", "k", "v", "EX", 30);
			cmd("GETSET", "k", "new");
			expect(cmd("TTL", "k")).toEqual({ ok: true, value: -1 });
		});

		it("GETSET on a non-string key is WRONGTYPE", () => {
			store = new ErixStore();
			cmd("RPUSH", "l", "a");
			const r = cmd("GETSET", "l", "x");
			expect(r.ok).toBe(false);
			expect((r as { code: string }).code).toBe("WRONGTYPE");
		});

		it("SETNX returns 1 on success, 0 when the key already exists", () => {
			store = new ErixStore();
			expect(cmd("SETNX", "k", "v1")).toEqual({ ok: true, value: 1 });
			expect(cmd("SETNX", "k", "v2")).toEqual({ ok: true, value: 0 });
			expect(cmd("GET", "k")).toEqual({ ok: true, value: "v1" });
		});

		it("SETNX returns 0 (NOT WRONGTYPE) for an existing non-string key", () => {
			store = new ErixStore();
			cmd("RPUSH", "l", "a");
			// Redis returns 0 here without raising WRONGTYPE — the key exists,
			// so the conditional fails and there is nothing to do.
			expect(cmd("SETNX", "l", "x")).toEqual({ ok: true, value: 0 });
		});
	});
});

describe("Hashes P1.3", () => {
	let store: ErixStore;
	afterEach(() => store.ttlManager.stopSweep());
	const cmd = (name: string, ...args: unknown[]) =>
		dispatchCommand({ store }, "t", { name, args });

	it("HMSET / HMGET round-trip", () => {
		store = new ErixStore();
		expect(cmd("HMSET", "h", "a", "1", "b", "2")).toEqual({
			ok: true,
			value: "OK",
		});
		expect(cmd("HMGET", "h", "a", "missing", "b")).toEqual({
			ok: true,
			value: ["1", null, "2"],
		});
	});

	it("HMGET on a missing key returns nulls in the same shape", () => {
		store = new ErixStore();
		expect(cmd("HMGET", "ghost", "a", "b")).toEqual({
			ok: true,
			value: [null, null],
		});
	});

	it("HEXISTS / HKEYS / HVALS / HLEN", () => {
		store = new ErixStore();
		cmd("HMSET", "h", "a", "1", "b", "2");
		expect(cmd("HEXISTS", "h", "a")).toEqual({ ok: true, value: 1 });
		expect(cmd("HEXISTS", "h", "missing")).toEqual({ ok: true, value: 0 });
		expect(cmd("HLEN", "h")).toEqual({ ok: true, value: 2 });

		const keys = cmd("HKEYS", "h");
		expect(keys.ok).toBe(true);
		expect((keys as { value: string[] }).value.sort()).toEqual(["a", "b"]);

		const vals = cmd("HVALS", "h");
		expect(vals.ok).toBe(true);
		expect((vals as { value: string[] }).value.sort()).toEqual(["1", "2"]);
	});

	it("HINCRBY creates the field at 0 + delta when missing", () => {
		store = new ErixStore();
		expect(cmd("HINCRBY", "h", "counter", 5)).toEqual({ ok: true, value: 5 });
		expect(cmd("HINCRBY", "h", "counter", 3)).toEqual({ ok: true, value: 8 });
		expect(cmd("HINCRBY", "h", "counter", -10)).toEqual({
			ok: true,
			value: -2,
		});
	});

	it("HINCRBY rejects non-integer field values", () => {
		store = new ErixStore();
		cmd("HSET", "h", "f", "not-a-number");
		const r = cmd("HINCRBY", "h", "f", 1);
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toMatch(/integer/);
	});
});

describe("Sets P1.3", () => {
	let store: ErixStore;
	afterEach(() => store.ttlManager.stopSweep());
	const cmd = (name: string, ...args: unknown[]) =>
		dispatchCommand({ store }, "t", { name, args });

	it("SCARD", () => {
		store = new ErixStore();
		cmd("SADD", "s", "a", "b", "c");
		expect(cmd("SCARD", "s")).toEqual({ ok: true, value: 3 });
		expect(cmd("SCARD", "missing")).toEqual({ ok: true, value: 0 });
	});

	it("SINTER returns the intersection", () => {
		store = new ErixStore();
		cmd("SADD", "a", "1", "2", "3");
		cmd("SADD", "b", "2", "3", "4");
		cmd("SADD", "c", "3", "4", "5");
		const r = cmd("SINTER", "a", "b", "c");
		expect(r.ok).toBe(true);
		expect((r as { value: string[] }).value.sort()).toEqual(["3"]);
	});

	it("SINTER returns [] when any input is empty/missing", () => {
		store = new ErixStore();
		cmd("SADD", "a", "1", "2");
		expect(cmd("SINTER", "a", "ghost")).toEqual({ ok: true, value: [] });
	});

	it("SUNION returns the union", () => {
		store = new ErixStore();
		cmd("SADD", "a", "1", "2");
		cmd("SADD", "b", "2", "3");
		const r = cmd("SUNION", "a", "b");
		expect(r.ok).toBe(true);
		expect((r as { value: string[] }).value.sort()).toEqual(["1", "2", "3"]);
	});

	it("SDIFF returns members of the first set not in the others", () => {
		store = new ErixStore();
		cmd("SADD", "a", "1", "2", "3");
		cmd("SADD", "b", "2");
		cmd("SADD", "c", "3");
		const r = cmd("SDIFF", "a", "b", "c");
		expect(r.ok).toBe(true);
		expect((r as { value: string[] }).value.sort()).toEqual(["1"]);
	});

	it("SINTER / SUNION / SDIFF WRONGTYPE on a non-set input", () => {
		store = new ErixStore();
		cmd("SADD", "a", "1");
		cmd("RPUSH", "l", "x");
		expect((cmd("SINTER", "a", "l") as { code?: string }).code).toBe(
			"WRONGTYPE",
		);
		expect((cmd("SUNION", "a", "l") as { code?: string }).code).toBe(
			"WRONGTYPE",
		);
		expect((cmd("SDIFF", "a", "l") as { code?: string }).code).toBe(
			"WRONGTYPE",
		);
	});
});

describe("Sorted sets P1.3", () => {
	let store: ErixStore;
	afterEach(() => store.ttlManager.stopSweep());
	const cmd = (name: string, ...args: unknown[]) =>
		dispatchCommand({ store }, "t", { name, args });

	it("ZCARD / ZCOUNT", () => {
		store = new ErixStore();
		cmd("ZADD", "z", 1, "a", 2, "b", 3, "c", 4, "d");
		expect(cmd("ZCARD", "z")).toEqual({ ok: true, value: 4 });
		expect(cmd("ZCOUNT", "z", 2, 3)).toEqual({ ok: true, value: 2 });
		expect(cmd("ZCOUNT", "z", 10, 20)).toEqual({ ok: true, value: 0 });
	});

	it("ZRANK returns the 0-based rank (lowest score first)", () => {
		store = new ErixStore();
		cmd("ZADD", "z", 1, "a", 2, "b", 3, "c");
		expect(cmd("ZRANK", "z", "a")).toEqual({ ok: true, value: 0 });
		expect(cmd("ZRANK", "z", "c")).toEqual({ ok: true, value: 2 });
		expect(cmd("ZRANK", "z", "missing")).toEqual({ ok: true, value: null });
	});

	it("ZREVRANGE walks in descending order with negative-index support", () => {
		store = new ErixStore();
		cmd("ZADD", "z", 1, "a", 2, "b", 3, "c");
		expect(cmd("ZREVRANGE", "z", 0, -1)).toEqual({
			ok: true,
			value: ["c", "b", "a"],
		});
		expect(cmd("ZREVRANGE", "z", 0, 0)).toEqual({ ok: true, value: ["c"] });
		expect(cmd("ZREVRANGE", "z", -2, -1)).toEqual({
			ok: true,
			value: ["b", "a"],
		});
	});

	it("ZRANGEBYSCORE filters inclusively", () => {
		store = new ErixStore();
		cmd("ZADD", "z", 1, "a", 2, "b", 3, "c", 4, "d");
		expect(cmd("ZRANGEBYSCORE", "z", 2, 3)).toEqual({
			ok: true,
			value: ["b", "c"],
		});
	});

	it("ZINCRBY increments existing scores and creates missing members", () => {
		store = new ErixStore();
		expect(cmd("ZINCRBY", "z", 5, "x")).toEqual({ ok: true, value: 5 });
		expect(cmd("ZINCRBY", "z", 2.5, "x")).toEqual({ ok: true, value: 7.5 });
		expect(cmd("ZSCORE", "z", "x")).toEqual({ ok: true, value: 7.5 });
	});

	it("ZINCRBY moves the member to the correct rank", () => {
		store = new ErixStore();
		cmd("ZADD", "z", 1, "a", 2, "b", 3, "c");
		cmd("ZINCRBY", "z", 10, "a"); // a now has score 11 — last
		expect(cmd("ZRANGE", "z", 0, -1)).toEqual({
			ok: true,
			value: ["b", "c", "a"],
		});
	});
});
