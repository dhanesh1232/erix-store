import { EventEmitter } from "events";

export class PubSubService {
	private emitter = new EventEmitter();

	publish(channel: string, message: any) {
		this.emitter.emit(channel, message);
		return true;
	}

	subscribe(channel: string, callback: (message: any) => void) {
		this.emitter.on(channel, callback);
	}

	unsubscribe(channel: string, callback: (message: any) => void) {
		this.emitter.off(channel, callback);
	}
}
