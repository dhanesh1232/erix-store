import { HashStore } from "../structures/HashStore.js";
import { ListStore } from "../structures/ListStore.js";
import { SetStore } from "../structures/SetStore.js";
import { SortedSetStore } from "../structures/SortedSet.js";
import { StringStore } from "../structures/StringStore.js";
import { HeapTTLManager } from "./HeapTTLManager.js";

export class ErixStore {
	public strings = new StringStore();
	public hashes = new HashStore();
	public lists = new ListStore();
	public sets = new SetStore();
	public sortedSets = new SortedSetStore();
	public ttlManager: HeapTTLManager;

	constructor() {
		this.ttlManager = new HeapTTLManager((key) => this.handleExpiry(key));
	}

	private handleExpiry(key: string) {
		// Determine which store the key belongs to and delete it
		// In this simple implementation, we try all (or we could prefix keys)
		this.strings.delete(key);
		this.hashes.delete(key);
		this.lists.delete(key);
		this.sets.delete(key);
		this.sortedSets.delete(key);
	}

	// Helper to check if key is expired before operation
	isExpired(key: string): boolean {
		return this.ttlManager.isExpired(key);
	}

	exportAll() {
		return {
			strings: this.strings.export(),
			hashes: this.hashes.export(),
			lists: this.lists.export(),
			sets: this.sets.export(),
			sortedSets: this.sortedSets.export(),
			expirations: this.ttlManager.exportExpirations(),
		};
	}

	importAll(data: unknown) {
		if (!data || typeof data !== "object") return;
		const d = data as Record<string, unknown>;
		if (d.strings)
			this.strings.import(
				d.strings as Parameters<typeof this.strings.import>[0],
			);
		if (d.hashes)
			this.hashes.import(d.hashes as Parameters<typeof this.hashes.import>[0]);
		if (d.lists)
			this.lists.import(d.lists as Parameters<typeof this.lists.import>[0]);
		if (d.sets)
			this.sets.import(d.sets as Parameters<typeof this.sets.import>[0]);
		if (d.sortedSets)
			this.sortedSets.import(
				d.sortedSets as Parameters<typeof this.sortedSets.import>[0],
			);
		if (d.expirations)
			this.ttlManager.importExpirations(
				d.expirations as Parameters<
					typeof this.ttlManager.importExpirations
				>[0],
			);
	}
}
