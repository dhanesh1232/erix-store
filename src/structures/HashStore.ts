import { hashFieldCost } from "../core/byteCost.js";
import type { MemoryAccountant } from "../core/MemoryAccountant.js";

export class HashStore {
	private data = new Map<string, Map<string, string>>();

	constructor(private readonly accountant?: MemoryAccountant) {}

	hset(key: string, field: string, value: string) {
		this.accountant?.touch(key);
		let hash = this.data.get(key);
		if (!hash) {
			hash = new Map();
			this.data.set(key, hash);
		}
		const previous = hash.get(field);
		const newCost = hashFieldCost(field, value);
		const oldCost = previous !== undefined ? hashFieldCost(field, previous) : 0;
		const delta = newCost - oldCost;
		if (delta > 0) this.accountant?.tryCharge(delta);
		else if (delta < 0) this.accountant?.credit(-delta);
		hash.set(field, value);
	}

	hget(key: string, field: string): string | null {
		const hash = this.data.get(key);
		if (!hash) return null;
		this.accountant?.touch(key);
		return hash.get(field) ?? null;
	}

	hgetall(key: string): Record<string, string> | null {
		const hash = this.data.get(key);
		if (!hash) return null;
		this.accountant?.touch(key);
		return Object.fromEntries(hash);
	}

	hdel(key: string, field: string) {
		const hash = this.data.get(key);
		if (!hash) return;
		const previous = hash.get(field);
		if (previous === undefined) return;
		this.accountant?.credit(hashFieldCost(field, previous));
		hash.delete(field);
		if (hash.size === 0) {
			this.data.delete(key);
		}
	}

	hexists(key: string, field: string): boolean {
		const hash = this.data.get(key);
		return hash ? hash.has(field) : false;
	}

	hkeys(key: string): string[] {
		const hash = this.data.get(key);
		return hash ? Array.from(hash.keys()) : [];
	}

	hvals(key: string): string[] {
		const hash = this.data.get(key);
		return hash ? Array.from(hash.values()) : [];
	}

	hlen(key: string): number {
		return this.data.get(key)?.size ?? 0;
	}

	hempty(key: string): boolean {
		const hash = this.data.get(key);
		return !hash || hash.size === 0;
	}

	delete(key: string) {
		const hash = this.data.get(key);
		if (!hash) return;
		// Credit every field's cost.
		for (const [f, v] of hash) {
			this.accountant?.credit(hashFieldCost(f, v));
		}
		this.data.delete(key);
	}

	keys(): IterableIterator<string> {
		return this.data.keys();
	}

	export() {
		const exported: Record<string, Record<string, string>> = {};
		for (const [key, hash] of this.data.entries()) {
			exported[key] = Object.fromEntries(hash);
		}
		return exported;
	}

	import(data: Record<string, Record<string, string>>) {
		// Credit any existing data first.
		for (const hash of this.data.values()) {
			for (const [f, v] of hash) this.accountant?.credit(hashFieldCost(f, v));
		}
		this.data = new Map();
		for (const [key, hash] of Object.entries(data)) {
			const m = new Map(Object.entries(hash));
			this.data.set(key, m);
			for (const [f, v] of m) {
				this.accountant?.forceCharge(hashFieldCost(f, v));
			}
		}
	}
}
