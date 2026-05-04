export class JobQueueService {
	private queues = new Map<string, any[]>();

	push(queueName: string, job: any) {
		if (!this.queues.has(queueName)) {
			this.queues.set(queueName, []);
		}
		this.queues.get(queueName)?.push(job);
		return true;
	}

	pop(queueName: string): any | null {
		const queue = this.queues.get(queueName);
		if (!queue || queue.length === 0) return null;
		return queue.shift();
	}

	size(queueName: string): number {
		return this.queues.get(queueName)?.length || 0;
	}

	// Basic retry logic - just push it back to the end
	retry(queueName: string, job: any) {
		return this.push(queueName, job);
	}

	export() {
		return Object.fromEntries(this.queues);
	}

	import(data: Record<string, any[]>) {
		this.queues = new Map(Object.entries(data));
	}
}
