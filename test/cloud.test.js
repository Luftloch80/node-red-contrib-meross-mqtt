'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const cloud = require('../lib/cloud');
const { md5 } = require('../lib/protocol');

test('login verifies signature, follows region redirect and lists devices', async () => {
    let port;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const b = JSON.parse(body);
            assert.strictEqual(b.sign, md5('23x17ahWarFH6w29' + b.timestamp + b.nonce + b.params));
            const params = JSON.parse(Buffer.from(b.params, 'base64').toString());
            let out;
            if (req.url === '/v1/Auth/signIn') {
                assert.strictEqual(params.password, md5('pw'));
                if (req.headers.host.startsWith('127.0.0.1')) {
                    out = { apiStatus: 1030, data: { domain: 'http://localhost:' + port } };
                } else {
                    out = { apiStatus: 0, data: { token: 'tok', key: 'k', userid: 123, email: params.email, mqttDomain: 'mqtt-eu-1.meross.com' } };
                }
            } else if (req.url === '/v1/Device/devList') {
                assert.strictEqual(req.headers.authorization, 'Basic tok');
                out = { apiStatus: 0, data: [{ uuid: 'abc', devName: 'Plug' }] };
            }
            res.end(JSON.stringify(out));
        });
    });
    port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
    try {
        const s = await cloud.login('http://127.0.0.1:' + port, 'a@b.c', 'pw');
        assert.strictEqual(s.userId, '123');
        assert.strictEqual(s.key, 'k');
        assert.strictEqual(s.baseUrl, 'http://localhost:' + port);
        const devices = await cloud.listDevices(s.baseUrl, s.token);
        assert.strictEqual(devices[0].uuid, 'abc');
    } finally {
        server.close();
    }
});

test('login error is reported with apiStatus', async () => {
    const server = http.createServer((req, res) => res.end(JSON.stringify({ apiStatus: 1004, info: 'wrong password' })));
    const port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
    try {
        await assert.rejects(cloud.login('http://127.0.0.1:' + port, 'a@b.c', 'x'), (err) => err.apiStatus === 1004);
    } finally {
        server.close();
    }
});
