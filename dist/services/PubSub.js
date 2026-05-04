import { EventEmitter } from "events";
export class PubSubService {
    emitter = new EventEmitter();
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
}
