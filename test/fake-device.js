'use strict';

const { md5, localDate } = require('../lib/protocol');

/**
 * Minimal simulation of a Meross MSS310 with power measurement.
 */
class FakeDevice {
    constructor(uuid, key) {
        this.uuid = uuid;
        this.key = key;
        this.onoff = 1;
        this.requests = [];
    }

    handle(msg) {
        const h = msg.header;
        this.requests.push(msg);
        if (this.model === 'mop320') {
            return this.handleMop320(msg);
        }
        const reply = (method, payload) => ({
            header: Object.assign({}, h, { method: method, from: '/appliance/' + this.uuid + '/publish' }),
            payload: payload
        });
        if (h.sign !== md5(h.messageId + this.key + h.timestamp)) {
            return reply('ERROR', { error: { code: 5001, detail: 'sign error' } });
        }
        const ack = h.method + 'ACK';
        switch (h.namespace) {
            case 'Appliance.Control.Electricity':
                return reply(ack, { electricity: { channel: 0, current: 523, voltage: 2304, power: this.onoff ? 115250 : 0 } });
            case 'Appliance.Control.ConsumptionX':
                return reply(ack, { consumptionx: [
                    { date: '2020-01-02', time: 1, value: 200 },
                    { date: '2020-01-01', time: 1, value: 100 },
                    { date: localDate(new Date()), time: 1, value: 42 }
                ] });
            case 'Appliance.System.All':
                return reply(ack, { all: { digest: { togglex: [{ channel: 0, onoff: this.onoff }] } } });
            case 'Appliance.Control.ToggleX':
                this.onoff = msg.payload.togglex.onoff;
                return reply(ack, {});
            default:
                return reply('ERROR', { error: { code: 5000, detail: 'unsupported namespace' } });
        }
    }
}

/**
 * Simulation of a MOP320 (two metered outlets, channel 0 switches both).
 * Like the real device it silently ignores namespaces and payload formats it does not know.
 */
FakeDevice.prototype.handleMop320 = function (msg) {
    const h = msg.header;
    const reply = (payload) => ({
        header: Object.assign({}, h, { method: h.method + 'ACK', from: '/appliance/' + this.uuid + '/publish' }),
        payload: payload
    });
    if (!this.channels) {
        this.channels = { 0: 1, 1: 1, 2: 1 };
    }
    switch (h.namespace) {
        case 'Appliance.System.Ability':
            return reply({ ability: {
                'Appliance.System.All': {}, 'Appliance.System.Ability': {}, 'Appliance.Control.ToggleX': {},
                'Appliance.Control.ElectricityX': {}, 'Appliance.Control.ConsumptionH': {}
            } });
        case 'Appliance.System.All':
            return reply({ all: { digest: { togglex: [0, 1, 2].map((c) => ({ channel: c, onoff: this.channels[c] })) } } });
        case 'Appliance.Control.ElectricityX': {
            const e = msg.payload.electricity;
            if (!e || Array.isArray(e) || e.channel !== 65535) {
                return null;
            }
            return reply({ electricity: [
                { channel: 1, current: 450, voltage: 231200, power: this.channels[1] ? 100000 : 0, mConsume: 1200, factor: 0.95 },
                { channel: 2, current: 90, voltage: 231100, power: this.channels[2] ? 20500 : 0, mConsume: 300, factor: 0.9 }
            ] });
        }
        case 'Appliance.Control.ConsumptionH': {
            const now = Math.floor(Date.now() / 1000);
            return reply({ consumptionH: [
                { channel: 1, total: 30, data: [{ timestamp: now - 86400 * 2, value: 7 }, { timestamp: now, value: 10 }] },
                { channel: 2, total: 5, data: [{ timestamp: now, value: 5 }] }
            ] });
        }
        case 'Appliance.Control.ToggleX': {
            const t = msg.payload.togglex;
            this.channels[t.channel] = t.onoff;
            if (t.channel === 0) {
                this.channels[1] = this.channels[2] = t.onoff;
            }
            return reply({});
        }
        default:
            return null;
    }
};

module.exports = FakeDevice;
