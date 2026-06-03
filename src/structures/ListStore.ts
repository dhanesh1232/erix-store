import { listEntryCost } from "../core/byteCost.js";
import type { MemoryAccountant } from "../core/MemoryAccountant.js";
import { DoublyLinkedList } from "./DoublyLinkedList.js";

/**
 * Doubly-linked-list-backed list storage.
 *
 * Each key maps to a {@link DoublyLinkedList} of strings. LPUSH/RPUSH/LPOP/RPOP
 * are O(1); LRANGE/LINDEX walk from the nearer end. The snapshot wire format
 * is still `Record<string, string[]>` so existing on-disk snapshots restore
 * without migration.
 *
 * @requirements P0.2 — replace Array.unshift/Array.shift with a real DLL
 */
export class ListStore {
	private data = new Map<string, DoublyLinkedList<string>>();

	constructor(private readonly accountant?: MemoryAccountant) {}

	lpush(key: string, value: string): number {
		this.accountant?.touch(key);
		this.accountant?.tryCharge(listEntryCost(value));
		const list = this.getOrCreate(key);
		return list.pushHead(value);
	}

	rpush(key: string, value: string): number {
		this.accountant?.touch(key);
		this.accountant?.tryCharge(listEntryCost(value));
		const list = this.getOrCreate(key);
		return list.pushTail(value);
	}

	lpop(key: string): string | null {
		const list = this.data.get(key);
		if (!list) return null;
		this.accountant?.touch(key);
		const value = list.popHead();
		if (value !== null) this.accountant?.credit(listEntryCost(value));
		if (list.length === 0) this.data.delete(key);
		return value;
	}

	rpop(key: string): string | null {
		const list = this.data.get(key);
		if (!list) return null;
		this.accountant?.touch(key);
		const value = list.popTail();
		if (value !== null) this.accountant?.credit(listEntryCost(value));
		if (list.length === 0) this.data.delete(key);
		return value;
	}

	llen(key: string): number {
		return this.data.get(key)?.length ?? 0;
	}

	lindex(key: string, index: number): string | null {
		const list = this.data.get(key);
		if (!list) return null;
		this.accountant?.touch(key);
		return list.index(index);
	}

	lrange(key: string, start: number, stop: number): string[] {
		const list = this.data.get(key);
		if (!list) return [];
		this.accountant?.touch(key);
		return list.range(start, stop);
	}

	lrem(key: string, count: number, value: string): number {
		const list = this.data.get(key);
		if (!list) return 0;
		this.accountant?.touch(key);
		const removed = list.remove((v) => v === value, count);
		if (removed > 0) {
			this.accountant?.credit(listEntryCost(value) * removed);
		}
		if (list.length === 0) this.data.delete(key);
		return removed;
	}

	ltrim(key: string, start: number, stop: number): void {
		const list = this.data.get(key);
		if (!list) return;
		this.accountant?.touch(key);
		// Capture the values that will be dropped so we can credit them.
		const before = list.toArray();
		list.trim(start, stop);
		const after = new Set<string>();
		for (const v of list) after.add(v);
		// LTRIM might keep some duplicates and drop others; the simplest
		// correct accounting walks `before` and credits each entry whose
		// position fell outside the kept range. That's expensive but
		// correct; LTRIM is not a hot-path verb.
		// Implementation: count how many of each value survived in `after`.
		// (Set membership is enough because we credit per *removed* node.)
		const survived = new Map<string, number>();
		for (const v of list) survived.set(v, (survived.get(v) ?? 0) + 1);
		const consumed = new Map<string, number>();
		for (const v of before) {
			const left = survived.get(v) ?? 0;
			const used = consumed.get(v) ?? 0;
			if (used < left) {
				consumed.set(v, used + 1);
			} else {
				this.accountant?.credit(listEntryCost(v));
			}
		}
		// `after` was for a sanity-check rebuild; not needed at runtime.
		void after;
		if (list.length === 0) this.data.delete(key);
	}

	delete(key: string) {
		const list = this.data.get(key);
		if (!list) return;
		for (const v of list) this.accountant?.credit(listEntryCost(v));
		this.data.delete(key);
	}

	has(key: string): boolean {
		return this.data.has(key);
	}

	keys(): IterableIterator<string> {
		return this.data.keys();
	}

	export(): Record<string, string[]> {
		const exported: Record<string, string[]> = {};
		for (const [key, list] of this.data) {
			exported[key] = list.toArray();
		}
		return exported;
	}

	import(data: Record<string, string[]>): void {
		// Credit existing data.
		for (const list of this.data.values()) {
			for (const v of list) this.accountant?.credit(listEntryCost(v));
		}
		this.data = new Map();
		for (const [key, values] of Object.entries(data)) {
			const list = new DoublyLinkedList<string>();
			for (const v of values) {
				list.pushTail(v);
				this.accountant?.forceCharge(listEntryCost(v));
			}
			this.data.set(key, list);
		}
	}

	private getOrCreate(key: string): DoublyLinkedList<string> {
		let list = this.data.get(key);
		if (!list) {
			list = new DoublyLinkedList<string>();
			this.data.set(key, list);
		}
		return list;
	}
}
