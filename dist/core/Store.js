"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErixStore = void 0;
const TTLManager_js_1 = require("./TTLManager.js");
const StringStore_js_1 = require("../structures/StringStore.js");
const HashStore_js_1 = require("../structures/HashStore.js");
const ListStore_js_1 = require("../structures/ListStore.js");
const SetStore_js_1 = require("../structures/SetStore.js");
const SortedSet_js_1 = require("../structures/SortedSet.js");
class ErixStore {
    strings = new StringStore_js_1.StringStore();
    hashes = new HashStore_js_1.HashStore();
    lists = new ListStore_js_1.ListStore();
    sets = new SetStore_js_1.SetStore();
    sortedSets = new SortedSet_js_1.SortedSetStore();
    ttlManager;
    constructor() {
        this.ttlManager = new TTLManager_js_1.TTLManager((key) => this.handleExpiry(key));
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
exports.ErixStore = ErixStore;
