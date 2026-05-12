import { SkipList } from "./SkipList.js";

interface SortedSetMember {
	value: string;
	score: number;
}

/**
 * Composite key for the skip list: orders by score ascending, then by value lexicographically.
 */
interface CompositeKey {
	score: number;
	value: string;
}

function compareCompositeKeys(a: CompositeKey, b: CompositeKey): number {
	if (a.score !== b.score) return a.score - b.score;
	if (a.value < b.value) return -1;
	if (a.value > b.value) return 1;
	return 0;
}

/**
 * Internal structure holding a SkipList and a value-to-score lookup map for a single sorted set key.
 */
interface SortedSetEntry {
	skipList: SkipList<CompositeKey, string>;
	scoreMap: Map<string, number>;
}

/**
 * SortedSetStore backed by SkipList for O(log n) zadd, zrem, and O(log n + k) zrange.
 * Maintains the same public API as the previous array-based implementation.
 */
export class SortedSetStore {
	private data = new Map<string, SortedSetEntry>();

	private getOrCreate(key: string): SortedSetEntry {
		let entry = this.data.get(key);
		if (!entry) {
			entry = {
				skipList: new SkipList<CompositeKey, string>(compareCompositeKeys),
				scoreMap: new Map<string, number>(),
			};
			this.data.set(key, entry);
		}
		return entry;
	}

	zadd(key: string, score: number, value: string): number {
		const entry = this.getOrCreate(key);
		const existingScore = entry.scoreMap.get(value);

		if (existingScore !== undefined) {
			// Value already exists — remove old entry and insert with new score
			entry.skipList.delete({ score: existingScore, value });
			entry.skipList.set({ score, value }, value);
			entry.scoreMap.set(value, score);
			return 0;
		}

		// New value
		entry.skipList.set({ score, value }, value);
		entry.scoreMap.set(value, score);
		return 1;
	}

	zrange(key: string, start: number, stop: number): string[] {
		const entry = this.data.get(key);
		if (!entry) return [];

		const results = entry.skipList.range(start, stop);
		return results.map((r) => r.value);
	}

	zscore(key: string, value: string): number | null {
		const entry = this.data.get(key);
		if (!entry) return null;
		const score = entry.scoreMap.get(value);
		return score !== undefined ? score : null;
	}

	zrem(key: string, value: string): number {
		const entry = this.data.get(key);
		if (!entry) return 0;

		const score = entry.scoreMap.get(value);
		if (score === undefined) return 0;

		entry.skipList.delete({ score, value });
		entry.scoreMap.delete(value);

		// Clean up empty sets
		if (entry.scoreMap.size === 0) {
			this.data.delete(key);
		}

		return 1;
	}

	delete(key: string) {
		this.data.delete(key);
	}

	export(): Record<string, SortedSetMember[]> {
		const result: Record<string, SortedSetMember[]> = {};
		for (const [key, entry] of this.data) {
			const members: SortedSetMember[] = entry.skipList
				.toArray()
				.map((item) => ({ value: item.key.value, score: item.key.score }));
			result[key] = members;
		}
		return result;
	}

	import(data: Record<string, SortedSetMember[]>) {
		this.data.clear();
		for (const [key, members] of Object.entries(data)) {
			const entry = this.getOrCreate(key);
			for (const member of members) {
				entry.skipList.set(
					{ score: member.score, value: member.value },
					member.value,
				);
				entry.scoreMap.set(member.value, member.score);
			}
		}
	}
}
