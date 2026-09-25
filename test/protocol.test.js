'use strict';

const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/protocol');

test('buildMessage signs with md5(messageId + key + timestamp)', () => {
    const msg = p.buildMessage({ method: 'GET', namespace: p.NS.ELECTRICITY, payload: { a: 1 }, key: 'secret', from: '/app/x/subscribe' });
    const h = msg.header;
    assert.strictEqual(h.sign, p.md5(h.messageId + 'secret' + h.timestamp));
    assert.strictEqual(h.messageId.length, 32);
    assert.deepStrictEqual(msg.payload, { a: 1 });
});

test('parseElectricity converts to W, V, A', () => {
    assert.deepStrictEqual(
        p.parseElectricity({ electricity: { channel: 0, current: 523, voltage: 2304, power: 115250 } }),
        { channel: 0, power: 115.25, voltage: 230.4, current: 0.523 }
    );
    assert.strictEqual(p.parseElectricity({}), null);
});

test('parseConsumption sorts days and finds today', () => {
    const today = p.localDate(new Date());
    const c = p.parseConsumption({ consumptionx: [
        { date: today, value: 42, time: 3 },
        { date: '2020-01-01', value: 100, time: 1 }
    ] });
    assert.strictEqual(c.today, 42);
    assert.strictEqual(c.total, 142);
    assert.strictEqual(c.days[0].date, '2020-01-01');
});

test('parseOnOff handles System.All and ToggleX/Toggle', () => {
    assert.strictEqual(p.parseOnOff({ all: { digest: { togglex: [{ channel: 0, onoff: 1 }] } } }, 0), true);
    assert.strictEqual(p.parseOnOff({ all: { control: { toggle: { onoff: 0 } } } }, 0), false);
    assert.strictEqual(p.parseOnOff({ togglex: { channel: 1, onoff: 1 } }, 1), true);
    assert.strictEqual(p.parseOnOff({ togglex: [{ channel: 1, onoff: 1 }] }, 0), undefined);
});
