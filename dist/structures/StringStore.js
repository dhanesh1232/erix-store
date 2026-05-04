export class StringStore {
    data = new Map();
    set(key, value) {
        this.data.set(key, value);
    }
    get(key) {
        return this.data.get(key) || null;
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
