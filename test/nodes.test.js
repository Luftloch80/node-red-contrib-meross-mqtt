'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');
const configNode = require('../nodes/meross-config.js');
const plugNode = require('../nodes/meross-plug.js');
const FakeDevice = require('./fake-device');

helper.init(require.resolve('node-red'));

const UUID = '2101234567890123456748e1e9aabbcc';
const KEY = 'devicekey';

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function nextMessage(node, filter) {
    return new Promise((resolve) => {
        node.on('input', function handler(msg) {
            if (!filter || filter(msg)) {
                node.removeListener('input', handler);
                resolve(msg);
            }
        });
    });
}

test.before(() => new Promise((resolve) => helper.startServer(resolve)));
test.after(() => new Promise((resolve) => helper.stopServer(resolve)));
test.afterEach(() => helper.unload());

test('local HTTP: reads power data and switches the plug', async () => {
    const device = new FakeDevice(UUID, KEY);
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            assert.strictEqual(req.url, '/config');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(device.handle(JSON.parse(body))));
        });
    });
    const port = await listen(server);
    const flow = [
        { id: 'cfg', type: 'meross-config', mode: 'http', timeout: 5 },
        { id: 'plug', type: 'meross-plug', server: 'cfg', host: '127.0.0.1:' + port, interval: 0, electricity: true, consumption: true, state: true, wires: [['out']] },
        { id: 'out', type: 'helper' }
    ];
    try {
        await helper.load([configNode, plugNode], flow, { cfg: { key: KEY } });
        const plug = helper.getNode('plug');
        const out = helper.getNode('out');

        let received = nextMessage(out);
        plug.receive({ payload: 'read' });
        let msg = await received;
        assert.strictEqual(msg.payload.power, 115.25);
        assert.strictEqual(msg.payload.voltage, 230.4);
        assert.strictEqual(msg.payload.current, 0.523);
        assert.strictEqual(msg.payload.onoff, true);
        assert.strictEqual(msg.payload.energyToday, 42);
        assert.strictEqual(msg.payload.consumption.length, 3);

        received = nextMessage(out);
        plug.receive({ payload: 'off' });
        msg = await received;
        assert.strictEqual(device.onoff, 0);
        assert.strictEqual(msg.payload.onoff, false);
        assert.strictEqual(msg.payload.power, 0);

        received = nextMessage(out);
        plug.receive({ namespace: 'Appliance.System.All' });
        msg = await received;
        assert.ok(msg.payload.all);
    } finally {
        server.close();
    }
});

test('local HTTP: wrong key reports an error', async () => {
    const device = new FakeDevice(UUID, KEY);
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => res.end(JSON.stringify(device.handle(JSON.parse(body)))));
    });
    const port = await listen(server);
    const flow = [
        { id: 'cfg', type: 'meross-config', mode: 'http', timeout: 5 },
        { id: 'plug', type: 'meross-plug', server: 'cfg', host: '127.0.0.1:' + port, interval: 0, wires: [[]] }
    ];
    try {
        await helper.load([configNode, plugNode], flow, { cfg: { key: 'wrong' } });
        const plug = helper.getNode('plug');
        const err = await new Promise((resolve) => {
            plug.error = (e) => resolve(e);
            plug.receive({ payload: 'read' });
        });
        assert.match(String(err.message || err), /sign error/);
    } finally {
        server.close();
    }
});

