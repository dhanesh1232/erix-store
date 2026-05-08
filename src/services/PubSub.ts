import { EventEmitter } from "events";

/** JSON-serializable pub/sub message */
export type PubSubMessage = string | number | boolean | null | object;

export class PubSubService {
	private emitter = new EventEmitter();

	constructor() {
		// Suppress Node.js "MaxListenersExceededWarning" — each SSE connection
		// adds a listener, and there is no natural hard limit for a pub/sub system.
		this.emitter.setMaxListeners(0);
	}

	publish(channel: string, message: PubSubMessage): boolean {
		this.emitter.emit(channel, message);
		return true;
	}

	subscribe(channel: string, callback: (message: PubSubMessage) => void): void {
		this.emitter.on(channel, callback);
	}

	unsubscribe(
		channel: string,
		callback: (message: PubSubMessage) => void,
	): void {
		this.emitter.off(channel, callback);
	}

	/** Count active subscribers for a channel */
	subscriberCount(channel: string): number {
		return this.emitter.listenerCount(channel);
	}
}
