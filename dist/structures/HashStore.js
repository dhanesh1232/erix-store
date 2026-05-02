"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HashStore = void 0;
class HashStore {
    data = new Map();
    hset(key, field, value) {
        if (!this.data.has(key)) {
            this.data.set(key, new Map());
        }
        this.data.get(key).set(field, value);
    }
    hget(key, field) {
        const hash = this.data.get(key);
        return hash ? hash.get(field) || null : null;
    }
    hgetall(key) {
        const hash = this.data.get(key);
        return hash ? Object.fromEntries(hash) : null;
    }
    hdel(key, field) {
        const hash = this.data.get(key);
        if (hash) {
            hash.delete(field);
            if (hash.size === 0) {
                this.data.delete(key);
            }
        }
    }
    delete(key) {
        this.data.delete(key);
    }
    export() {
        const exported = {};
        for (const [key, hash] of this.data.entries()) {
            exported[key] = Object.fromEntries(hash);
        }
        return exported;
    }
    import(data) {
        this.data = new Map();
        for (const [key, hash] of Object.entries(data)) {
            this.data.set(key, new Map(Object.entries(hash)));
        }
    }
}
exports.HashStore = HashStore;
