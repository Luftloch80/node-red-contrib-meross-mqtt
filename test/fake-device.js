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

module.exports = FakeDevice;
