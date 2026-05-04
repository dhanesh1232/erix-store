export class JobQueueService {
    queues = new Map();
    push(queueName, job) {
        if (!this.queues.has(queueName)) {
            this.queues.set(queueName, []);
        }
        this.queues.get(queueName).push(job);
        return true;
    }
    pop(queueName) {
        const queue = this.queues.get(queueName);
        if (!queue || queue.length === 0)
            return null;
        return queue.shift();
    }
    size(queueName) {
        return this.queues.get(queueName)?.length || 0;
    }
    // Basic retry logic - just push it back to the end
    retry(queueName, job) {
        return this.push(queueName, job);
    }
    export() {
        return Object.fromEntries(this.queues);
    }
    import(data) {
        this.queues = new Map(Object.entries(data));
    }
}
