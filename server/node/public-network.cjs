const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const ipaddr = require('ipaddr.js');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function normalizeAddress(address) {
    try {
        let parsed = ipaddr.parse(address);
        if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
            parsed = parsed.toIPv4Address();
        }
        return parsed;
    }
    catch {
        return null;
    }
}

function isPublicAddress(address) {
    const parsed = normalizeAddress(address);
    return parsed !== null && parsed.range() === 'unicast';
}

async function resolvePublicNetworkUrl(value, lookup = dns.lookup) {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('Only HTTP(S) public network URLs are allowed');
    }
    if (url.username || url.password) {
        throw new Error('Credentials in public network URLs are not allowed');
    }

    const records = await lookup(url.hostname, { all: true, verbatim: true });
    if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
        throw new Error(`Public network policy blocked host ${url.hostname}`);
    }

    const parsedAddress = normalizeAddress(records[0].address);
    return {
        url,
        address: parsedAddress.toString(),
        family: parsedAddress.kind() === 'ipv4' ? 4 : 6,
    };
}

function toResponseHeaders(rawHeaders) {
    const headers = new Headers();
    for (let index = 0; index < rawHeaders.length; index += 2) {
        headers.append(rawHeaders[index], rawHeaders[index + 1]);
    }
    return headers;
}

function requestPinnedPublicUrl(target, init, clients = { http, https }) {
    const { url, address, family } = target;
    const client = url.protocol === 'https:' ? clients.https : clients.http;
    const headers = { ...(init.headers ?? {}) };
    for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'host') delete headers[name];
    }
    headers.host = url.host;

    return new Promise((resolve, reject) => {
        // The request destination is the already validated and normalized IP;
        // user input is limited to the HTTP path, Host header, and TLS SNI.
        // codeql[js/request-forgery]
        const request = client.request({
            protocol: url.protocol,
            hostname: address,
            family,
            port: url.port || undefined,
            method: init.method,
            path: `${url.pathname}${url.search}`,
            headers,
            servername: url.hostname,
            signal: init.signal,
            agent: false,
        }, (incoming) => {
            const incomingStatus = incoming.statusCode ?? 500;
            const status = incomingStatus >= 200 && incomingStatus <= 599 ? incomingStatus : 502;
            const body = BODYLESS_STATUSES.has(status) ? null : Readable.toWeb(incoming);
            resolve(new Response(body, {
                status,
                statusText: incoming.statusMessage,
                headers: toResponseHeaders(incoming.rawHeaders),
            }));
        });
        request.once('error', reject);
        if (init.body !== undefined && init.body !== null) request.write(init.body);
        request.end();
    });
}

async function fetchPublicNetworkUrl(value, init = {}) {
    let current = await resolvePublicNetworkUrl(value);
    const origin = current.url.origin;
    let nextInit = { ...init };

    for (let redirects = 0; redirects <= 5; redirects++) {
        // The socket connects to the validated, normalized address above. The
        // original hostname is retained only for Host and TLS SNI, preventing a
        // DNS-rebinding change between validation and connection.
        // codeql[js/request-forgery]
        const response = await requestPinnedPublicUrl(current, nextInit);
        if (!REDIRECT_STATUSES.has(response.status)) return response;

        const location = response.headers.get('location');
        if (!location) return response;
        if (redirects === 5) throw new Error('Public network redirect limit exceeded');
        await response.body?.cancel();

        const next = await resolvePublicNetworkUrl(new URL(location, current.url).toString());
        if (next.url.origin !== origin) {
            throw new Error(`Cross-origin redirect to ${next.url.origin} was blocked`);
        }
        if ([301, 302, 303].includes(response.status) && nextInit.method !== 'GET' && nextInit.method !== 'HEAD') {
            nextInit = { ...nextInit, method: 'GET', body: undefined };
        }
        current = next;
    }

    throw new Error('Public network redirect limit exceeded');
}

module.exports = {
    fetchPublicNetworkUrl,
    isPublicAddress,
    requestPinnedPublicUrl,
    resolvePublicNetworkUrl,
};
