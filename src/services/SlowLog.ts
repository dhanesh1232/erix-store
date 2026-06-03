/**
 * @file SlowLog.ts
 * @module Services/SlowLog
 *
 * Bounded slow-command log, modeled on Redis's SLOWLOG.
 *
 * What it captures
 * ----------------
 * Every synchronous command dispatched through the command dispatcher is
 * timed with `process.hrtime.bigint()` (integer nanoseconds, monotonic).
 * Commands whose execution time meets or exceeds the configured
 * `thresholdUs` get recorded into a ring buffer.
 *
 * Why a ring buffer
 * -----------------
 * Slow logging is observability — it's allowed to lose old data, never
 * allowed to consume unbounded memory. A fixed-capacity circular store
 * with O(1) push and O(maxLen) reads gives that contract for free.
 *
 * Tenant scoping
 * --------------
 * Every entry stores its `tenantId`. The dispatcher's `SLOWLOG GET`
 * verb filters to the calling tenant only — operators see their own
 * slow queries without cross-tenant leakage.
 *
 * Argument capture
 * ----------------
 * Args are truncated on insert (max 32 args, each capped to 128 chars).
 * This matches Redis defaults and keeps the slowlog from bloating when
 * an MSET or HSET drops in megabytes of payload.
 *
 * @requirements P2.2 — SLOWLOG
 */

/** A single recorded slow command. */
export interface SlowLogEntry {
	/** Monotonic counter — higher = more recent. */
	id: number;
	/** Wall-clock unix epoch (ms) at which the command completed. */
	timestamp: number;
	/** Wall-clock duration in microseconds (integer). */
	durationUs: number;
	/** Verb name, normalised to upper-case. */
	command: string;
	/** Truncated arg list — see SlowLog constructor for limits. */
	args: string[];
	/** The tenant whose request was running. */
	tenantId: string;
	/** Where the command came from — useful when debugging tx vs single-cmd. */
	source: "single" | "transaction";
}

export interface SlowLogOptions {
	/** Threshold in microseconds. Default 1_000 µs (= 1 ms). 0 disables logging. */
	thresholdUs?: number;
	/** Max entries kept. Older entries are evicted on overflow. Default 128. */
	maxLen?: number;
	/** Max number of args captured per entry. Default 32. */
	maxArgs?: number;
	/** Max length of each captured arg string. Default 128. */
	maxArgLen?: number;
}

const DEFAULT_THRESHOLD_US = 1_000;
const DEFAULT_MAX_LEN = 128;
const DEFAULT_MAX_ARGS = 32;
const DEFAULT_MAX_ARG_LEN = 128;

const TRUNC_SUFFIX = "..."; // visible marker so operators can tell

export class SlowLog {
	private _thresholdUs: number;
	private _maxLen: number;
	private readonly maxArgs: number;
	private readonly maxArgLen: number;

	/** Ring-buffer storage. `head` is the next slot to write. */
	private buffer: (SlowLogEntry | null)[];
	private head = 0;
	private filled = 0;
	private nextId = 0;

	constructor(opts: SlowLogOptions = {}) {
		this._thresholdUs = opts.thresholdUs ?? DEFAULT_THRESHOLD_US;
		this._maxLen = Math.max(1, opts.maxLen ?? DEFAULT_MAX_LEN);
		this.maxArgs = opts.maxArgs ?? DEFAULT_MAX_ARGS;
		this.maxArgLen = opts.maxArgLen ?? DEFAULT_MAX_ARG_LEN;
		this.buffer = new Array(this._maxLen).fill(null);
	}

	// ── Configuration ────────────────────────────────────────────────────────

	get thresholdUs(): number {
		return this._thresholdUs;
	}
	setThresholdUs(us: number): void {
		this._thresholdUs = Math.max(0, us);
	}

	get maxLen(): number {
		return this._maxLen;
	}
	setMaxLen(n: number): void {
		const next = Math.max(1, n);
		if (next === this._maxLen) return;

		// Capture existing entries in chronological order, then rebuild
		// the ring at the new size — keeping the most recent `next` rows.
		const existing = this.entries(this._maxLen);
		this._maxLen = next;
		this.buffer = new Array(next).fill(null);
		this.head = 0;
		this.filled = 0;
		// `entries()` returns newest-first; we want to push oldest-first
		// so newest ends up most recent in the ring.
		for (const entry of existing.slice(0, next).reverse()) {
			this.buffer[this.head] = entry;
			this.head = (this.head + 1) % this._maxLen;
			this.filled = Math.min(this.filled + 1, this._maxLen);
		}
	}

	// ── Recording ────────────────────────────────────────────────────────────

