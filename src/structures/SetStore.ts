import { setMemberCost } from "../core/byteCost.js";
import type { MemoryAccountant } from "../core/MemoryAccountant.js";

export class SetStore {
	private data = new Map<string, Set<string>>();

	constructor(private readonly accountant?: MemoryAccountant) {}

	sadd(key: string, value: string): number {
		this.accountant?.touch(key);
		let set = this.data.get(key);
		if (!set) {
			set = new Set();
			this.data.set(key, set);
		}
		if (set.has(value)) return 0;
		this.accountant?.tryCharge(setMemberCost(value));
		set.add(value);
		return 1;
	}

	smembers(key: string): string[] {
		const set = this.data.get(key);
		if (!set) return [];
		this.accountant?.touch(key);
		return Array.from(set);
	}

	sismember(key: string, value: string): boolean {
		const set = this.data.get(key);
		if (!set) return false;
		this.accountant?.touch(key);
		return set.has(value);
	}

	srem(key: string, value: string): number {
		const set = this.data.get(key);
		if (!set) return 0;
		if (!set.has(value)) return 0;
		this.accountant?.credit(setMemberCost(value));
		set.delete(value);
		if (set.size === 0) this.data.delete(key);
		return 1;
	}

	scard(key: string): number {
		return this.data.get(key)?.size ?? 0;
	}

	getSet(key: string): Set<string> | undefined {
		return this.data.get(key);
	}

	delete(key: string) {
		const set = this.data.get(key);
		if (!set) return;
		for (const v of set) this.accountant?.credit(setMemberCost(v));
		this.data.delete(key);
	}

	keys(): IterableIterator<string> {
		return this.data.keys();
	}

	export() {
		const exported: Record<string, string[]> = {};
		for (const [key, set] of this.data.entries()) {
			exported[key] = Array.from(set);
		}
		return exported;
	}

	import(data: Record<string, string[]>) {
		for (const set of this.data.values()) {
			for (const v of set) this.accountant?.credit(setMemberCost(v));
		}
		this.data = new Map();
		for (const [key, members] of Object.entries(data)) {
			const set = new Set(members);
			this.data.set(key, set);
			for (const v of set) this.accountant?.forceCharge(setMemberCost(v));
		}
	}
}
