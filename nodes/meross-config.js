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
        node.events = new EventEmitter();
        node.events.setMaxListeners(0);
        node.state = 'disconnected';
        node.transport = null;
        node.session = null;

        const creds = node.credentials || {};
        let closing = false;

        function setState(state, text) {
            node.state = state;
            node.stateText = text || '';
            node.events.emit('state', state, node.stateText);
        }

        function attachTransport(transport) {
            node.transport = transport;
            transport.on('connect', () => {
                setState('connected');
                node.events.emit('connect');
            });
            transport.on('close', () => {
                if (!closing) {
                    setState('disconnected');
                }
            });
            transport.on('error', (err) => {
                node.warn('Meross: ' + err.message);
                setState('error', err.message);
            });
            transport.on('push', (uuid, namespace, payload) => {
                node.events.emit('push', uuid, namespace, payload);
            });
            transport.connect();
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

        async function startCloud() {
            setState('connecting', 'login');
            const session = await cloudLogin(false);
            if (closing) {
                return;
            }
            node.session = session;
            const appId = md5('API' + crypto.randomUUID());
            let host = node.mqttHost || session.mqttDomain || 'mqtt-eu.meross.com';
            if (!/^mqtts?:\/\//.test(host)) {
                host = 'mqtts://' + host + (/:\d+$/.test(host) ? '' : ':443');
            }
            const responseTopic = '/app/' + session.userId + '-' + appId + '/subscribe';
            setState('connecting', 'mqtt');
            attachTransport(new MqttTransport({
                url: host,
                key: session.key,
                responseTopic: responseTopic,
                subscribeTopics: [responseTopic, '/app/' + session.userId + '/subscribe'],
                timeout: node.timeout,
                mqttOptions: {
                    clientId: 'app:' + appId,
                    username: session.userId,
                    password: md5(session.userId + session.key),
                    protocolVersion: 4,
                    rejectUnauthorized: true
                }
            }));
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
            attachTransport(new MqttTransport({
                url: url,
                key: creds.key || '',
                responseTopic: responseTopic,
                subscribeTopics: [responseTopic, '/appliance/+/publish'],
                timeout: node.timeout,
                mqttOptions: mqttOptions
            }));
        }

        function startHttp() {
            attachTransport(new HttpTransport({ key: creds.key || '', timeout: node.timeout }));
        }

        node.request = function (device, method, namespace, payload) {
            if (!node.transport) {
                return Promise.reject(new Error('Meross connection not ready'));
            }
            return node.transport.request(device, method, namespace, payload, node.timeout);
        };

        node.isConnected = function () {
            return !!(node.transport && node.transport.connected);
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
            const transport = node.transport;
            node.transport = null;
            node.events.removeAllListeners();
            (transport ? transport.close() : Promise.resolve()).then(() => done(), () => done());
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
