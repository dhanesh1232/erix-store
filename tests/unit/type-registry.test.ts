/**
 * @file type-registry.test.ts
 *
 * Unit tests for the TypeRegistry — the gate that prevents the same key
 * from existing under multiple data types simultaneously.
 */

import { describe, expect, it, vi } from "vitest";
import { WrongTypeError } from "../../src/core/errors.js";
import { TypeRegistry } from "../../src/core/TypeRegistry.js";

describe("TypeRegistry", () => {
	describe("register", () => {
		it("registers a new key with the given type", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "string");
			expect(reg.getType("foo")).toBe("string");
		});

		it("is idempotent for the same type", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "list");
			expect(() => reg.register("foo", "list")).not.toThrow();
			expect(reg.getType("foo")).toBe("list");
		});

		it("throws WrongTypeError when the key already exists as a different type", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "string");
			expect(() => reg.register("foo", "list")).toThrow(WrongTypeError);
		});

		it("uses the canonical Redis-style WRONGTYPE message", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "string");
			try {
				reg.register("foo", "hash");
				expect.fail("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(WrongTypeError);
				expect((err as WrongTypeError).message).toBe(
					"WRONGTYPE Operation against a key holding the wrong kind of value",
				);
				expect((err as WrongTypeError).code).toBe("WRONGTYPE");
			}
		});
	});

	describe("assertType", () => {
		it("does not throw when the key is unregistered", () => {
			const reg = new TypeRegistry();
			expect(() => reg.assertType("missing", "string")).not.toThrow();
		});

		it("does not throw when types match", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "set");
			expect(() => reg.assertType("foo", "set")).not.toThrow();
		});

		it("throws WrongTypeError when types differ", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "set");
			expect(() => reg.assertType("foo", "list")).toThrow(WrongTypeError);
		});
	});

	describe("unregister", () => {
		it("removes the key", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "string");
			reg.unregister("foo");
			expect(reg.getType("foo")).toBe(null);
		});

		it("is a no-op for unknown keys", () => {
			const reg = new TypeRegistry();
			expect(() => reg.unregister("never-set")).not.toThrow();
		});

		it("allows the key to be re-registered as a different type", () => {
			const reg = new TypeRegistry();
			reg.register("foo", "list");
			reg.unregister("foo");
			expect(() => reg.register("foo", "string")).not.toThrow();
			expect(reg.getType("foo")).toBe("string");
		});
	});

	describe("export / import", () => {
		it("round-trips through export/import", () => {
			const reg = new TypeRegistry();
			reg.register("a", "string");
			reg.register("b", "hash");
			reg.register("c", "zset");

			const exported = reg.export();

			const reg2 = new TypeRegistry();
			reg2.import(exported);
			expect(reg2.getType("a")).toBe("string");
			expect(reg2.getType("b")).toBe("hash");
			expect(reg2.getType("c")).toBe("zset");
			expect(reg2.size).toBe(3);
		});

		it("import replaces existing state", () => {
			const reg = new TypeRegistry();
			reg.register("old", "string");
			reg.import({ new: "list" });
			expect(reg.getType("old")).toBe(null);
			expect(reg.getType("new")).toBe("list");
		});
	});

	describe("rebuildFromStores", () => {
		// Minimal fake store that satisfies the rebuildFromStores contract
		const makeStore = (keys: string[]) => {
			const data = new Set(keys);
			return {
				keys: () => data.values(),
				delete: (k: string) => {
					data.delete(k);
				},
				has: (k: string) => data.has(k),
			};
		};

		it("registers each key from each sub-store with the correct type", () => {
			const reg = new TypeRegistry();
			const collisions = reg.rebuildFromStores({
				string: makeStore(["s1"]),
				hash: makeStore(["h1"]),
				list: makeStore(["l1"]),
				set: makeStore(["set1"]),
				zset: makeStore(["z1"]),
			});

			expect(collisions).toHaveLength(0);
			expect(reg.getType("s1")).toBe("string");
			expect(reg.getType("h1")).toBe("hash");
			expect(reg.getType("l1")).toBe("list");
			expect(reg.getType("set1")).toBe("set");
			expect(reg.getType("z1")).toBe("zset");
			expect(reg.size).toBe(5);
		});

		it("resolves multi-type collisions via priority order (string > hash > list > set > zset)", () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const reg = new TypeRegistry();

			const stringStore = makeStore(["dup"]);
			const listStore = makeStore(["dup"]);

			reg.rebuildFromStores({
				string: stringStore,
				hash: makeStore([]),
				list: listStore,
				set: makeStore([]),
				zset: makeStore([]),
			});

			expect(reg.getType("dup")).toBe("string");
			// The losing copy must have been deleted from its store
			expect(listStore.has("dup")).toBe(false);
		});

		it("returns the list of collisions for callers to log/inspect", () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const reg = new TypeRegistry();
			const collisions = reg.rebuildFromStores({
				string: makeStore(["k"]),
				hash: makeStore(["k"]),
				list: makeStore(["k"]),
				set: makeStore([]),
				zset: makeStore([]),
			});

			expect(collisions).toHaveLength(1);
			expect(collisions[0]).toMatchObject({
				key: "k",
				winner: "string",
				losers: expect.arrayContaining(["hash", "list"]),
			});
		});
	});

	describe("clear", () => {
		it("empties the registry", () => {
			const reg = new TypeRegistry();
			reg.register("a", "string");
			reg.register("b", "hash");
			reg.clear();
			expect(reg.size).toBe(0);
			expect(reg.getType("a")).toBe(null);
		});
	});
});
