/**
 * @file DoublyLinkedList.ts
 * @module Structures/DoublyLinkedList
 *
 * Generic doubly-linked list providing O(1) push/pop at both ends.
 *
 * Why this exists
 * ---------------
 * The previous ListStore used `Array.unshift`/`Array.shift`, which are O(n)
 * because they reindex the entire backing array on every operation. For a
 * 1M-element list, every LPUSH/LPOP shifted ~1M elements. A doubly-linked
 * list replaces those with a constant-time pointer swap.
 *
 * Big-O guarantees
 * ----------------
 *   pushHead / pushTail / popHead / popTail   O(1)
 *   length                                    O(1)
 *   index(i)                                  O(min(i, n - i))   — walks from nearer end
 *   range(start, stop)                        O(min(start, n - start) + (stop - start))
 *   remove(predicate, count)                  O(n)
 *   trim(start, stop)                         O(n)
 *   toArray                                   O(n)
 *
 * Index handling: negative indices count from the tail
 * (-1 = last element).
 *
 * @requirements P0.2 — replace Array.unshift/Array.shift with a real DLL
 */

interface Node<T> {
  value: T;
  prev: Node<T> | null;
  next: Node<T> | null;
}

export class DoublyLinkedList<T> {
  private head: Node<T> | null = null;
  private tail: Node<T> | null = null;
  private _length = 0;

  get length(): number {
    return this._length;
  }

  /** Push to the head (LPUSH). O(1). */
  pushHead(value: T): number {
    const node: Node<T> = { value, prev: null, next: this.head };
    if (this.head) {
      this.head.prev = node;
    } else {
      this.tail = node;
    }
    this.head = node;
    this._length++;
    return this._length;
  }

  /** Push to the tail (RPUSH). O(1). */
  pushTail(value: T): number {
    const node: Node<T> = { value, prev: this.tail, next: null };
    if (this.tail) {
      this.tail.next = node;
    } else {
      this.head = node;
    }
    this.tail = node;
    this._length++;
    return this._length;
  }

  /** Pop from the head (LPOP). O(1). */
  popHead(): T | null {
    if (!this.head) return null;
    const node = this.head;
    this.head = node.next;
    if (this.head) {
      this.head.prev = null;
    } else {
      this.tail = null;
    }
    this._length--;
    return node.value;
  }

  /** Pop from the tail (RPOP). O(1). */
  popTail(): T | null {
    if (!this.tail) return null;
    const node = this.tail;
    this.tail = node.prev;
    if (this.tail) {
      this.tail.next = null;
    } else {
      this.head = null;
    }
    this._length--;
    return node.value;
  }

  /**
   * Get the value at `index`. Negative indices count from the tail.
   * Walks from the nearer end → O(min(i, n - i)).
   * Returns `null` if out of bounds.
   */
  index(index: number): T | null {
    const idx = this.normalize(index);
    if (idx < 0 || idx >= this._length) return null;
    const node = this.nodeAt(idx);
    return node ? node.value : null;
  }

  /**
   * Inclusive range from `start` to `stop`, supporting negative indices.
   * Returns an array. Empty if the range is invalid.
   */
  range(start: number, stop: number): T[] {
    if (this._length === 0) return [];
    const s = Math.max(0, this.normalize(start));
    const e = Math.min(this._length - 1, this.normalize(stop));
    if (s > e) return [];

    const result: T[] = new Array(e - s + 1);
    let node = this.nodeAt(s);
    for (let i = 0; i <= e - s && node; i++) {
      result[i] = node.value;
      node = node.next;
    }
    return result;
  }

  /**
   * Remove elements matching `predicate`.
   *   count > 0 — remove up to `count` matches from the head
   *   count < 0 — remove up to |count| matches from the tail
   *   count = 0 — remove all matches
   * Returns the number of elements removed. O(n).
   */
  remove(predicate: (value: T) => boolean, count: number): number {
    if (this._length === 0) return 0;
    const removeAll = count === 0;
    const fromTail = count < 0;
    const limit = removeAll ? Infinity : Math.abs(count);

    let removed = 0;
    let node = fromTail ? this.tail : this.head;

    while (node && removed < limit) {
      const nextNode = fromTail ? node.prev : node.next;
      if (predicate(node.value)) {
        this.unlink(node);
        removed++;
      }
      node = nextNode;
    }
    return removed;
  }

  /**
   * Trim the list to keep only elements in [start, stop] (inclusive),
   * matching LTRIM semantics. Negative indices count from the tail.
   * O(n) in the worst case, but only walks the truncated regions.
   */
  trim(start: number, stop: number): void {
    if (this._length === 0) return;

    const s = this.normalize(start);
    const e = this.normalize(stop);

    // Empty result → drop everything
    if (s >= this._length || s > e) {
      this.clear();
      return;
    }

    const lo = Math.max(0, s);
    const hi = Math.min(this._length - 1, e);

    // Drop everything before `lo`
    for (let i = 0; i < lo; i++) {
      this.popHead();
    }
    // Drop everything after `hi`. After the head trim, the surviving
    // length is `this._length`, and we want to keep `hi - lo + 1` items.
    const keep = hi - lo + 1;
    while (this._length > keep) {
      this.popTail();
    }
  }

  /** Empty the list. O(1) — drops all references for the GC. */
  clear(): void {
    this.head = null;
    this.tail = null;
    this._length = 0;
  }

  /** Materialise the list into an array. O(n). */
  toArray(): T[] {
    const result: T[] = new Array(this._length);
    let node = this.head;
    let i = 0;
    while (node) {
      result[i++] = node.value;
      node = node.next;
    }
    return result;
  }

  /** Iterator over values from head to tail. */
  *[Symbol.iterator](): Iterator<T> {
    let node = this.head;
    while (node) {
      yield node.value;
      node = node.next;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Normalize negative indices. Returns a non-negative index
   *  that may still be out of bounds (callers must clamp). */
  private normalize(index: number): number {
    return index < 0 ? this._length + index : index;
  }

  /** Walk from the nearer end to find the node at `index`. */
  private nodeAt(index: number): Node<T> | null {
    if (index < 0 || index >= this._length) return null;

    // Walk from tail when index is in the back half
    if (index >= this._length / 2) {
      let node = this.tail;
      for (let i = this._length - 1; i > index && node; i--) {
        node = node.prev;
      }
      return node;
    }
    let node = this.head;
    for (let i = 0; i < index && node; i++) {
      node = node.next;
    }
    return node;
  }

  private unlink(node: Node<T>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
    this._length--;
  }
}