	/**
	 * Record a command if its duration meets the threshold.
	 *
	 * The dispatcher calls this on every command. When `thresholdUs` is 0
	 * we skip logging entirely — this is the "disabled" mode.
	 */
	record(params: {
		durationUs: number;
		command: string;
		args: unknown[];
		tenantId: string;
		source?: SlowLogEntry["source"];
	}): void {
		if (this._thresholdUs === 0) return;
		if (params.durationUs < this._thresholdUs) return;

		const entry: SlowLogEntry = {
			id: this.nextId++,
			timestamp: Date.now(),
			durationUs: Math.floor(params.durationUs),
			command: params.command.toUpperCase(),
			args: this.truncateArgs(params.args),
			tenantId: params.tenantId,
			source: params.source ?? "single",
		};

		this.buffer[this.head] = entry;
		this.head = (this.head + 1) % this._maxLen;
		if (this.filled < this._maxLen) this.filled++;
	}

	// ── Reads ────────────────────────────────────────────────────────────────

	/**
	 * Return the most recent entries, newest-first. Optional `count` caps
	 * the result; pass `Infinity` (or omit) for everything.
	 *
	 * `tenantId` filters to a single tenant's entries. Pass `undefined`
	 * to read across all tenants (used by the test suite, never exposed
	 * to clients via the dispatcher).
	 */
	entries(count: number = this._maxLen, tenantId?: string): SlowLogEntry[] {
		const out: SlowLogEntry[] = [];
		// Walk backwards from the most-recent insertion.
		let idx = (this.head - 1 + this._maxLen) % this._maxLen;
		let remaining = this.filled;
		while (remaining > 0 && out.length < count) {
			const e = this.buffer[idx];
			if (e && (tenantId === undefined || e.tenantId === tenantId)) {
				out.push(e);
			}
			idx = (idx - 1 + this._maxLen) % this._maxLen;
			remaining--;
		}
		return out;
	}

	/** Total number of entries currently stored (across all tenants). */
	get length(): number {
		return this.filled;
	}

	/** Tenant-scoped count, used by `SLOWLOG LEN`. */
	lengthFor(tenantId: string): number {
		let n = 0;
		let idx = (this.head - 1 + this._maxLen) % this._maxLen;
		let remaining = this.filled;
		while (remaining > 0) {
			const e = this.buffer[idx];
			if (e && e.tenantId === tenantId) n++;
			idx = (idx - 1 + this._maxLen) % this._maxLen;
			remaining--;
		}
		return n;
	}

	// ── Reset ────────────────────────────────────────────────────────────────

	/**
	 * Drop every entry. By default tenant-scoped — only the calling
	 * tenant's entries are removed, matching the rest of the multi-tenant
	 * surface. `tenantId === undefined` resets globally (test helper).
	 */
	reset(tenantId?: string): number {
		if (tenantId === undefined) {
			const n = this.filled;
			this.buffer = new Array(this._maxLen).fill(null);
			this.head = 0;
			this.filled = 0;
			return n;
		}

		// Tenant-scoped reset: keep entries belonging to other tenants,
		// drop entries from this tenant. Rebuild compactly.
		const survivors = this.entries(this._maxLen).filter(
			(e) => e.tenantId !== tenantId,
		);
		const dropped = this.filled - survivors.length;
		this.buffer = new Array(this._maxLen).fill(null);
		this.head = 0;
		this.filled = 0;
		// Push survivors in oldest-first order so the newest stays newest.
		for (const e of survivors.reverse()) {
			this.buffer[this.head] = e;
			this.head = (this.head + 1) % this._maxLen;
			if (this.filled < this._maxLen) this.filled++;
		}
		return dropped;
	}

	// ── Internals ────────────────────────────────────────────────────────────

	/**
	 * Truncate args to (maxArgs, maxArgLen). Non-string args are JSON-stringified
	 * with a fallback to `String(value)` for circular references. Output is
	 * always a string array — keeps the wire format simple.
	 */
	private truncateArgs(args: unknown[]): string[] {
		const limit = Math.min(args.length, this.maxArgs);
		const out: string[] = new Array(limit);
		for (let i = 0; i < limit; i++) {
			const a = args[i];
			let str: string;
			if (typeof a === "string") str = a;
			else {
				try {
					str = JSON.stringify(a);
				} catch {
					str = String(a);
				}
			}
			if (str.length > this.maxArgLen) {
				str = str.slice(0, this.maxArgLen - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
			}
			out[i] = str;
		}
		if (args.length > this.maxArgs) {
			out.push(`... (+${args.length - this.maxArgs} more)`);
		}
		return out;
	}
}
