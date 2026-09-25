'use strict';

const { NS, parseElectricity, parseConsumption, parseOnOff } = require('../lib/protocol');

module.exports = function (RED) {
    function MerossPlugNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);
        node.device = {
            uuid: (config.uuid || '').trim(),
            host: (config.host || '').trim()
        };
        node.channel = parseInt(config.channel, 10) || 0;
        node.interval = parseFloat(config.interval);
        if (isNaN(node.interval)) {
            node.interval = 30;
        }
        node.readElectricity = config.electricity !== false;
        node.readConsumption = config.consumption === true;
        node.readState = config.state !== false;
        node.outputPush = config.push !== false;

        const label = config.name || node.device.uuid || node.device.host;
        let timer = null;
        let polling = false;
        let consumptionNs = NS.CONSUMPTIONX;
        let toggleNs = NS.TOGGLEX;
        const last = {};

        if (!node.server) {
            node.status({ fill: 'red', shape: 'ring', text: 'no config' });
            return;
        }

        function showValues() {
            const parts = [];
            if (typeof last.power === 'number') {
                parts.push(last.power.toFixed(1) + ' W');
            }
            if (typeof last.onoff === 'boolean') {
                parts.push(last.onoff ? 'on' : 'off');
            }
            node.status({
                fill: last.onoff === false ? 'grey' : 'green',
                shape: 'dot',
                text: parts.join(' | ') || 'ok'
            });
        }

        function snapshot() {
            return Object.assign({}, last, { channel: node.channel });
        }

        function isUnsupported(err) {
            return err && err.response && err.response.header && err.response.header.method === 'ERROR';
        }

        async function readConsumption() {
            try {
                const res = await node.server.request(node.device, 'GET', consumptionNs, {});
                return parseConsumption(res.payload);
            } catch (err) {
                if (isUnsupported(err) && consumptionNs === NS.CONSUMPTIONX) {
                    consumptionNs = NS.CONSUMPTION;
                    return readConsumption();
                }
                throw err;
            }
        }

        async function poll() {
            if (node.readElectricity) {
                const res = await node.server.request(node.device, 'GET', NS.ELECTRICITY, { electricity: { channel: node.channel } });
                const e = parseElectricity(res.payload);
                if (e) {
                    last.power = e.power;
                    last.voltage = e.voltage;
                    last.current = e.current;
                }
            }
            if (node.readConsumption) {
                const c = await readConsumption();
                if (c) {
                    last.energyToday = c.today;
                    last.consumption = c.days;
                }
            }
            if (node.readState) {
                const res = await node.server.request(node.device, 'GET', NS.ALL, {});
                const onoff = parseOnOff(res.payload, node.channel);
                if (typeof onoff === 'boolean') {
                    last.onoff = onoff;
                }
                if (res.payload && res.payload.all && res.payload.all.digest && !res.payload.all.digest.togglex &&
                    res.payload.all.control && res.payload.all.control.toggle) {
                    toggleNs = NS.TOGGLE;
                }
            }
            last.timestamp = Date.now();
            return snapshot();
        }

        async function setOnOff(on) {
            const payload = toggleNs === NS.TOGGLEX
                ? { togglex: { channel: node.channel, onoff: on ? 1 : 0 } }
                : { toggle: { onoff: on ? 1 : 0 } };
            try {
                await node.server.request(node.device, 'SET', toggleNs, payload);
            } catch (err) {
                if (isUnsupported(err) && toggleNs === NS.TOGGLEX) {
                    toggleNs = NS.TOGGLE;
                    return setOnOff(on);
                }
                throw err;
            }
            last.onoff = on;
        }

        function makeMsg(payload, extra) {
            return Object.assign({
                topic: label,
                payload: payload,
                device: { uuid: node.device.uuid, host: node.device.host, channel: node.channel, name: config.name }
            }, extra || {});
        }

        function reportError(err, done) {
            node.status({ fill: 'red', shape: 'ring', text: err.message.substring(0, 40) });
            if (done) {
                done(err);
            } else {
                node.error(err.message);
            }
        }

        async function pollAndSend(send, msg, done) {
            if (polling) {
                if (done) {
                    done();
                }
                return;
            }
            polling = true;
            try {
                const data = await poll();
                showValues();
                const out = msg ? Object.assign(msg, makeMsg(data, { topic: msg.topic || label })) : makeMsg(data);
                send(out);
                if (done) {
                    done();
                }
            } catch (err) {
                reportError(err, done);
            } finally {
                polling = false;
            }
        }

        function parseCommand(value) {
            if (typeof value === 'boolean') {
                return value;
            }
            if (typeof value === 'number') {
                return value !== 0;
            }
            if (typeof value === 'string') {
                const v = value.trim().toLowerCase();
                if (['on', 'true', '1', 'an', 'ein'].includes(v)) {
                    return true;
                }
                if (['off', 'false', '0', 'aus'].includes(v)) {
                    return false;
                }
                if (v === 'toggle') {
                    return 'toggle';
                }
            }
            return undefined;
        }

        node.on('input', async function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            try {
                if (msg.namespace) {
                    const res = await node.server.request(node.device, msg.method || 'GET', msg.namespace,
                        typeof msg.payload === 'object' && msg.payload !== null ? msg.payload : {});
                    msg.payload = res.payload;
                    msg.response = res;
                    send(msg);
                    done();
                    return;
                }
                const cmd = parseCommand(msg.payload);
                if (cmd !== undefined) {
                    let on = cmd;
                    if (cmd === 'toggle') {
                        if (typeof last.onoff !== 'boolean') {
                            const res = await node.server.request(node.device, 'GET', NS.ALL, {});
                            last.onoff = parseOnOff(res.payload, node.channel);
                        }
                        on = !last.onoff;
                    }
                    await setOnOff(on);
                    showValues();
                }
            } catch (err) {
                reportError(err, done);
                return;
            }
            await pollAndSend(send, msg, done);
        });

        function onState(state, text) {
            if (state === 'connected') {
                node.status({ fill: 'yellow', shape: 'dot', text: 'connected' });
            } else if (state === 'connecting') {
                node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' + (text ? ' (' + text + ')' : '') });
            } else if (state === 'error') {
                node.status({ fill: 'red', shape: 'ring', text: (text || 'error').substring(0, 40) });
            } else {
                node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
            }
        }

        function onConnect() {
            if (node.interval > 0) {
                pollAndSend((m) => node.send(m));
            }
        }

        function onPush(uuid, namespace, payload) {
            if (!node.device.uuid || uuid !== node.device.uuid) {
                return;
            }
            let changed = false;
            if (namespace === NS.TOGGLEX || namespace === NS.TOGGLE) {
                const onoff = parseOnOff(payload, node.channel);
                if (typeof onoff === 'boolean' && onoff !== last.onoff) {
                    last.onoff = onoff;
                    changed = true;
                }
            } else if (namespace === NS.ELECTRICITY) {
                const e = parseElectricity(payload);
                if (e && e.channel === node.channel) {
                    Object.assign(last, { power: e.power, voltage: e.voltage, current: e.current });
                    changed = true;
                }
            }
            if (changed) {
                last.timestamp = Date.now();
                showValues();
                if (node.outputPush) {
                    node.send(makeMsg(snapshot(), { event: 'push', namespace: namespace }));
                }
            }
        }

        node.server.events.on('state', onState);
        node.server.events.on('connect', onConnect);
        node.server.events.on('push', onPush);
        onState(node.server.state, node.server.stateText);

        if (node.interval > 0) {
            timer = setInterval(() => {
                if (node.server.isConnected()) {
                    pollAndSend((m) => node.send(m));
                }
            }, node.interval * 1000);
            if (node.server.isConnected()) {
                onConnect();
            }
        }

        node.on('close', function () {
            if (timer) {
                clearInterval(timer);
            }
            if (node.server && node.server.events) {
                node.server.events.removeListener('state', onState);
                node.server.events.removeListener('connect', onConnect);
                node.server.events.removeListener('push', onPush);
            }
        });
    }

    RED.nodes.registerType('meross-plug', MerossPlugNode);
};
