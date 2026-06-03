/**
 * @file PriorityQueue.ts
 * @module Services/PriorityQueue
 *
 * Lightweight Redis-style priority queue.
 *
 * This is intentionally separate from {@link JobQueueV2}. JobQueueV2 is the
 * durable workflow engine (WAL, retries, DLQ, heartbeats, tenant fairness).
 * PriorityQueue is the fire-and-forget primitive that backs the verbs the
 * Phase-4 checklist calls out: `ENQUEUE`, `DEQUEUE`, `QLEN`, `QPEEK`,
 * `QCLEAR`. Different needs, different code paths.
 *
 * Semantics
 * ---------
 *   - Each queue is a min-heap keyed by `(-priority, seq)` so higher
 *     priority pops first; on a tie, the earlier `enqueue` wins (FIFO).
 *   - `seq` is a monotonically increasing counter shared across all
 *     queues — sufficient for any single-process workload.
 *   - `enqueue` runs in O(log n); `dequeue` in O(log n); `peek` / `len`
 *     in O(1); `clear` drops the entire queue in O(1) by replacing it.
 *   - Multi-tenant safety is the route layer's responsibility — every
 *     queue name passed in here is already tenant-prefixed.
 *
 * Snapshot wire format (`Record<queueName, Entry[]>`) is heap-internal
 * order, not insertion order. `import` rebuilds the heap from the entries
 * so it doesn't matter.
 *
 * @requirements P1.1 — ENQUEUE/DEQUEUE/QLEN/QPEEK/QCLEAR
 */

import { BinaryMaxHeap } from "../structures/BinaryHeap.js";

/** A single queued payload + the metadata the heap needs for ordering. */
interface Entry {
	/** User-supplied JSON payload (already serialized by the route). */
	value: string;
	/** Higher = more important. Default 0. */
	priority: number;
	/** Monotonic insertion sequence — used to break priority ties FIFO. */
	seq: number;
}

/**
 * Heap comparator: higher priority wins, then lower seq (older first).
 * Returns positive when `a` should come out *before* `b`.
 */
function compare(a: Entry, b: Entry): number {
	if (a.priority !== b.priority) return a.priority - b.priority;
	return b.seq - a.seq;
}

export class PriorityQueue {
	private queues = new Map<string, BinaryMaxHeap<Entry>>();
	private nextSeq = 0;

	/** Push `value` onto `queue` with `priority` (default 0). Returns new length. */
	enqueue(queue: string, value: string, priority = 0): number {
		const heap = this.getOrCreate(queue);
		heap.push({ value, priority, seq: this.nextSeq++ });
		return heap.size;
	}

	/** Pop the highest-priority entry. Returns `null` for an empty queue. */
	dequeue(queue: string): string | null {
		const heap = this.queues.get(queue);
		if (!heap || heap.size === 0) return null;
		const entry = heap.pop();
		if (heap.size === 0) this.queues.delete(queue);
		return entry?.value ?? null;
	}

	/** Inspect the next entry without removing it. */
	peek(queue: string): string | null {
		return this.queues.get(queue)?.peek()?.value ?? null;
	}

	/** Number of entries in `queue`. 0 for missing queues. */
	len(queue: string): number {
		return this.queues.get(queue)?.size ?? 0;
	}

	/** Drop all entries from `queue`. Returns the number cleared. */
	clear(queue: string): number {
		const heap = this.queues.get(queue);
		if (!heap) return 0;
		const count = heap.size;
		this.queues.delete(queue);
		return count;
	}

	/** Yields the names of all non-empty queues (used by snapshot/export). */
	keys(): IterableIterator<string> {
		return this.queues.keys();
	}

	/**
	 * Export every queue as an array of entries.
	 *
	 * The order inside each array is heap-internal, *not* dequeue order. That's
	 * fine because `import` rebuilds the heap from the entries — the recovered
	 * queue dequeues in the same priority/FIFO order as the original.
	 */
	export(): Record<string, Entry[]> {
		const out: Record<string, Entry[]> = {};
		for (const [name, heap] of this.queues) {
			const entries: Entry[] = [];
			for (const e of heap) entries.push(e);
			out[name] = entries;
		}
		return out;
	}

	/** Replace state from a previously exported snapshot. */
	import(data: Record<string, Entry[]>): void {
		this.queues.clear();
		let maxSeq = -1;
		for (const [name, entries] of Object.entries(data)) {
			const heap = new BinaryMaxHeap<Entry>(compare);
			for (const e of entries) {
				heap.push(e);
				if (e.seq > maxSeq) maxSeq = e.seq;
			}
			if (heap.size > 0) this.queues.set(name, heap);
		}
		// Resume seq numbering after the highest imported value so new
		// enqueues never collide with restored ones.
		this.nextSeq = maxSeq + 1;
	}

	private getOrCreate(name: string): BinaryMaxHeap<Entry> {
		let heap = this.queues.get(name);
		if (!heap) {
			heap = new BinaryMaxHeap<Entry>(compare);
			this.queues.set(name, heap);
		}
		return heap;
	}
}
