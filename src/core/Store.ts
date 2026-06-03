import { HashStore } from "../structures/HashStore.js";
import { ListStore } from "../structures/ListStore.js";
import { SetStore } from "../structures/SetStore.js";
import { SortedSetStore } from "../structures/SortedSet.js";
import { StringStore } from "../structures/StringStore.js";
import { HeapTTLManager } from "./HeapTTLManager.js";
import {
	type EvictionPolicy,
	MemoryAccountant,
	type MemoryAccountantOptions,
} from "./MemoryAccountant.js";
import { TypeRegistry } from "./TypeRegistry.js";

export interface ErixStoreOptions {
	/** Memory cap configuration. Omit (or pass <= 0) to disable enforcement. */
	memory?: MemoryAccountantOptions;
}

export class ErixStore {
	public types = new TypeRegistry();
	/**
	 * Memory accountant — owns LRU index + cap enforcement. Wired into the
	 * sub-stores below so every mutation charges/credits and every read
	 * touches the LRU index. Disabled by default (maxBytes <= 0).
	 */
	public accountant: MemoryAccountant;

	public strings: StringStore;
	public hashes: HashStore;
	public lists: ListStore;
	public sets: SetStore;
	public sortedSets: SortedSetStore;
	public ttlManager: HeapTTLManager;

	constructor(options: ErixStoreOptions = {}) {
		this.accountant = new MemoryAccountant(options.memory);

		this.strings = new StringStore(this.accountant);
		this.hashes = new HashStore(this.accountant);
		this.lists = new ListStore(this.accountant);
		this.sets = new SetStore(this.accountant);
		this.sortedSets = new SortedSetStore(this.accountant);

		this.ttlManager = new HeapTTLManager((key) => this.handleExpiry(key));

		// Bind the accountant's eviction callbacks. Eviction is a delete
		// routed through the same path DEL takes — keeping policy and DEL
		// in sync without any duplication.
		this.accountant.bind(
			(key) => {
				this.deleteKey(key);
			},
			(key) => this.ttlManager.getTTL(key) >= 0,
		);
	}

	/**
	 * Called by the TTL sweep when a key expires.
	 * Uses the type registry to delete from only the owning store.
	 */
	private handleExpiry(key: string) {
		const type = this.types.getType(key);
		if (!type) return;

		switch (type) {
			case "string":
				this.strings.delete(key);
				break;
			case "hash":
				this.hashes.delete(key);
				break;
			case "list":
				this.lists.delete(key);
				break;
			case "set":
				this.sets.delete(key);
				break;
			case "zset":
				this.sortedSets.delete(key);
				break;
		}
		this.types.unregister(key);
		this.accountant.forget(key);
	}

	// Helper to check if key is expired before operation
	isExpired(key: string): boolean {
		return this.ttlManager.isExpired(key);
	}

	/**
	 * Lazy-expire-then-register. Use this from every write path.
	 */
	reserveKey(key: string, type: Parameters<TypeRegistry["register"]>[1]): void {
		this.ttlManager.isExpired(key);
		this.types.register(key, type);
		this.accountant.touch(key);
	}

	/**
	 * Delete a key from the store regardless of its underlying type.
	 * @returns true if the key existed, false otherwise.
	 */
	deleteKey(key: string): boolean {
		const type = this.types.getType(key);
		if (!type) {
			this.ttlManager.delete(key);
			this.accountant.forget(key);
			return false;
		}

		switch (type) {
			case "string":
				this.strings.delete(key);
				break;
			case "hash":
				this.hashes.delete(key);
				break;
			case "list":
				this.lists.delete(key);
				break;
			case "set":
				this.sets.delete(key);
				break;
			case "zset":
				this.sortedSets.delete(key);
				break;
		}
		this.types.unregister(key);
		this.ttlManager.delete(key);
		this.accountant.forget(key);
		return true;
	}

	flushTenant(tenantPrefix: string): number {
		const prefix = `${tenantPrefix}:`;
		const matches: string[] = [];
		for (const k of this.types.keys()) {
			if (k.startsWith(prefix)) matches.push(k);
		}
		for (const k of matches) this.deleteKey(k);
		return matches.length;
	}

	/** Read-only access to the eviction policy (for INFO / CONFIG GET later). */
	get evictionPolicy(): EvictionPolicy {
		return this.accountant.policy;
	}

	exportAll() {
		return {
			strings: this.strings.export(),
			hashes: this.hashes.export(),
			lists: this.lists.export(),
			sets: this.sets.export(),
			sortedSets: this.sortedSets.export(),
			expirations: this.ttlManager.exportExpirations(),
			types: this.types.export(),
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

		if (d.types && typeof d.types === "object") {
			this.types.import(d.types as Parameters<typeof this.types.import>[0]);
		} else {
			const collisions = this.types.rebuildFromStores({
				string: this.strings,
				hash: this.hashes,
				list: this.lists,
				set: this.sets,
				zset: this.sortedSets,
			});
			if (collisions.length > 0) {
				console.warn(
					`[ErixStore] Resolved ${collisions.length} multi-type collisions during snapshot import`,
				);
			}
		}

		// Rebuild the LRU index from the imported keys. The accountant's
		// `usedBytes` was already populated by each sub-store's `import`
		// method via `forceCharge`, so we deliberately do NOT call
		// `accountant.reset()` here — that would wipe the very bytes we
		// just charged.
		for (const k of this.types.keys()) {
			this.accountant.touch(k);
		}
	}
}
