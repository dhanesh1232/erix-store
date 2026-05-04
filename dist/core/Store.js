import { TTLManager } from "./TTLManager.js";
import { StringStore } from "../structures/StringStore.js";
import { HashStore } from "../structures/HashStore.js";
import { ListStore } from "../structures/ListStore.js";
import { SetStore } from "../structures/SetStore.js";
import { SortedSetStore } from "../structures/SortedSet.js";
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
        if (data.strings)
            this.strings.import(data.strings);
        if (data.hashes)
            this.hashes.import(data.hashes);
        if (data.lists)
            this.lists.import(data.lists);
        if (data.sets)
            this.sets.import(data.sets);
        if (data.sortedSets)
            this.sortedSets.import(data.sortedSets);
        if (data.expirations)
            this.ttlManager.importExpirations(data.expirations);
    }
}
