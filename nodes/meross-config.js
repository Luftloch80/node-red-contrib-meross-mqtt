'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const cloud = require('../lib/cloud');
const { md5 } = require('../lib/protocol');
const { MqttTransport, HttpTransport } = require('../lib/transport');

// Cloud logins survive redeploys so we do not hammer the Meross login API.
const loginCache = new Map();

module.exports = function (RED) {
    function MerossConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name;
        node.mode = config.mode || 'cloud';
        node.region = config.region || 'eu';
        node.apiUrl = config.apiUrl;
        node.mqttHost = config.mqttHost;
        node.broker = config.broker;
        node.timeout = (parseInt(config.timeout, 10) || 10) * 1000;
        node.debug = config.debug === true;
        node.events = new EventEmitter();
        node.events.setMaxListeners(0);
        node.state = 'disconnected';
        node.session = null;

        const creds = node.credentials || {};
        // MQTT/HTTP transports by broker host. The Meross cloud spreads devices over
        // several brokers (mqtt-eu-1, mqtt-eu-2, ...), so cloud mode may need more than one.
        const transports = new Map();
        const deviceDomains = new Map();
        let cloudAppId = null;
        let closing = false;

        function setState(state, text) {
            node.state = state;
            node.stateText = text || '';
            node.events.emit('state', state, node.stateText);
        }

        function anyConnected() {
            for (const t of transports.values()) {
                if (t.connected) {
                    return true;
                }
            }
            return false;
        }

        function logTraffic(direction, topic, msg) {
            node.log(direction + ' ' + (topic || '') + ' ' + JSON.stringify(msg));
        }

        function attachTransport(name, transport) {
            transports.set(name, transport);
            transport.on('connect', () => {
                if (node.debug) {
                    node.log('connected to ' + name);
                }
                setState('connected');
                node.events.emit('connect');
            });
            transport.on('close', () => {
                if (!closing && !anyConnected()) {
                    setState('disconnected');
                }
            });
            transport.on('error', (err) => {
                node.warn('Meross (' + name + '): ' + err.message);
                setState('error', err.message);
            });
            transport.on('push', (uuid, namespace, payload) => {
                node.events.emit('push', uuid, namespace, payload);
            });
            transport.connect();
            return transport;
        }

        async function cloudLogin(force) {
            const baseUrl = node.region === 'custom' ? node.apiUrl : cloud.REGIONS[node.region];
            if (!baseUrl) {
                throw new Error('No Meross API URL configured');
            }
            if (!creds.email || !creds.password) {
                throw new Error('E-mail and password are required for cloud mode');
            }
            const cacheKey = baseUrl + '|' + creds.email + '|' + md5(creds.password);
            if (!force && loginCache.has(cacheKey)) {
                return loginCache.get(cacheKey);
            }
            const session = await cloud.login(baseUrl, creds.email, creds.password);
            loginCache.set(cacheKey, session);
            return session;
        }

        function cloudHostFor(uuid) {
            return node.mqttHost || deviceDomains.get(uuid) || node.session.mqttDomain || 'mqtt-eu.meross.com';
        }

        function cloudTransport(host) {
            if (transports.has(host)) {
                return transports.get(host);
            }
            const session = node.session;
            let url = host;
            if (!/^mqtts?:\/\//.test(url)) {
                url = 'mqtts://' + url + (/:\d+$/.test(url) ? '' : ':443');
            }
            const responseTopic = '/app/' + session.userId + '-' + cloudAppId + '/subscribe';
            return attachTransport(host, new MqttTransport({
                url: url,
                key: session.key,
                responseTopic: responseTopic,
                subscribeTopics: [responseTopic, '/app/' + session.userId + '/subscribe'],
                timeout: node.timeout,
                log: node.debug ? logTraffic : null,
                mqttOptions: {
                    clientId: 'app:' + cloudAppId,
                    username: session.userId,
                    password: md5(session.userId + session.key),
                    protocolVersion: 4,
                    rejectUnauthorized: true
                }
            }));
        }

        async function startCloud() {
            setState('connecting', 'login');
            node.session = await cloudLogin(false);
            if (closing) {
                return;
            }
            cloudAppId = md5('API' + crypto.randomUUID());
            try {
                const devices = await node.listDevices();
                for (const d of devices || []) {
                    const domain = d.domain || d.reservedDomain;
                    if (domain) {
                        deviceDomains.set(d.uuid, domain);
                    }
                    if (node.debug) {
                        node.log('device ' + d.devName + ' ' + d.uuid + ' broker=' + domain + ' online=' + d.onlineStatus);
                    }
                }
            } catch (err) {
                node.warn('Meross: could not load device list: ' + err.message);
            }
            if (closing) {
                return;
            }
            setState('connecting', 'mqtt');
            const hosts = new Set(node.mqttHost ? [node.mqttHost] : deviceDomains.values());
            if (hosts.size === 0) {
                hosts.add(cloudHostFor(null));
            }
            for (const host of hosts) {
                cloudTransport(host);
            }
        }

        function startLocalMqtt() {
            if (!node.broker) {
                throw new Error('No MQTT broker URL configured');
            }
            const url = /^(mqtts?|wss?|tcp|ssl):\/\//.test(node.broker) ? node.broker : 'mqtt://' + node.broker;
            const appId = md5('nodered' + crypto.randomUUID());
            const responseTopic = '/app/nodered-' + appId.substring(0, 12) + '/subscribe';
            const mqttOptions = { clientId: 'nodered-meross-' + appId.substring(0, 8) };
            if (creds.mqttUser) {
                mqttOptions.username = creds.mqttUser;
                mqttOptions.password = creds.mqttPassword || '';
            }
            setState('connecting', 'mqtt');
            attachTransport(node.broker, new MqttTransport({
                url: url,
                key: creds.key || '',
                responseTopic: responseTopic,
                subscribeTopics: [responseTopic, '/appliance/+/publish'],
                timeout: node.timeout,
                log: node.debug ? logTraffic : null,
                mqttOptions: mqttOptions
            }));
        }

        function startHttp() {
            attachTransport('http', new HttpTransport({ key: creds.key || '', timeout: node.timeout, log: node.debug ? logTraffic : null }));
        }

        function waitForConnect(transport) {
            if (transport.connected) {
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    transport.removeListener('connect', onConnect);
                    reject(new Error('Not connected to MQTT broker ' + transport.url));
                }, node.timeout);
                function onConnect() {
                    clearTimeout(timer);
                    resolve();
                }
                transport.once('connect', onConnect);
            });
        }

        node.request = async function (device, method, namespace, payload) {
            let transport;
            if (node.mode === 'cloud') {
                if (!node.session || !cloudAppId) {
                    throw new Error('Meross cloud login not finished');
                }
                transport = cloudTransport(cloudHostFor(device && device.uuid));
                await waitForConnect(transport);
            } else {
                transport = transports.values().next().value;
                if (!transport) {
                    throw new Error('Meross connection not ready');
                }
            }
            return transport.request(device, method, namespace, payload, node.timeout);
        };

        node.isConnected = function () {
            return anyConnected();
        };

        node.listDevices = async function () {
            if (node.mode !== 'cloud') {
                throw new Error('Device list is only available in cloud mode');
            }
            let session = node.session || await cloudLogin(false);
            try {
                return await cloud.listDevices(session.baseUrl, session.token);
            } catch (err) {
                // token expired -> log in again once
                session = await cloudLogin(true);
                node.session = session;
                return cloud.listDevices(session.baseUrl, session.token);
            }
        };

        Promise.resolve()
            .then(() => {
                if (node.mode === 'cloud') {
                    return startCloud();
                } else if (node.mode === 'mqtt') {
                    return startLocalMqtt();
                }
                return startHttp();
            })
            .catch((err) => {
                node.error('Meross: ' + err.message);
                setState('error', err.message);
            });

        node.on('close', function (done) {
            closing = true;
            const list = Array.from(transports.values());
            transports.clear();
            node.events.removeAllListeners();
            Promise.all(list.map((t) => t.close())).then(() => done(), () => done());
        });
    }

    RED.nodes.registerType('meross-config', MerossConfigNode, {
        credentials: {
            email: { type: 'text' },
            password: { type: 'password' },
            mqttUser: { type: 'text' },
            mqttPassword: { type: 'password' },
            key: { type: 'password' }
        }
    });

    RED.httpAdmin.get('/meross-mqtt/devices/:id', RED.auth.needsPermission('meross-config.read'), async function (req, res) {
        const configNode = RED.nodes.getNode(req.params.id);
        if (!configNode || typeof configNode.listDevices !== 'function') {
            res.status(404).json({ error: 'Config node not deployed yet. Deploy first.' });
            return;
        }
        try {
            const devices = await configNode.listDevices();
            res.json((devices || []).map((d) => ({
                uuid: d.uuid,
                domain: d.domain || d.reservedDomain,
                name: d.devName,
                type: d.deviceType,
                online: d.onlineStatus === 1,
                channels: (d.channels || []).length
            })));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
