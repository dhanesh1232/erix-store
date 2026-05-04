export class SetStore {
	private data = new Map<string, Set<string>>();

	sadd(key: string, value: string): number {
		if (!this.data.has(key)) {
			this.data.set(key, new Set());
		}
		const set = this.data.get(key)!;
		const sizeBefore = set.size;
		set.add(value);
		return set.size - sizeBefore;
	}

	smembers(key: string): string[] {
		const set = this.data.get(key);
		return set ? Array.from(set) : [];
	}

	sismember(key: string, value: string): boolean {
		const set = this.data.get(key);
		return set ? set.has(value) : false;
	}

	srem(key: string, value: string): number {
		const set = this.data.get(key);
		if (!set) return 0;
		const deleted = set.delete(value) ? 1 : 0;
		if (set.size === 0) this.data.delete(key);
		return deleted;
	}

	delete(key: string) {
		this.data.delete(key);
	}

	export() {
		const exported: Record<string, string[]> = {};
		for (const [key, set] of this.data.entries()) {
			exported[key] = Array.from(set);
		}
		return exported;
	}

	import(data: Record<string, string[]>) {
		this.data = new Map();
		for (const [key, members] of Object.entries(data)) {
			this.data.set(key, new Set(members));
		}
	}
}
