import { HashStore } from "../structures/HashStore.js";
import { ListStore } from "../structures/ListStore.js";
import { SetStore } from "../structures/SetStore.js";
import { SortedSetStore } from "../structures/SortedSet.js";
import { StringStore } from "../structures/StringStore.js";
import { TTLManager } from "./TTLManager.js";
export class ErixStore {
    strings = new StringStore();
    hashes = new HashStore();
    lists = new ListStore();
    sets = new SetStore();
    sortedSets = new SortedSetStore();
    ttlManager;
    constructor() {
        this.ttlManager = new TTLManager((key) => this.handleExpiry(key));
    }
    handleExpiry(key) {
        // Determine which store the key belongs to and delete it
        // In this simple implementation, we try all (or we could prefix keys)
        this.strings.delete(key);
        this.hashes.delete(key);
        this.lists.delete(key);
        this.sets.delete(key);
        this.sortedSets.delete(key);
    }
    // Helper to check if key is expired before operation
    isExpired(key) {
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
    importAll(data) {
        if (!data || typeof data !== "object")
            return;
        const d = data;
        if (d.strings)
            this.strings.import(d.strings);
        if (d.hashes)
            this.hashes.import(d.hashes);
        if (d.lists)
            this.lists.import(d.lists);
        if (d.sets)
            this.sets.import(d.sets);
        if (d.sortedSets)
            this.sortedSets.import(d.sortedSets);
        if (d.expirations)
            this.ttlManager.importExpirations(d.expirations);
    }
}
