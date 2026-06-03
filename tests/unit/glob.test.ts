/**
 * @file glob.test.ts
 *
 * Unit tests for the Redis-style glob → RegExp converter used by the
 * KEYS command. Covers the four supported metacharacter classes plus
 * regex-meta escaping so a pattern like `a.b` matches the literal
 * key `a.b` and only that key.
 */

import { describe, expect, it } from "vitest";
import { globToRegExp } from "../../src/server/glob.js";

describe("globToRegExp", () => {
	const matches = (pattern: string, sample: string) =>
		globToRegExp(pattern).test(sample);

	it("* matches any sequence", () => {
		expect(matches("*", "")).toBe(true);
		expect(matches("*", "anything")).toBe(true);
		expect(matches("user:*", "user:42")).toBe(true);
		expect(matches("user:*", "users:42")).toBe(false);
	});

	it("? matches exactly one character", () => {
		expect(matches("a?c", "abc")).toBe(true);
		expect(matches("a?c", "ac")).toBe(false);
		expect(matches("a?c", "abbc")).toBe(false);
	});

	it("character class [abc]", () => {
		expect(matches("h[ae]llo", "hallo")).toBe(true);
		expect(matches("h[ae]llo", "hello")).toBe(true);
		expect(matches("h[ae]llo", "hxllo")).toBe(false);
	});

	it("negated character class [^abc]", () => {
		expect(matches("h[^x]llo", "hallo")).toBe(true);
		expect(matches("h[^x]llo", "hxllo")).toBe(false);
	});

	it("range [a-z]", () => {
		expect(matches("k[0-9]", "k5")).toBe(true);
		expect(matches("k[0-9]", "ka")).toBe(false);
	});

	it("escapes regex metacharacters in literal patterns", () => {
		// `.` must NOT match any char — only the literal dot
		expect(matches("a.b", "a.b")).toBe(true);
		expect(matches("a.b", "axb")).toBe(false);

		// `+` is a literal in glob
		expect(matches("a+b", "a+b")).toBe(true);
		expect(matches("a+b", "aab")).toBe(false);

		// `(`, `)`, `|` are literals in glob
		expect(matches("(x|y)", "(x|y)")).toBe(true);
	});

	it("backslash escapes the next character", () => {
		// `\\*` matches a literal `*`
		expect(matches("a\\*b", "a*b")).toBe(true);
		expect(matches("a\\*b", "axxb")).toBe(false);

		// `\\?` matches a literal `?`
		expect(matches("a\\?b", "a?b")).toBe(true);
		expect(matches("a\\?b", "azb")).toBe(false);
	});

	it("anchors the pattern to the full string", () => {
		expect(matches("foo", "foo")).toBe(true);
		expect(matches("foo", "foobar")).toBe(false);
		expect(matches("foo", "myfoo")).toBe(false);
	});

	it("treats unclosed [ as a literal bracket", () => {
		expect(matches("a[bc", "a[bc")).toBe(true);
		expect(matches("a[bc", "abc")).toBe(false);
	});

	it("the empty pattern matches only the empty string", () => {
		expect(matches("", "")).toBe(true);
		expect(matches("", "x")).toBe(false);
	});
});
