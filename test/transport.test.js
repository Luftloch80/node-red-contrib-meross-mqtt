'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { HttpTransport } = require('../lib/transport');

const KEY = 'testkey';

// Raw TCP server that answers like MSS620 firmware 3.1.x: line endings without CR
function oldFirmwareServer(handler) {
    return net.createServer(sock => {
        let buf = '';
        sock.on('data', d => {
            buf += d;
            const i = buf.indexOf('\r\n\r\n');
            if (i < 0) return;
            const len = parseInt((/content-length:\s*(\d+)/i.exec(buf) || [])[1] || '0', 10);
            const body = buf.slice(i + 4);
            if (body.length < len) return;
            const out = JSON.stringify(handler(JSON.parse(body)));
            sock.end('HTTP/1.1 200 OK\nContent-Type: application/json\nContent-Length: ' + Buffer.byteLength(out) + '\n\n' + out);
        });
    });
}

test('local HTTP: accepts the non-compliant response of older firmware (no CR)', async () => {
    const server = oldFirmwareServer(req => ({
        header: { ...req.header, method: 'GETACK' },
        payload: { all: { digest: { togglex: [{ channel: 1, onoff: 1 }] } } }
    }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const host = '127.0.0.1:' + server.address().port;
    try {
        const t = new HttpTransport({ key: KEY, timeout: 3000 });
        const res = await t.request({ host, uuid: 'x' }, 'GET', 'Appliance.System.All', {});
        assert.strictEqual(res.payload.all.digest.togglex[0].onoff, 1);
    } finally {
        server.close();
    }
});

test('local HTTP: timeout is reported as timeout', async () => {
    const server = net.createServer(() => {});   // never answers
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const host = '127.0.0.1:' + server.address().port;
    try {
        const t = new HttpTransport({ key: KEY, timeout: 300 });
        await assert.rejects(t.request({ host, uuid: 'x' }, 'GET', 'Appliance.System.All', {}), err => {
            assert.match(err.message, /Timeout waiting for Appliance.System.All/);
            assert.strictEqual(err.timeout, true);
            return true;
        });
    } finally {
        server.close();
    }
});
