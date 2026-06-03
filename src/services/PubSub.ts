/**
 * @file PubSub.ts
 * @module Services/PubSub
 *
 * In-process pub/sub with two subscription kinds:
 *
 *   - **Exact subscribers** (`subscribe(channel, cb)`) receive only messages
 *     published to that exact channel name.
 *   - **Pattern subscribers** (`psubscribe(pattern, cb)`) receive messages on
 *     any channel whose name matches the supplied glob (Redis-style: `*`,
 *     `?`, `[abc]`, `[^abc]`, `[a-z]`, `\\<char>`).
 *
 * Why we own the data structures
 * -------------------------------
 * The previous version was a thin wrapper over Node's `EventEmitter`, which
 * works for fan-out but doesn't support pattern matching and gives no way to
 * answer `PUBSUB CHANNELS` / `NUMSUB` / `NUMPAT` without leaking emitter
 * internals. Owning the maps makes those queries direct and lets us guarantee
 * pattern-vs-exact ordering when one publish fans out to both.
 *
 * Pattern matching reuses {@link globToRegExp} from `server/glob.ts` so the
 * KEYS and PSUBSCRIBE surfaces share semantics — and one set of glob tests.
 *
 * Tenant isolation lives at the route layer: every channel name passed to
 * the service is already tenant-prefixed. This service does not need to know
 * about tenants.
 *
 * @requirements P1.4 — PSUBSCRIBE / PUBSUB introspection
 */

import { globToRegExp } from "../server/glob.js";

/** JSON-serializable pub/sub message. */
export type PubSubMessage = string | number | boolean | null | object;

/** Listener for an exact-match subscription. */
export type ExactListener = (message: PubSubMessage, channel: string) => void;

/** Listener for a pattern subscription. The matched channel is passed in. */
export type PatternListener = (
	message: PubSubMessage,
	channel: string,
	pattern: string,
) => void;

interface PatternEntry {
	regex: RegExp;
	listeners: Set<PatternListener>;
}

export class PubSubService {
	/** channel → set of exact subscribers */
	private channels = new Map<string, Set<ExactListener>>();

	/** patternKey (the original glob string) → compiled regex + listeners */
	private patterns = new Map<string, PatternEntry>();

	/**
	 * Publish to a channel.
	 * Returns the number of receivers (exact + pattern) that the message
	 * was delivered to — matches Redis PUBLISH return value.
	 */
	publish(channel: string, message: PubSubMessage): number {
		let delivered = 0;

		const exact = this.channels.get(channel);
		if (exact) {
			// Iterate a snapshot so a listener that unsubscribes itself
			// does not corrupt the iteration.
			for (const listener of [...exact]) {
				listener(message, channel);
				delivered++;
			}
		}

		for (const [pattern, entry] of this.patterns) {
			if (!entry.regex.test(channel)) continue;
			for (const listener of [...entry.listeners]) {
				listener(message, channel, pattern);
				delivered++;
			}
		}

		return delivered;
	}

	/** Subscribe to a single exact channel. */
	subscribe(channel: string, callback: ExactListener): void {
		let set = this.channels.get(channel);
		if (!set) {
			set = new Set();
			this.channels.set(channel, set);
		}
		set.add(callback);
	}

	/** Unsubscribe an exact-match listener. Drops the channel entry when empty. */
	unsubscribe(channel: string, callback: ExactListener): void {
		const set = this.channels.get(channel);
		if (!set) return;
		set.delete(callback);
		if (set.size === 0) this.channels.delete(channel);
	}

	/**
	 * Subscribe via a glob pattern (Redis PSUBSCRIBE).
	 * Multiple subscribers on the same pattern share one compiled regex.
	 */
	psubscribe(pattern: string, callback: PatternListener): void {
		let entry = this.patterns.get(pattern);
		if (!entry) {
			entry = { regex: globToRegExp(pattern), listeners: new Set() };
			this.patterns.set(pattern, entry);
		}
		entry.listeners.add(callback);
	}

	/** Remove a pattern subscription. Drops the pattern entry when empty. */
	punsubscribe(pattern: string, callback: PatternListener): void {
		const entry = this.patterns.get(pattern);
		if (!entry) return;
		entry.listeners.delete(callback);
		if (entry.listeners.size === 0) this.patterns.delete(pattern);
	}

	// ── Introspection ─────────────────────────────────────────────────────────

	/**
	 * List every channel name that currently has at least one exact subscriber,
	 * optionally filtered by a glob pattern (Redis PUBSUB CHANNELS).
	 *
	 * Pattern subscribers do not show up here — that's PUBSUB NUMPAT, and it
	 * matches Redis's distinction between concrete channels and patterns.
	 */
	listChannels(pattern?: string): string[] {
		if (!pattern || pattern === "*") return Array.from(this.channels.keys());
		const regex = globToRegExp(pattern);
		const out: string[] = [];
		for (const channel of this.channels.keys()) {
			if (regex.test(channel)) out.push(channel);
		}
		return out;
	}

	/** Exact subscriber count for a single channel. */
	subscriberCount(channel: string): number {
		return this.channels.get(channel)?.size ?? 0;
	}

	/**
	 * Per-channel exact subscriber counts (Redis PUBSUB NUMSUB).
	 * Channels without subscribers report 0 (matches Redis).
	 */
	numSub(channels: string[]): Record<string, number> {
		const out: Record<string, number> = {};
		for (const c of channels) out[c] = this.channels.get(c)?.size ?? 0;
		return out;
	}

	/**
	 * Number of unique patterns currently registered (Redis PUBSUB NUMPAT).
	 * Identical patterns from multiple subscribers count once.
	 */
	numPat(): number {
		return this.patterns.size;
	}
}
