export class ListStore {
	private data = new Map<string, string[]>();

	lpush(key: string, value: string) {
		if (!this.data.has(key)) {
			this.data.set(key, []);
		}
		this.data.get(key)?.unshift(value);
	}

	rpush(key: string, value: string) {
		if (!this.data.has(key)) {
			this.data.set(key, []);
		}
		this.data.get(key)?.push(value);
	}

	lpop(key: string): string | null {
		const list = this.data.get(key);
		if (!list || list.length === 0) return null;
		const value = list.shift()!;
		if (list.length === 0) this.data.delete(key);
		return value;
	}

	rpop(key: string): string | null {
		const list = this.data.get(key);
		if (!list || list.length === 0) return null;
		const value = list.pop()!;
		if (list.length === 0) this.data.delete(key);
		return value;
	}

	lrange(key: string, start: number, stop: number): string[] {
		const list = this.data.get(key);
		if (!list) return [];
		// Handle negative indices like Redis
		const len = list.length;
		const s = start < 0 ? len + start : start;
		const e = stop < 0 ? len + stop : stop;
		return list.slice(s, e + 1);
	}

	delete(key: string) {
		this.data.delete(key);
	}

	export() {
		return Object.fromEntries(this.data);
	}

	import(data: Record<string, string[]>) {
		this.data = new Map(Object.entries(data));
	}
}
