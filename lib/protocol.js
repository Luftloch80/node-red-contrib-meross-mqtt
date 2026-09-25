'use strict';

const crypto = require('crypto');

const NS = {
    ALL: 'Appliance.System.All',
    ABILITY: 'Appliance.System.Ability',
    ELECTRICITY: 'Appliance.Control.Electricity',
    CONSUMPTIONX: 'Appliance.Control.ConsumptionX',
    CONSUMPTION: 'Appliance.Control.Consumption',
    TOGGLEX: 'Appliance.Control.ToggleX',
    TOGGLE: 'Appliance.Control.Toggle'
};

function md5(value) {
    return crypto.createHash('md5').update(String(value)).digest('hex');
}

function randomMessageId() {
    return md5(crypto.randomBytes(16));
}

/**
 * Build a signed Meross message.
 * sign = md5(messageId + key + timestamp)
 */
function buildMessage({ method, namespace, payload, key, from, uuid }) {
    const messageId = randomMessageId();
    const timestamp = Math.floor(Date.now() / 1000);
    const header = {
        from: from,
        messageId: messageId,
        method: method,
        namespace: namespace,
        payloadVersion: 1,
        sign: md5(messageId + (key || '') + timestamp),
        timestamp: timestamp,
        triggerSrc: 'Android'
    };
    if (uuid) {
        header.uuid = uuid;
    }
    return { header: header, payload: payload || {} };
}

/**
 * Convert the raw Appliance.Control.Electricity payload into SI units.
 * Device reports current in mA, voltage in dV (0.1 V) and power in mW.
 */
function parseElectricity(payload) {
    const e = payload && payload.electricity;
    if (!e) {
        return null;
    }
    const round = (v, d) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
    return {
        channel: e.channel || 0,
        power: round((e.power || 0) / 1000, 3),
        voltage: round((e.voltage || 0) / 10, 1),
        current: round((e.current || 0) / 1000, 3)
    };
}

/**
 * Convert Appliance.Control.ConsumptionX / Consumption payload.
 * Values are daily energy in Wh.
 */
function parseConsumption(payload) {
    const list = payload && (payload.consumptionx || payload.consumption);
    if (!Array.isArray(list)) {
        return null;
    }
    const days = list
        .map((d) => ({ date: d.date, energy: d.value, timestamp: d.time }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const today = localDate(new Date());
    const todayEntry = days.find((d) => d.date === today);
    return {
        today: todayEntry ? todayEntry.energy : 0,
        total: days.reduce((sum, d) => sum + (d.energy || 0), 0),
        days: days
    };
}

function localDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/**
 * Extract the on/off state of a channel from System.All or Toggle(X) payloads.
 * Returns true/false or undefined if not present.
 */
function parseOnOff(payload, channel) {
    if (!payload) {
        return undefined;
    }
    const fromList = (list) => {
        const arr = Array.isArray(list) ? list : [list];
        const entry = arr.find((t) => t && (t.channel || 0) === channel);
        return entry ? entry.onoff === 1 : undefined;
    };
    if (payload.togglex) {
        return fromList(payload.togglex);
    }
    if (payload.toggle) {
        return payload.toggle.onoff === 1;
    }
    const all = payload.all;
    if (all) {
        if (all.digest && all.digest.togglex) {
            return fromList(all.digest.togglex);
        }
        if (all.control && all.control.toggle) {
            return all.control.toggle.onoff === 1;
        }
    }
    return undefined;
}

module.exports = {
    NS,
    md5,
    buildMessage,
    parseElectricity,
    parseConsumption,
    parseOnOff,
    localDate
};
