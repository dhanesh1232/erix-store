import { EventEmitter } from "events";
export class PubSubService {
    emitter = new EventEmitter();
    constructor() {
        // Suppress Node.js "MaxListenersExceededWarning" — each SSE connection
        // adds a listener, and there is no natural hard limit for a pub/sub system.
        this.emitter.setMaxListeners(0);
    }
    publish(channel, message) {
        this.emitter.emit(channel, message);
        return true;
    }
    subscribe(channel, callback) {
        this.emitter.on(channel, callback);
    }
    unsubscribe(channel, callback) {
        this.emitter.off(channel, callback);
    }
    /** Count active subscribers for a channel */
    subscriberCount(channel) {
        return this.emitter.listenerCount(channel);
    }
}
