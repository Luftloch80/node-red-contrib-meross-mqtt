'use strict';

const crypto = require('crypto');
const { md5 } = require('./protocol');

// Static secret used by the official Meross app to sign HTTP API requests.
const API_SECRET = '23x17ahWarFH6w29';
const APP_VERSION = '0.4.9.0';

const REGIONS = {
    eu: 'https://iotx-eu.meross.com',
    us: 'https://iotx-us.meross.com',
    ap: 'https://iotx-ap.meross.com'
};

class MerossApiError extends Error {
    constructor(message, apiStatus, data) {
        super(message);
        this.name = 'MerossApiError';
        this.apiStatus = apiStatus;
        this.data = data;
    }
}

function nonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(16);
    let out = '';
    for (const b of bytes) {
        out += chars[b % chars.length];
    }
    return out;
}

function normalizeBaseUrl(url) {
    if (!/^https?:\/\//.test(url)) {
        url = 'https://' + url;
    }
    return url.replace(/\/+$/, '');
}

async function apiRequest(baseUrl, path, data, token) {
    const params = Buffer.from(JSON.stringify(data || {})).toString('base64');
    const timestamp = Date.now();
    const n = nonce();
    const body = {
        params: params,
        sign: md5(API_SECRET + timestamp + n + params),
        timestamp: timestamp,
        nonce: n
    };
    const res = await fetch(normalizeBaseUrl(baseUrl) + path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: token ? 'Basic ' + token : 'Basic',
            vender: 'meross',
            AppVersion: APP_VERSION,
            Appver: APP_VERSION,
            AppType: 'MerossIOT',
            AppLanguage: 'EN',
            'User-Agent': 'MerossIOT/' + APP_VERSION
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
        throw new MerossApiError('HTTP ' + res.status + ' from Meross cloud', -1);
    }
    const json = await res.json();
    if (json.apiStatus !== 0) {
        throw new MerossApiError(
            'Meross cloud error ' + json.apiStatus + ': ' + (json.info || 'unknown'),
            json.apiStatus,
            json.data
        );
    }
    return json.data;
}

/**
 * Log in to the Meross cloud.
 * Returns { token, key, userId, email, domain, mqttDomain, baseUrl }.
 */
async function login(baseUrl, email, password, mfaCode) {
    const data = {
        email: email,
        password: md5(password),
        encryption: 1,
        accountCountryCode: '--',
        mobileInfo: {
            deviceModel: 'node-red',
            mobileOsVersion: process.version,
            mobileOs: process.platform,
            uuid: md5(email),
            carrier: ''
        },
        agree: 0
    };
    if (mfaCode) {
        data.mfaCode = mfaCode;
    }
    let url = normalizeBaseUrl(baseUrl);
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const result = await apiRequest(url, '/v1/Auth/signIn', data);
            return {
                token: result.token,
                key: result.key,
                userId: String(result.userid),
                email: result.email,
                domain: result.domain,
                mqttDomain: result.mqttDomain,
                baseUrl: url
            };
        } catch (err) {
            // 1030: account lives in another region -> retry with the returned domain
            if (err.apiStatus === 1030 && err.data && err.data.domain) {
                url = normalizeBaseUrl(err.data.domain);
                continue;
            }
            throw err;
        }
    }
    throw new MerossApiError('Too many region redirects during login', 1030);
}

async function listDevices(baseUrl, token) {
    return apiRequest(baseUrl, '/v1/Device/devList', {}, token);
}

async function logout(baseUrl, token) {
    return apiRequest(baseUrl, '/v1/Profile/logout', {}, token);
}

module.exports = {
    REGIONS,
    MerossApiError,
    login,
    listDevices,
    logout
};
