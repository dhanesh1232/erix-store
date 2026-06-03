/**
 * @file ConfigRegistry.ts
 * @module Services/ConfigRegistry
 *
 * Catalog of runtime-tunable parameters.
 *
 * Each parameter is registered with:
 *   - a canonical name (kebab-case to match Redis CONFIG conventions)
 *   - a type (number / string / enum)
 *   - a getter that reads the live value from its owning service
 *   - a setter that applies a validated value back
 *   - an optional validator that returns a parsed value or throws
 *
 * Why a registry instead of a flat switch
 * ---------------------------------------
 * CONFIG GET supports glob patterns ("max*"); CONFIG SET needs uniform
 * validation. A registry keeps both surfaces honest: pattern matching
 * is just a filter over `entries()`, and adding a new tunable is one
 * `register()` call rather than two new switch arms.
 *
 * @requirements P2.4 — CONFIG GET/SET runtime tunables
 */

import { globToRegExp } from "../server/glob.js";

/** Wire-format value for a config param — always a string for `CONFIG GET`. */
export type ConfigValue = string;

export interface ConfigParam {
	/** Canonical kebab-case name (e.g. "maxmemory-policy"). */
	name: string;
	/** Live value, formatted as the string CONFIG GET will return. */
	get(): ConfigValue;
	/**
	 * Apply a new value. Receives the raw string from `CONFIG SET`.
	 * Implementations should validate and throw on invalid input — the
	 * dispatcher captures the error per-command.
	 */
	set(raw: string): void;
}

export class ConfigRegistry {
	private params = new Map<string, ConfigParam>();

	register(param: ConfigParam): void {
		this.params.set(param.name.toLowerCase(), param);
	}

	/**
	 * Return all params whose name matches the given glob pattern (default `*`).
	 * Output is sorted by name for stable client-side rendering.
	 */
	entries(pattern: string = "*"): Array<{ name: string; value: ConfigValue }> {
		const re = pattern === "*" ? null : globToRegExp(pattern);
		const out: Array<{ name: string; value: ConfigValue }> = [];
		for (const [name, param] of this.params) {
			if (re && !re.test(name)) continue;
			out.push({ name, value: param.get() });
		}
		out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		return out;
	}

	/**
	 * Apply a new value for the named param. Throws if the param is
	 * unknown or if the param's setter rejects the value.
	 */
	set(name: string, raw: string): void {
		const key = name.toLowerCase();
		const param = this.params.get(key);
		if (!param) {
			throw new Error(`unknown CONFIG parameter '${name}'`);
		}
		param.set(raw);
	}

	/** Used by tests to confirm the registered set. */
	has(name: string): boolean {
		return this.params.has(name.toLowerCase());
	}

	size(): number {
		return this.params.size;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────
//
// Tiny validators that throw consistent error messages. The dispatcher
// captures these as `{ ok: false, error }` per-command.

/** Parse a non-negative integer from a CONFIG SET payload. */
export function parseNonNegInt(raw: string, label: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
		throw new Error(`${label} must be a non-negative integer (got "${raw}")`);
	}
	return n;
}

/** Parse a positive integer from a CONFIG SET payload. */
export function parsePosInt(raw: string, label: string): number {
	const n = parseNonNegInt(raw, label);
	if (n === 0) throw new Error(`${label} must be > 0`);
	return n;
}

/** Parse one of a fixed set of enum values. */
export function parseEnum<T extends string>(
	raw: string,
	label: string,
	allowed: readonly T[],
): T {
	const lower = raw.toLowerCase();
	if (!(allowed as readonly string[]).includes(lower)) {
		throw new Error(
			`${label} must be one of: ${allowed.join(", ")} (got "${raw}")`,
		);
	}
	return lower as T;
}
