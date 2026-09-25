'use strict';

const { NS, parseElectricity, parseElectricityX, parseConsumption, parseOnOff, localDate } = require('../lib/protocol');

// Short timeout while probing request formats: some devices silently ignore payloads they don't understand
const PROBE_TIMEOUT = 5000;

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
        // Namespaces the device reports in Appliance.System.Ability (null = not loaded yet, {} = unknown)
        let abilities = null;
        let deviceChannels = [node.channel];
        let electricityXFormat = null;
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

        function has(namespace) {
            // without ability information assume everything and rely on error fallbacks
            return !abilities || Object.keys(abilities).length === 0 || namespace in abilities;
        }

        async function loadAbilities() {
            if (abilities) {
                return;
            }
            let res;
            try {
                res = await node.server.request(node.device, 'GET', NS.ABILITY, {});
            } catch (err) {
                if (isUnsupported(err)) {
                    abilities = {};
                    return;
                }
                throw new Error('Device does not answer (' + err.message + ')');
            }
            abilities = (res.payload && res.payload.ability) || {};
            node.log('abilities: ' + Object.keys(abilities).join(', '));
            if (has(NS.TOGGLEX)) {
                toggleNs = NS.TOGGLEX;
            } else if (has(NS.TOGGLE)) {
                toggleNs = NS.TOGGLE;
            }
            if (has(NS.CONSUMPTIONX)) {
                consumptionNs = NS.CONSUMPTIONX;
            } else if (has(NS.CONSUMPTION)) {
                consumptionNs = NS.CONSUMPTION;
            } else if (has(NS.CONSUMPTIONH)) {
                consumptionNs = NS.CONSUMPTIONH;
            }
            if (!has(NS.ELECTRICITY) && has(NS.ELECTRICITYX)) {
                // newer devices (e.g. MOP320): learn the channel list from System.All
                try {
                    const all = await node.server.request(node.device, 'GET', NS.ALL, {});
                    const digest = all.payload && all.payload.all && all.payload.all.digest;
                    const tx = digest && digest.togglex;
                    if (tx) {
                        deviceChannels = (Array.isArray(tx) ? tx : [tx]).map((t) => t.channel || 0);
                    }
                } catch (err) {
                    // keep default channel list
                }
            }
        }

        const ELECTRICITYX_FORMATS = [
            () => ({ electricity: deviceChannels.map((c) => ({ channel: c })) }),
            () => ({ electricity: { channel: 65535 } }),
            () => ({ electricity: { channel: node.channel } }),
            () => ({ electricity: [] }),
            () => ({ electricity: {} })
        ];

        async function readElectricityX() {
            if (electricityXFormat !== null) {
                const res = await node.server.request(node.device, 'GET', NS.ELECTRICITYX, ELECTRICITYX_FORMATS[electricityXFormat]());
                return parseElectricityX(res.payload);
            }
            // the request format of ElectricityX differs between devices: try the known variants
            let lastErr = null;
            for (let i = 0; i < ELECTRICITYX_FORMATS.length; i++) {
                const request = ELECTRICITYX_FORMATS[i]();
                try {
                    const res = await node.server.request(node.device, 'GET', NS.ELECTRICITYX, request, PROBE_TIMEOUT);
                    const list = parseElectricityX(res.payload);
                    if (list.length) {
                        electricityXFormat = i;
                        node.log('ElectricityX request format: ' + JSON.stringify(request));
                        return list;
                    }
                } catch (err) {
                    lastErr = err;
                }
            }
            throw new Error('No valid ElectricityX response' + (lastErr ? ': ' + lastErr.message : ''));
        }

        function applyElectricityChannels(list) {
            const round = (v) => Math.round(v * 1000) / 1000;
            last.channels = list;
            const own = list.find((c) => c.channel === node.channel) || (list.length === 1 ? list[0] : null);
            if (own) {
                last.power = own.power;
                last.voltage = own.voltage;
                last.current = own.current;
                if ('energy' in own) {
                    last.energy = own.energy;
                }
                if ('factor' in own) {
                    last.factor = own.factor;
                }
                return;
            }
            // e.g. channel 0 on a MOP320 (switches both outlets): report the sum of all channels
            last.power = round(list.reduce((sum, c) => sum + c.power, 0));
            last.current = round(list.reduce((sum, c) => sum + c.current, 0));
            last.voltage = Math.max.apply(null, list.map((c) => c.voltage));
            if (list.some((c) => 'energy' in c)) {
                last.energy = list.reduce((sum, c) => sum + (c.energy || 0), 0);
            }
        }

        async function readElectricity() {
            if (has(NS.ELECTRICITY)) {
                const res = await node.server.request(node.device, 'GET', NS.ELECTRICITY, { electricity: { channel: node.channel } });
                const e = parseElectricity(res.payload);
                if (e) {
                    last.power = e.power;
                    last.voltage = e.voltage;
                    last.current = e.current;
                }
            } else if (has(NS.ELECTRICITYX)) {
                applyElectricityChannels(await readElectricityX());
            } else {
                throw new Error('Device has no power metering (no Electricity ability)');
            }
        }

        async function readConsumptionH() {
            let res;
            try {
                res = await node.server.request(node.device, 'GET', NS.CONSUMPTIONH,
                    { consumptionH: deviceChannels.map((c) => ({ channel: c })) }, PROBE_TIMEOUT);
            } catch (err) {
                res = await node.server.request(node.device, 'GET', NS.CONSUMPTIONH, {});
            }
            const list = (res.payload && res.payload.consumptionH) || [];
            const today = localDate(new Date());
            const own = list.filter((c) => (c.channel || 0) === node.channel);
            const relevant = own.length ? own : list;
            let energyToday = 0;
            for (const c of relevant) {
                for (const d of c.data || []) {
                    if (localDate(new Date(d.timestamp * 1000)) === today) {
                        energyToday += d.value || 0;
                    }
                }
            }
            last.energyToday = energyToday;
            last.consumptionHourly = list;
        }

        async function readConsumption() {
            if (consumptionNs === NS.CONSUMPTIONH) {
                return readConsumptionH();
            }
            let c;
            try {
                const res = await node.server.request(node.device, 'GET', consumptionNs, {});
                c = parseConsumption(res.payload);
            } catch (err) {
                if (isUnsupported(err) && consumptionNs === NS.CONSUMPTIONX) {
                    consumptionNs = NS.CONSUMPTION;
                    return readConsumption();
                }
                throw err;
            }
            if (c) {
                last.energyToday = c.today;
                last.consumption = c.days;
            }
        }

        async function poll() {
            await loadAbilities();
            if (node.readElectricity) {
                await readElectricity();
            }
            if (node.readConsumption) {
                await readConsumption();
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
            } else if (namespace === NS.ELECTRICITYX) {
                const list = parseElectricityX(payload);
                if (list.length) {
                    applyElectricityChannels(list);
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
