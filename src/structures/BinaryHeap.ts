/**
 * Generic binary heap data structure.
 *
 * Array-backed with standard parent/child index calculations.
 * The comparator determines ordering — use a "greater wins" comparator for a max-heap,
 * or an "lesser wins" comparator for a min-heap.
 *
 * Index layout:
 *   Parent of i:      Math.floor((i - 1) / 2)
 *   Left child of i:  2 * i + 1
 *   Right child of i: 2 * i + 2
 *
 * @requirements 2.1, 2.2, 6.1
 */
export class BinaryMaxHeap<T> {
	private heap: T[] = [];
	private compare: (a: T, b: T) => number;

	/**
	 * @param compare Comparator function. Should return a positive number if `a`
	 * has higher priority than `b`, negative if lower, and 0 if equal.
	 * For a max-heap: (a, b) => a - b (larger values have higher priority).
	 * For a min-heap: (a, b) => b - a (smaller values have higher priority).
	 */
	constructor(compare: (a: T, b: T) => number) {
		this.compare = compare;
	}

	/** Insert an element. O(log n). */
	push(item: T): void {
		this.heap.push(item);
		this.bubbleUp(this.heap.length - 1);
	}

	/** Extract the maximum element (root). O(log n). */
	pop(): T | undefined {
		if (this.heap.length === 0) return undefined;

		const root = this.heap[0];
		const last = this.heap.pop();

		if (this.heap.length > 0 && last !== undefined) {
			this.heap[0] = last;
			this.sinkDown(0);
		}

		return root;
	}

	/** Peek at the maximum without removing. O(1). */
	peek(): T | undefined {
		return this.heap[0];
	}

	/** Number of elements in the heap. */
	get size(): number {
		return this.heap.length;
	}

	/**
	 * Remove an element by predicate. O(n) scan + O(log n) re-heapify.
	 * Used rarely (e.g. job cancellation).
	 */
	remove(predicate: (item: T) => boolean): T | undefined {
		const index = this.heap.findIndex(predicate);
		if (index === -1) return undefined;

		const removed = this.heap[index];

		// Replace with last element and re-heapify
		const last = this.heap.pop();

		if (index < this.heap.length && last !== undefined) {
			this.heap[index] = last;
			// The replacement might need to go up or down
			this.bubbleUp(index);
			this.sinkDown(index);
		}

		return removed;
	}

	/** Iterate elements in no guaranteed order. */
	[Symbol.iterator](): Iterator<T> {
		let index = 0;
		const heap = this.heap;
		return {
			next(): IteratorResult<T> {
				if (index < heap.length) {
					return { value: heap[index++], done: false };
				}
				return { value: undefined as unknown as T, done: true };
			},
		};
	}

	// --- Private helpers ---

	private bubbleUp(index: number): void {
		while (index > 0) {
			const parentIndex = Math.floor((index - 1) / 2);
			if (this.compare(this.heap[index], this.heap[parentIndex]) > 0) {
				this.swap(index, parentIndex);
				index = parentIndex;
			} else {
				break;
			}
		}
	}

	private sinkDown(index: number): void {
		const length = this.heap.length;

		while (true) {
			const left = 2 * index + 1;
			const right = 2 * index + 2;
			let largest = index;

			if (
				left < length &&
				this.compare(this.heap[left], this.heap[largest]) > 0
			) {
				largest = left;
			}

			if (
				right < length &&
				this.compare(this.heap[right], this.heap[largest]) > 0
			) {
				largest = right;
			}

			if (largest !== index) {
				this.swap(index, largest);
				index = largest;
			} else {
				break;
			}
		}
	}

	private swap(i: number, j: number): void {
		const temp = this.heap[i];
		this.heap[i] = this.heap[j];
		this.heap[j] = temp;
	}
}
