interface DLLNode<K> {
	key: K;
	prev: DLLNode<K> | null;
	next: DLLNode<K> | null;
}

/**
 * LRU tracking list using a doubly-linked list backed by a HashMap.
 * Provides O(1) touch, add, evict, and remove operations.
 *
 * Head = most recently used, Tail = least recently used.
 */
export class LRUList<K> {
	private head: DLLNode<K> | null = null;
	private tail: DLLNode<K> | null = null;
	private nodes: Map<K, DLLNode<K>> = new Map();

	/**
	 * Move an existing key to the head (most recently used). O(1).
	 * No-op if the key does not exist in the list.
	 */
	touch(key: K): void {
		const node = this.nodes.get(key);
		if (!node) return;

		// Already at head — nothing to do
		if (node === this.head) return;

		// Detach node from current position
		this.detach(node);

		// Move to head
		this.prepend(node);
	}

	/**
	 * Add a new key at the head (most recently used). O(1).
	 * If the key already exists, it is moved to the head (same as touch).
	 */
	add(key: K): void {
		const existing = this.nodes.get(key);
		if (existing) {
			this.touch(key);
			return;
		}

		const node: DLLNode<K> = { key, prev: null, next: null };
		this.nodes.set(key, node);
		this.prepend(node);
	}

	/**
	 * Remove and return the tail key (least recently used). O(1).
	 * Returns undefined if the list is empty.
	 */
	evict(): K | undefined {
		if (!this.tail) return undefined;

		const evicted = this.tail;
		this.detach(evicted);
		this.nodes.delete(evicted.key);
		return evicted.key;
	}

	/**
	 * Remove a specific key from the list. O(1).
	 * No-op if the key does not exist.
	 */
	remove(key: K): void {
		const node = this.nodes.get(key);
		if (!node) return;

		this.detach(node);
		this.nodes.delete(key);
	}

	/**
	 * Number of keys tracked in the LRU list.
	 */
	get size(): number {
		return this.nodes.size;
	}

	/**
	 * Detach a node from its current position in the list.
	 */
	private detach(node: DLLNode<K>): void {
		const { prev, next } = node;

		if (prev) {
			prev.next = next;
		} else {
			// Node was head
			this.head = next;
		}

		if (next) {
			next.prev = prev;
		} else {
			// Node was tail
			this.tail = prev;
		}

		node.prev = null;
		node.next = null;
	}

	/**
	 * Insert a node at the head of the list.
	 */
	private prepend(node: DLLNode<K>): void {
		node.next = this.head;
		node.prev = null;

		if (this.head) {
			this.head.prev = node;
		}

		this.head = node;

		if (!this.tail) {
			this.tail = node;
		}
	}
}
