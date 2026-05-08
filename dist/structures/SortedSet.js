export class SortedSetStore {
    data = new Map();
    zadd(key, score, value) {
        if (!this.data.has(key)) {
            this.data.set(key, []);
        }
        const members = this.data.get(key);
        const existingIndex = members.findIndex((m) => m.value === value);
        if (existingIndex !== -1) {
            members[existingIndex].score = score;
        }
        else {
            members.push({ value, score });
        }
        // Keep it sorted by score
        members.sort((a, b) => a.score - b.score);
        return existingIndex === -1 ? 1 : 0;
    }
    zrange(key, start, stop) {
        const members = this.data.get(key);
        if (!members)
            return [];
        const len = members.length;
        const s = start < 0 ? len + start : start;
        const e = stop < 0 ? len + stop : stop;
        return members.slice(s, e + 1).map((m) => m.value);
    }
    zscore(key, value) {
        const members = this.data.get(key);
        if (!members)
            return null;
        const member = members.find((m) => m.value === value);
        return member ? member.score : null;
    }
    zrem(key, value) {
        const members = this.data.get(key);
        if (!members)
            return 0;
        const index = members.findIndex((m) => m.value === value);
        if (index === -1)
            return 0;
        members.splice(index, 1);
        if (members.length === 0)
            this.data.delete(key);
        return 1;
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
