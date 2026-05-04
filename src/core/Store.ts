import { HashStore } from "../structures/HashStore.js";
import { ListStore } from "../structures/ListStore.js";
import { SetStore } from "../structures/SetStore.js";
import { SortedSetStore } from "../structures/SortedSet.js";
import { StringStore } from "../structures/StringStore.js";
import { TTLManager } from "./TTLManager.js";

export class ErixStore {
	public strings = new StringStore();
	public hashes = new HashStore();
	public lists = new ListStore();
	public sets = new SetStore();
	public sortedSets = new SortedSetStore();
	public ttlManager: TTLManager;

	constructor() {
		this.ttlManager = new TTLManager((key) => this.handleExpiry(key));
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

	importAll(data: any) {
		if (data.strings) this.strings.import(data.strings);
		if (data.hashes) this.hashes.import(data.hashes);
		if (data.lists) this.lists.import(data.lists);
		if (data.sets) this.sets.import(data.sets);
		if (data.sortedSets) this.sortedSets.import(data.sortedSets);
		if (data.expirations) this.ttlManager.importExpirations(data.expirations);
	}
}
