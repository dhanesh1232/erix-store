/**
 * @file config-registry.test.ts
 *
 * Unit tests for the runtime-tunable parameter registry.
 *
 * The registry's contract is small:
 *   - register(param) catalogs a name → {get, set} pair.
 *   - entries(pattern) returns matches in stable, alphabetical order.
 *   - set(name, raw) validates via the param's setter; unknown names
 *     and validation failures throw clear messages.
 *
 * Plus the validator helpers — they're shared by every tunable in the
 * boot wiring, so locking them down here means a typo in one place
 * doesn't leak inconsistency across the surface.
 */

import { describe, expect, it } from "vitest";
import {
	ConfigRegistry,
	parseEnum,
	parseNonNegInt,
	parsePosInt,
} from "../../src/services/ConfigRegistry.js";

describe("ConfigRegistry", () => {
	it("returns an empty list when nothing is registered", () => {
		expect(new ConfigRegistry().entries()).toEqual([]);
	});

	it("registers a param and returns it via entries()", () => {
		const reg = new ConfigRegistry();
		let value = "10";
		reg.register({
			name: "demo",
			get: () => value,
			set: (raw) => {
				value = raw;
			},
		});
		expect(reg.entries()).toEqual([{ name: "demo", value: "10" }]);
	});

	it("entries() filters by glob pattern", () => {
		const reg = new ConfigRegistry();
		reg.register({ name: "maxmemory", get: () => "0", set: () => {} });
		reg.register({
			name: "maxmemory-policy",
			get: () => "noeviction",
			set: () => {},
		});
		reg.register({ name: "slowlog-max-len", get: () => "128", set: () => {} });

		expect(reg.entries("max*").map((e) => e.name)).toEqual([
			"maxmemory",
			"maxmemory-policy",
		]);
		expect(reg.entries("slowlog-*").map((e) => e.name)).toEqual([
			"slowlog-max-len",
		]);
		expect(reg.entries("*").length).toBe(3);
	});

	it("entries() output is sorted alphabetically", () => {
		const reg = new ConfigRegistry();
		reg.register({ name: "z", get: () => "1", set: () => {} });
		reg.register({ name: "a", get: () => "2", set: () => {} });
		reg.register({ name: "m", get: () => "3", set: () => {} });

		expect(reg.entries().map((e) => e.name)).toEqual(["a", "m", "z"]);
	});

	it("set() routes the raw value to the matching setter", () => {
		const reg = new ConfigRegistry();
		let observed = "";
		reg.register({
			name: "demo",
			get: () => observed,
			set: (raw) => {
				observed = raw;
			},
		});
		reg.set("demo", "hello");
		expect(observed).toBe("hello");
	});

	it("set() is case-insensitive on the name", () => {
		const reg = new ConfigRegistry();
		let value = "";
		reg.register({
			name: "max-memory",
			get: () => value,
			set: (raw) => {
				value = raw;
			},
		});
		reg.set("MAX-MEMORY", "100");
		expect(value).toBe("100");
	});

	it("set() throws on unknown parameter", () => {
		const reg = new ConfigRegistry();
		expect(() => reg.set("ghost", "x")).toThrow(/unknown CONFIG parameter/);
	});

	it("set() propagates validator errors", () => {
		const reg = new ConfigRegistry();
		reg.register({
			name: "demo",
			get: () => "0",
			set: (raw) => {
				const n = Number(raw);
				if (!Number.isFinite(n)) throw new Error("must be a number");
			},
		});
		expect(() => reg.set("demo", "nope")).toThrow(/must be a number/);
	});
});

describe("validator helpers", () => {
	describe("parseNonNegInt", () => {
		it("accepts 0 and positive integers", () => {
			expect(parseNonNegInt("0", "x")).toBe(0);
			expect(parseNonNegInt("42", "x")).toBe(42);
		});

		it("rejects negative, fractional, or non-numeric", () => {
			expect(() => parseNonNegInt("-1", "x")).toThrow();
			expect(() => parseNonNegInt("3.14", "x")).toThrow();
			expect(() => parseNonNegInt("abc", "x")).toThrow();
		});
	});

	describe("parsePosInt", () => {
		it("accepts strictly positive integers", () => {
			expect(parsePosInt("1", "x")).toBe(1);
			expect(parsePosInt("9999", "x")).toBe(9999);
		});

		it("rejects 0 explicitly", () => {
			expect(() => parsePosInt("0", "x")).toThrow(/> 0/);
		});
	});

	describe("parseEnum", () => {
		const allowed = ["a", "b", "c"] as const;

		it("normalises case and returns the enum value", () => {
			expect(parseEnum("A", "x", allowed)).toBe("a");
			expect(parseEnum("c", "x", allowed)).toBe("c");
		});

		it("rejects values outside the enum with an error listing options", () => {
			try {
				parseEnum("d", "x", allowed);
				expect.fail("should have thrown");
			} catch (err) {
				expect((err as Error).message).toMatch(/a, b, c/);
			}
		});
	});
});
