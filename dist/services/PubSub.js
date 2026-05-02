"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PubSubService = void 0;
const events_1 = require("events");
class PubSubService {
    emitter = new events_1.EventEmitter();
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
exports.PubSubService = PubSubService;
