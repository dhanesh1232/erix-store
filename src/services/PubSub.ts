import { EventEmitter } from "events";

/** JSON-serializable pub/sub message */
export type PubSubMessage = string | number | boolean | null | object;

export class PubSubService {
	private emitter = new EventEmitter();

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
}
