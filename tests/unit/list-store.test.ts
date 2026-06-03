/**
 * @file list-store.test.ts
 *
 * Unit tests for the DLL-backed ListStore. Verifies behavior parity with
 * the prior array-based implementation plus the new Redis-style ops
 * (RPOP, LRANGE, LLEN, LINDEX, LREM, LTRIM) and snapshot round-trip.
 */

import { describe, expect, it } from "vitest";
import { ListStore } from "../../src/structures/ListStore.js";

describe("ListStore", () => {
	describe("lpush / rpush / lpop / rpop", () => {
		it("returns the new length on push", () => {
			const store = new ListStore();
			expect(store.rpush("k", "a")).toBe(1);
			expect(store.rpush("k", "b")).toBe(2);
			expect(store.lpush("k", "c")).toBe(3);
		});

		it("LPUSH/LPOP behaves like a stack from the head", () => {
			const store = new ListStore();
			store.lpush("k", "a");
			store.lpush("k", "b");
			store.lpush("k", "c");
			expect(store.lpop("k")).toBe("c");
			expect(store.lpop("k")).toBe("b");
			expect(store.lpop("k")).toBe("a");
			expect(store.lpop("k")).toBe(null);
		});

		it("RPUSH/RPOP behaves like a stack from the tail", () => {
			const store = new ListStore();
			store.rpush("k", "a");
			store.rpush("k", "b");
			store.rpush("k", "c");
			expect(store.rpop("k")).toBe("c");
			expect(store.rpop("k")).toBe("b");
			expect(store.rpop("k")).toBe("a");
			expect(store.rpop("k")).toBe(null);
		});

		it("RPUSH + LPOP forms a FIFO queue", () => {
			const store = new ListStore();
			store.rpush("q", "1");
			store.rpush("q", "2");
			store.rpush("q", "3");
			expect(store.lpop("q")).toBe("1");
			expect(store.lpop("q")).toBe("2");
			expect(store.lpop("q")).toBe("3");
		});

		it("auto-deletes the key when the list is drained", () => {
			const store = new ListStore();
			store.rpush("k", "only");
			expect(store.has("k")).toBe(true);
			store.lpop("k");
			expect(store.has("k")).toBe(false);
		});
	});

	describe("llen", () => {
		it("returns 0 for missing keys", () => {
			expect(new ListStore().llen("nope")).toBe(0);
		});

		it("tracks length through push/pop", () => {
			const store = new ListStore();
			store.rpush("k", "a");
			store.rpush("k", "b");
			expect(store.llen("k")).toBe(2);
			store.lpop("k");
			expect(store.llen("k")).toBe(1);
		});
	});

	describe("lindex", () => {
		it("returns null for missing keys", () => {
			expect(new ListStore().lindex("nope", 0)).toBe(null);
		});

		it("supports negative indices", () => {
			const store = new ListStore();
			["a", "b", "c"].forEach((v) => store.rpush("k", v));
			expect(store.lindex("k", 0)).toBe("a");
			expect(store.lindex("k", -1)).toBe("c");
			expect(store.lindex("k", 99)).toBe(null);
		});
	});

	describe("lrange", () => {
		it("returns [] for missing keys", () => {
			expect(new ListStore().lrange("nope", 0, -1)).toEqual([]);
		});

		it("returns the full range with [0, -1]", () => {
			const store = new ListStore();
			["a", "b", "c"].forEach((v) => store.rpush("k", v));
			expect(store.lrange("k", 0, -1)).toEqual(["a", "b", "c"]);
		});

		it("supports a middle slice", () => {
			const store = new ListStore();
			["a", "b", "c", "d", "e"].forEach((v) => store.rpush("k", v));
			expect(store.lrange("k", 1, 3)).toEqual(["b", "c", "d"]);
		});
	});

	describe("lrem", () => {
		const seed = () => {
			const store = new ListStore();
			["a", "b", "a", "c", "a"].forEach((v) => store.rpush("k", v));
			return store;
		};

		it("count > 0 removes from head", () => {
			const store = seed();
			expect(store.lrem("k", 2, "a")).toBe(2);
			expect(store.lrange("k", 0, -1)).toEqual(["b", "c", "a"]);
		});

		it("count < 0 removes from tail", () => {
			const store = seed();
			expect(store.lrem("k", -1, "a")).toBe(1);
			expect(store.lrange("k", 0, -1)).toEqual(["a", "b", "a", "c"]);
		});

		it("count = 0 removes all matches and may drop the key", () => {
			const store = new ListStore();
			["a", "a", "a"].forEach((v) => store.rpush("k", v));
			expect(store.lrem("k", 0, "a")).toBe(3);
			expect(store.has("k")).toBe(false);
		});

		it("returns 0 for missing keys", () => {
			expect(new ListStore().lrem("nope", 0, "x")).toBe(0);
		});
	});

	describe("ltrim", () => {
		it("keeps a middle slice", () => {
			const store = new ListStore();
			["a", "b", "c", "d", "e"].forEach((v) => store.rpush("k", v));
			store.ltrim("k", 1, 3);
			expect(store.lrange("k", 0, -1)).toEqual(["b", "c", "d"]);
		});

		it("drops the key when the range empties the list", () => {
			const store = new ListStore();
			["a", "b"].forEach((v) => store.rpush("k", v));
			store.ltrim("k", 5, 10);
			expect(store.has("k")).toBe(false);
		});

		it("is a no-op for missing keys", () => {
			const store = new ListStore();
			expect(() => store.ltrim("nope", 0, 1)).not.toThrow();
		});
	});

	describe("export / import", () => {
		it("round-trips through export/import preserving order", () => {
			const store = new ListStore();
			["a", "b", "c"].forEach((v) => store.rpush("k1", v));
			["x"].forEach((v) => store.rpush("k2", v));

			const data = store.export();
			const restored = new ListStore();
			restored.import(data);

			expect(restored.lrange("k1", 0, -1)).toEqual(["a", "b", "c"]);
			expect(restored.lrange("k2", 0, -1)).toEqual(["x"]);
			// Tail/head pointers must be intact after import — pop both ends.
			expect(restored.rpop("k1")).toBe("c");
			expect(restored.lpop("k1")).toBe("a");
		});

		it("import replaces existing state", () => {
			const store = new ListStore();
			store.rpush("old", "v");
			store.import({ fresh: ["1", "2"] });
			expect(store.has("old")).toBe(false);
			expect(store.lrange("fresh", 0, -1)).toEqual(["1", "2"]);
		});

		it("export of an empty store is empty", () => {
			expect(new ListStore().export()).toEqual({});
		});
	});

	describe("keys / has", () => {
		it("keys() yields each non-empty list", () => {
			const store = new ListStore();
			store.rpush("a", "1");
			store.rpush("b", "1");
			expect([...store.keys()].sort()).toEqual(["a", "b"]);
		});

		it("has() reflects the auto-cleanup on drain", () => {
			const store = new ListStore();
			store.rpush("k", "v");
			expect(store.has("k")).toBe(true);
			store.lpop("k");
			expect(store.has("k")).toBe(false);
		});
	});
});
