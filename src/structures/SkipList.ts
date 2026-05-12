interface SkipListNode<K, V> {
	key: K;
	value: V;
	forward: Array<SkipListNode<K, V> | null>;
}

/**
 * A generic skip list data structure providing O(log n) search, insert, and delete.
 * Uses a comparator function for flexible key ordering.
 *
 * Max level: 16 (supports ~65,536 elements efficiently)
 * Probability: 0.5 (each level has ~50% of the nodes from the level below)
 */
export class SkipList<K, V> {
	private head: SkipListNode<K, V>;
	private level: number;
	private _size: number;
	private compare: (a: K, b: K) => number;
	private readonly maxLevel: number = 16;
	private readonly probability: number = 0.5;

	constructor(compare: (a: K, b: K) => number) {
		this.compare = compare;
		this.level = 0;
		this._size = 0;
		// Sentinel head node — key and value are never accessed
		this.head = this.createNode(
			undefined as unknown as K,
			undefined as unknown as V,
			this.maxLevel,
		);
	}

	/**
	 * Insert or update a key-value pair. O(log n).
	 * @returns true if the key was newly inserted, false if it was updated.
	 */
	set(key: K, value: V): boolean {
		const update: Array<SkipListNode<K, V>> = new Array(this.maxLevel);
		let current = this.head;

		// Traverse from the highest level down to find insertion point
		for (let i = this.level; i >= 0; i--) {
			let next = current.forward[i];
			while (next !== null && this.compare(next.key, key) < 0) {
				current = next;
				next = current.forward[i];
			}
			update[i] = current;
		}

		// Check if key already exists at level 0
		const candidate = current.forward[0];
		if (candidate !== null && this.compare(candidate.key, key) === 0) {
			// Update existing value
			candidate.value = value;
			return false;
		}

		// Generate random level for new node
		const newLevel = this.randomLevel();

		// If new level exceeds current level, update the head references
		if (newLevel > this.level) {
			for (let i = this.level + 1; i <= newLevel; i++) {
				update[i] = this.head;
			}
			this.level = newLevel;
		}

		// Create and insert the new node
		const newNode = this.createNode(key, value, newLevel);
		for (let i = 0; i <= newLevel; i++) {
			newNode.forward[i] = update[i].forward[i];
			update[i].forward[i] = newNode;
		}

		this._size++;
		return true;
	}

	/**
	 * Find a value by key. O(log n).
	 * @returns the value if found, undefined otherwise.
	 */
	get(key: K): V | undefined {
		let current = this.head;

		for (let i = this.level; i >= 0; i--) {
			let next = current.forward[i];
			while (next !== null && this.compare(next.key, key) < 0) {
				current = next;
				next = current.forward[i];
			}
		}

		const candidate = current.forward[0];
		if (candidate !== null && this.compare(candidate.key, key) === 0) {
			return candidate.value;
		}

		return undefined;
	}

	/**
	 * Delete a key. O(log n).
	 * @returns true if the key was found and deleted, false otherwise.
	 */
	delete(key: K): boolean {
		const update: Array<SkipListNode<K, V>> = new Array(this.maxLevel);
		let current = this.head;

		for (let i = this.level; i >= 0; i--) {
			let next = current.forward[i];
			while (next !== null && this.compare(next.key, key) < 0) {
				current = next;
				next = current.forward[i];
			}
			update[i] = current;
		}

		const candidate = current.forward[0];
		if (candidate === null || this.compare(candidate.key, key) !== 0) {
			return false;
		}

		// Remove the node from all levels
		for (let i = 0; i <= this.level; i++) {
			if (update[i].forward[i] !== candidate) {
				break;
			}
			update[i].forward[i] = candidate.forward[i];
		}

		// Reduce level if top levels are now empty
		while (this.level > 0 && this.head.forward[this.level] === null) {
			this.level--;
		}

		this._size--;
		return true;
	}

	/**
	 * Range query: elements from rank `start` to `stop` (inclusive, 0-based). O(log n + k).
	 * Supports negative indices (e.g., -1 = last element).
	 */
	range(start: number, stop: number): Array<{ key: K; value: V }> {
		const len = this._size;
		if (len === 0) return [];

		// Normalize negative indices
		const s = start < 0 ? Math.max(0, len + start) : start;
		const e = stop < 0 ? len + stop : stop;

		if (s > e || s >= len) return [];

		const effectiveStop = Math.min(e, len - 1);

		// Advance to the start position
		let current: SkipListNode<K, V> | null = this.head.forward[0];
		for (let i = 0; i < s && current !== null; i++) {
			current = current.forward[0];
		}

		// Collect elements from start to stop
		const result: Array<{ key: K; value: V }> = [];
		for (let i = s; i <= effectiveStop && current !== null; i++) {
			result.push({ key: current.key, value: current.value });
			current = current.forward[0];
		}

		return result;
	}

	/**
	 * Number of elements in the skip list.
	 */
	get length(): number {
		return this._size;
	}

	/**
	 * Export all elements in sorted order.
	 */
	toArray(): Array<{ key: K; value: V }> {
		const result: Array<{ key: K; value: V }> = [];
		let current = this.head.forward[0];

		while (current !== null) {
			result.push({ key: current.key, value: current.value });
			current = current.forward[0];
		}

		return result;
	}

	private createNode(key: K, value: V, level: number): SkipListNode<K, V> {
		return {
			key,
			value,
			forward: new Array(level + 1).fill(null),
		};
	}

	private randomLevel(): number {
		let lvl = 0;
		while (Math.random() < this.probability && lvl < this.maxLevel - 1) {
			lvl++;
		}
		return lvl;
	}
}
