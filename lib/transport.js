'use strict';

const EventEmitter = require('events');
const mqtt = require('mqtt');
const { buildMessage } = require('./protocol');

const DEFAULT_TIMEOUT = 10000;

class RequestError extends Error {
    constructor(message, response) {
        super(message);
        this.name = 'MerossRequestError';
        this.response = response;
    }
}

function checkResponse(msg, namespace) {
    if (!msg || !msg.header) {
        throw new RequestError('Invalid response from device');
    }
    if (msg.header.method === 'ERROR') {
        const err = msg.payload && msg.payload.error;
        const detail = err ? (err.detail || err.code || JSON.stringify(err)) : 'unknown';
        throw new RequestError('Device returned error for ' + namespace + ': ' + detail, msg);
    }
    return msg;
}

/**
 * Talks to Meross devices through an MQTT broker (Meross cloud or a local broker).
 *
 * Requests are published to /appliance/<uuid>/subscribe. The device answers on the
 * topic given in header.from, pushes (state changes) arrive on /appliance/<uuid>/publish
 * (local broker) or /app/<userId>/subscribe (cloud).
 *
 * Events: 'connect', 'close', 'error', 'push' (uuid, namespace, payload, message)
 */
class MqttTransport extends EventEmitter {
    constructor(options) {
        super();
        this.url = options.url;
        this.key = options.key || '';
        this.responseTopic = options.responseTopic;
        this.subscribeTopics = options.subscribeTopics || [this.responseTopic];
        this.mqttOptions = options.mqttOptions || {};
        this.timeout = options.timeout || DEFAULT_TIMEOUT;
        this.pending = new Map();
        this.client = null;
        this.connected = false;
    }

    connect() {
        if (this.client) {
            return;
        }
        this.client = mqtt.connect(this.url, Object.assign({
            reconnectPeriod: 10000,
            connectTimeout: 15000,
            clean: true
        }, this.mqttOptions));

        this.client.on('connect', () => {
            this.connected = true;
            this.client.subscribe(this.subscribeTopics, { qos: 1 }, (err) => {
                if (err) {
                    this.emit('error', err);
                    return;
                }
                this.emit('connect');
            });
        });
        this.client.on('close', () => {
            if (this.connected) {
                this.connected = false;
                this.emit('close');
            }
        });
        this.client.on('error', (err) => this.emit('error', err));
        this.client.on('message', (topic, buffer) => this._onMessage(topic, buffer));
    }

    _onMessage(topic, buffer) {
        let msg;
        try {
            msg = JSON.parse(buffer.toString());
        } catch (e) {
            return;
        }
        if (!msg || !msg.header) {
            return;
        }
        const header = msg.header;
        const pending = this.pending.get(header.messageId);
        if (pending && header.method !== 'PUSH' && header.method !== pending.method) {
            this.pending.delete(header.messageId);
            clearTimeout(pending.timer);
            try {
                pending.resolve(checkResponse(msg, pending.namespace));
            } catch (err) {
                pending.reject(err);
            }
            return;
        }
        if (header.method === 'PUSH') {
            const uuid = extractUuid(topic, header);
            this.emit('push', uuid, header.namespace, msg.payload, msg);
        }
    }

    request(device, method, namespace, payload, timeout) {
        if (!device || !device.uuid) {
            return Promise.reject(new RequestError('Device UUID is required for MQTT'));
        }
        if (!this.client || !this.connected) {
            return Promise.reject(new RequestError('Not connected to MQTT broker'));
        }
        const msg = buildMessage({
            method: method,
            namespace: namespace,
            payload: payload,
            key: this.key,
            from: this.responseTopic,
            uuid: device.uuid
        });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(msg.header.messageId);
                reject(new RequestError('Timeout waiting for ' + namespace + ' response from ' + device.uuid));
            }, timeout || this.timeout);
            this.pending.set(msg.header.messageId, { resolve, reject, timer, method, namespace });
            this.client.publish('/appliance/' + device.uuid + '/subscribe', JSON.stringify(msg), { qos: 1 }, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(msg.header.messageId);
                    reject(err);
                }
            });
        });
    }

    close() {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new RequestError('Connection closed'));
        }
        this.pending.clear();
        if (!this.client) {
            return Promise.resolve();
        }
        const client = this.client;
        this.client = null;
        this.connected = false;
        return new Promise((resolve) => client.end(true, {}, () => resolve()));
    }
}

function extractUuid(topic, header) {
    const re = /^\/appliance\/([^/]+)\/publish$/;
    let m = re.exec(topic);
    if (m) {
        return m[1];
    }
    m = re.exec(header.from || '');
    if (m) {
        return m[1];
    }
    return header.uuid;
}

/**
 * Talks to Meross devices directly via their local HTTP API (POST http://<ip>/config).
 */
class HttpTransport extends EventEmitter {
    constructor(options) {
        super();
        this.key = options.key || '';
        this.timeout = options.timeout || DEFAULT_TIMEOUT;
        this.connected = true;
    }

    connect() {
        this.emit('connect');
    }

    async request(device, method, namespace, payload, timeout) {
        if (!device || !device.host) {
            throw new RequestError('Device IP/host is required for local HTTP');
        }
        const base = /^https?:\/\//.test(device.host) ? device.host : 'http://' + device.host;
        const url = base.replace(/\/+$/, '') + '/config';
        const msg = buildMessage({
            method: method,
            namespace: namespace,
            payload: payload,
            key: this.key,
            from: url,
            uuid: device.uuid
        });
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(msg),
                signal: AbortSignal.timeout(timeout || this.timeout)
            });
        } catch (err) {
            if (err.name === 'TimeoutError') {
                throw new RequestError('Timeout waiting for ' + namespace + ' response from ' + device.host);
            }
            throw new RequestError('HTTP request to ' + device.host + ' failed: ' + (err.cause ? err.cause.message : err.message));
        }
        if (!res.ok) {
            throw new RequestError('HTTP ' + res.status + ' from ' + device.host);
        }
        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            throw new RequestError('Device returned non-JSON response (encrypted firmware?)');
        }
        return checkResponse(json, namespace);
    }

    close() {
        return Promise.resolve();
    }
}

module.exports = {
    MqttTransport,
    HttpTransport,
    RequestError,
    extractUuid
};
