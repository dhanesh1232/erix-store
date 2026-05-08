export class ListStore {
    data = new Map();
    lpush(key, value) {
        if (!this.data.has(key)) {
            this.data.set(key, []);
        }
        this.data.get(key)?.unshift(value);
    }
    rpush(key, value) {
        if (!this.data.has(key)) {
            this.data.set(key, []);
        }
        this.data.get(key)?.push(value);
    }
    lpop(key) {
        const list = this.data.get(key);
        if (!list || list.length === 0)
            return null;
        const value = list.shift();
        if (list.length === 0)
            this.data.delete(key);
        return value;
    }
    rpop(key) {
        const list = this.data.get(key);
        if (!list || list.length === 0)
            return null;
        const value = list.pop();
        if (list.length === 0)
            this.data.delete(key);
        return value;
    }
    lrange(key, start, stop) {
        const list = this.data.get(key);
        if (!list)
            return [];
        // Handle negative indices like Redis
        const len = list.length;
        const s = start < 0 ? len + start : start;
        const e = stop < 0 ? len + stop : stop;
        return list.slice(s, e + 1);
    }
    delete(key) {
        this.data.delete(key);
    }
    export() {
        return Object.fromEntries(this.data);
    }
    import(data) {
        this.data = new Map(Object.entries(data));
    }
}