test('local MQTT broker: polls, switches and forwards pushes', async () => {
    const { Aedes } = await import('aedes');
    const broker = await Aedes.createBroker();
    const server = net.createServer(broker.handle);
    const port = await listen(server);
    const device = new FakeDevice(UUID, KEY);

    const devClient = mqtt.connect('mqtt://127.0.0.1:' + port, { clientId: 'fmss310_' + UUID });
    await new Promise((resolve) => devClient.on('connect', resolve));
    await devClient.subscribeAsync('/appliance/' + UUID + '/subscribe');
    devClient.on('message', (topic, buf) => {
        const req = JSON.parse(buf.toString());
        const res = device.handle(req);
        devClient.publish(req.header.from, JSON.stringify(res));
        if (req.header.namespace === 'Appliance.Control.ToggleX') {
            // real devices also push the new state
            const push = { header: Object.assign({}, res.header, { method: 'PUSH', messageId: 'p' + Date.now() }), payload: { togglex: [{ channel: 0, onoff: device.onoff }] } };
            devClient.publish('/appliance/' + UUID + '/publish', JSON.stringify(push));
        }
    });

    const flow = [
        { id: 'cfg', type: 'meross-config', mode: 'mqtt', broker: 'mqtt://127.0.0.1:' + port, timeout: 5 },
        { id: 'plug', type: 'meross-plug', server: 'cfg', uuid: UUID, interval: 0, electricity: true, consumption: false, state: true, push: true, wires: [['out']] },
        { id: 'out', type: 'helper' }
    ];
    try {
        await helper.load([configNode, plugNode], flow, { cfg: { key: KEY } });
        const cfg = helper.getNode('cfg');
        const plug = helper.getNode('plug');
        const out = helper.getNode('out');
        if (!cfg.isConnected()) {
            await new Promise((resolve) => cfg.events.once('connect', resolve));
        }

        let received = nextMessage(out);
        plug.receive({ payload: 'read' });
        let msg = await received;
        assert.strictEqual(msg.payload.power, 115.25);
        assert.strictEqual(msg.payload.onoff, true);

        // switch off from outside -> push event
        const pushed = nextMessage(out, (m) => m.event === 'push');
        const req = { header: { messageId: 'x1', timestamp: 1, sign: '', method: 'SET', namespace: 'Appliance.Control.ToggleX', from: '/app/other/subscribe' }, payload: { togglex: { channel: 0, onoff: 0 } } };
        req.header.sign = require('../lib/protocol').md5('x1' + KEY + 1);
        devClient.emit('message', '/appliance/' + UUID + '/subscribe', Buffer.from(JSON.stringify(req)));
        msg = await pushed;
        assert.strictEqual(msg.payload.onoff, false);

        received = nextMessage(out, (m) => !m.event);
        plug.receive({ payload: 'toggle' });
        msg = await received;
        assert.strictEqual(device.onoff, 1);
        assert.strictEqual(msg.payload.onoff, true);
    } finally {
        await helper.unload();
        await devClient.endAsync(true);
        await new Promise((resolve) => broker.close(resolve));
        server.close();
    }
});

test('cloud: talks to the broker the device is assigned to, not the login mqttDomain', { timeout: 20000 }, async () => {
    const { Aedes } = await import('aedes');
    const brokerA = await Aedes.createBroker();
    const brokerB = await Aedes.createBroker();
    const serverA = net.createServer(brokerA.handle);
    const serverB = net.createServer(brokerB.handle);
    const portA = await listen(serverA);
    const portB = await listen(serverB);
    const cloudKey = 'cloudkey';
    const device = new FakeDevice(UUID, cloudKey);

    const api = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let out;
            if (req.url === '/v1/Auth/signIn') {
                out = { apiStatus: 0, data: { token: 't', key: cloudKey, userid: 42, email: 'x@y.z', mqttDomain: 'mqtt://127.0.0.1:' + portA } };
            } else if (req.url === '/v1/Device/devList') {
                out = { apiStatus: 0, data: [{ uuid: UUID, devName: 'Plug', onlineStatus: 1, domain: 'mqtt://127.0.0.1:' + portB }] };
            }
            res.end(JSON.stringify(out));
        });
    });
    const apiPort = await listen(api);

    const devClient = mqtt.connect('mqtt://127.0.0.1:' + portB);
    await new Promise((resolve) => devClient.on('connect', resolve));
    await devClient.subscribeAsync('/appliance/' + UUID + '/subscribe');
    devClient.on('message', (topic, buf) => {
        const req = JSON.parse(buf.toString());
        assert.match(req.header.from, /^\/app\/42-[0-9a-f]{32}\/subscribe$/);
        devClient.publish(req.header.from, JSON.stringify(device.handle(req)));
    });

    const flow = [
        { id: 'cfg', type: 'meross-config', mode: 'cloud', region: 'custom', apiUrl: 'http://127.0.0.1:' + apiPort, timeout: 3 },
        { id: 'plug', type: 'meross-plug', server: 'cfg', uuid: UUID, interval: 0, electricity: true, state: true, wires: [['out']] },
        { id: 'out', type: 'helper' }
    ];
    try {
        await helper.load([configNode, plugNode], flow, { cfg: { email: 'x@y.z', password: 'pw' } });
        const cfg = helper.getNode('cfg');
        if (!cfg.isConnected()) {
            await new Promise((resolve) => cfg.events.once('connect', resolve));
        }
        const received = nextMessage(helper.getNode('out'));
        helper.getNode('plug').receive({ payload: 'read' });
        const msg = await received;
        assert.strictEqual(msg.payload.power, 115.25);
        assert.strictEqual(msg.payload.onoff, true);
    } finally {
        await helper.unload();
        await devClient.endAsync(true);
        await new Promise((resolve) => brokerA.close(resolve));
        await new Promise((resolve) => brokerB.close(resolve));
        serverA.close();
        serverB.close();
        api.close();
    }
});

