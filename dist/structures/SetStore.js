export class SetStore {
    data = new Map();
    sadd(key, value) {
        if (!this.data.has(key)) {
            this.data.set(key, new Set());
        }
        // biome-ignore lint/style/noNonNullAssertion: key is guaranteed by the has() guard above
        const set = this.data.get(key);
        const sizeBefore = set.size;
        set.add(value);
        return set.size - sizeBefore;
    }
    smembers(key) {
        const set = this.data.get(key);
        return set ? Array.from(set) : [];
    }
    sismember(key, value) {
        const set = this.data.get(key);
        return set ? set.has(value) : false;
    }
    srem(key, value) {
        const set = this.data.get(key);
        if (!set)
            return 0;
        const deleted = set.delete(value) ? 1 : 0;
        if (set.size === 0)
            this.data.delete(key);
        return deleted;
    }
    delete(key) {
        this.data.delete(key);
    }
    export() {
        const exported = {};
        for (const [key, set] of this.data.entries()) {
            exported[key] = Array.from(set);
        }
        return exported;
    }
    import(data) {
        this.data = new Map();
        for (const [key, members] of Object.entries(data)) {
            this.data.set(key, new Set(members));
        }
    }
}