test('MOP320: detects ElectricityX via abilities and probes the request format', { timeout: 60000 }, async () => {
    const device = new FakeDevice(UUID, KEY);
    device.model = 'mop320';
    const { Aedes } = await import('aedes');
    const broker = await Aedes.createBroker();
    const server = net.createServer(broker.handle);
    const port = await listen(server);
    const devClient = mqtt.connect('mqtt://127.0.0.1:' + port);
    await new Promise((resolve) => devClient.on('connect', resolve));
    await devClient.subscribeAsync('/appliance/' + UUID + '/subscribe');
    devClient.on('message', (topic, buf) => {
        const req = JSON.parse(buf.toString());
        const res = device.handle(req);
        if (res) {
            devClient.publish(req.header.from, JSON.stringify(res));
        }
    });
    const flow = [
        { id: 'cfg', type: 'meross-config', mode: 'mqtt', broker: 'mqtt://127.0.0.1:' + port, timeout: 5 },
        { id: 'all', type: 'meross-plug', server: 'cfg', uuid: UUID, channel: 0, interval: 0, electricity: true, consumption: true, state: true, wires: [['out']] },
        { id: 'out1', type: 'meross-plug', server: 'cfg', uuid: UUID, channel: 1, interval: 0, electricity: true, consumption: true, state: true, wires: [['out']] },
        { id: 'out', type: 'helper' }
    ];
    try {
        await helper.load([configNode, plugNode], flow, { cfg: { key: KEY } });
        const cfg = helper.getNode('cfg');
        if (!cfg.isConnected()) {
            await new Promise((resolve) => cfg.events.once('connect', resolve));
        }
        const out = helper.getNode('out');

        let received = nextMessage(out);
        helper.getNode('all').receive({ payload: 'read' });
        let msg = await received;
        // channel 0 = sum of both outlets
        assert.strictEqual(msg.payload.power, 120.5);
        assert.strictEqual(msg.payload.current, 0.54);
        assert.strictEqual(msg.payload.voltage, 231.2);
        assert.strictEqual(msg.payload.energy, 1500);
        assert.strictEqual(msg.payload.channels.length, 2);
        assert.strictEqual(msg.payload.energyToday, 15);
        assert.strictEqual(msg.payload.onoff, true);

        received = nextMessage(out);
        helper.getNode('out1').receive({ payload: 'off' });
        msg = await received;
        assert.strictEqual(msg.payload.power, 0);
        assert.strictEqual(msg.payload.voltage, 231.2);
        assert.strictEqual(msg.payload.factor, 0.95);
        assert.strictEqual(msg.payload.energyToday, 10);
        assert.strictEqual(msg.payload.onoff, false);

        // a lost message is retried transparently
        device.dropNext = 1;
        const before = device.requests.length;
        received = nextMessage(out);
        helper.getNode('out1').receive({ payload: 'read' });
        msg = await received;
        assert.strictEqual(msg.payload.voltage, 231.2);
        assert.strictEqual(device.requests[before].header.messageId !== device.requests[before + 1].header.messageId, true);
        assert.strictEqual(device.requests[before].header.namespace, device.requests[before + 1].header.namespace);
    } finally {
        await helper.unload();
        await devClient.endAsync(true);
        await new Promise((resolve) => broker.close(resolve));
        server.close();
    }
});
