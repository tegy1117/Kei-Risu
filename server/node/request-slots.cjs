'use strict';

const { randomUUID, createHash } = require('crypto');

const normalizeLimit = (value) => Number.isSafeInteger(value) && value >= 1 ? value : 1;
const fingerprint = (key) => createHash('sha256').update(key).digest('hex');

// One scheduler shared by every transport. Reservations count towards the
// limit; running slots belong to the upstream body, not to the response headers.
function createRequestSlots({ getPool, reservationMs = 30000 } = {}) {
    const tickets = new Map();
    let refreshing = null;

    async function refresh() {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            const pool = await getPool();
            const entries = Object.values(pool || {});
            const limits = new Map();
            for (const entry of entries) {
                if (!entry?.key) continue;
                const hash = fingerprint(entry.key);
                limits.set(hash, Math.min(limits.get(hash) ?? Infinity, normalizeLimit(entry.maxConcurrentRequests)));
            }
            const now = Date.now();
            for (const ticket of tickets.values()) {
                if (ticket.state !== 'queued' && ticket.state !== 'ready') continue;
                const entry = pool?.[ticket.apiKeyRef];
                if (!entry || fingerprint(entry.key || '') !== ticket.fingerprint) {
                    ticket.state = 'failed';
                    ticket.error = 'The API key was changed or removed.';
                    ticket.endedAt ??= now;
                } else if (ticket.state === 'ready' && ticket.expiresAt <= now) {
                    ticket.state = 'failed';
                    ticket.error = 'Request reservation expired.';
                    ticket.endedAt = now;
                }
            }
            for (const [hash, limit] of limits) {
                let active = [...tickets.values()].filter(t => t.fingerprint === hash && t.state === 'running').length;
                for (const ticket of tickets.values()) {
                    if (ticket.fingerprint !== hash || (ticket.state !== 'queued' && ticket.state !== 'ready')) continue;
                    if (active >= limit) {
                        ticket.state = 'queued';
                        continue;
                    }
                    if (ticket.state === 'queued') ticket.expiresAt = now + reservationMs;
                    ticket.state = 'ready';
                    active++;
                }
            }
            for (const [id, ticket] of tickets) {
                if (ticket.endedAt && now - ticket.endedAt > 60000) tickets.delete(id);
            }
        })().finally(() => { refreshing = null; });
        return refreshing;
    }

    async function identify({ apiKeyRef, headers = {}, url = '' } = {}) {
        const pool = await getPool();
        if (apiKeyRef) {
            if (!pool?.[apiKeyRef]?.key) throw new Error('Managed API key not found. Save the key before sending.');
            const key = pool[apiKeyRef].key;
            // Service-account credentials exchange their stored JSON for OAuth
            // tokens. Raw API keys must still match after edits while queued.
            const values = Object.values(headers).filter(v => typeof v === 'string');
            let params = [];
            try { params = [...new URL(url).searchParams.values()]; } catch { /* transport validates URL */ }
            const serviceAccount = key.trim().startsWith('{') && key.includes('private_key');
            if ((values.length || url) && !serviceAccount && !values.some(v => v === key || v === `Bearer ${key}` || v === `Token ${key}`) && !params.includes(key)) {
                throw new Error('The request credentials no longer match the managed API key.');
            }
            return apiKeyRef;
        }
        const values = Object.values(headers).filter(v => typeof v === 'string');
        let params = [];
        try { params = [...new URL(url).searchParams.values()]; } catch { /* URL validated by transport */ }
        return Object.values(pool || {}).find(entry => entry?.key &&
            (values.some(value => value === entry.key || value === `Bearer ${entry.key}` || value === `Token ${entry.key}`) || params.includes(entry.key)))?.id;
    }

    const view = (ticket) => ({ id: ticket.id, state: ticket.state, error: ticket.error });
    async function reserve(apiKeyRef) {
        const pool = await getPool();
        if (!pool?.[apiKeyRef]?.key) throw new Error('Managed API key not found.');
        const ticket = { id: randomUUID(), apiKeyRef, fingerprint: fingerprint(pool[apiKeyRef].key), state: 'queued' };
        tickets.set(ticket.id, ticket);
        await refresh();
        return view(ticket);
    }
    async function status(id) {
        await refresh();
        const ticket = tickets.get(id);
        return ticket ? view(ticket) : null;
    }
    function cancel(id) {
        const ticket = tickets.get(id);
        if (!ticket) return;
        if (ticket.state === 'running') { ticket.abort?.(); return; }
        ticket.state = 'aborted';
        ticket.endedAt = Date.now();
        void refresh();
    }
    async function acquire({ ticketId, signal, onQueued, abort, ...identity } = {}) {
        const ref = await identify(identity);
        if (!ref && !ticketId) return () => {};
        const ticket = ticketId ? tickets.get(ticketId) : tickets.get((await reserve(ref)).id);
        if (!ticket || ticket.apiKeyRef !== ref || ticket.state === 'running') throw new Error('Invalid request reservation.');
        const onAbort = () => cancel(ticket.id);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            while (true) {
                if (signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
                await refresh();
                if (ticket.state === 'ready') break;
                if (ticket.state !== 'queued') throw new Error(ticket.error || 'Request reservation is no longer available.');
                onQueued?.();
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            ticket.state = 'running';
            ticket.abort = abort;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                signal?.removeEventListener('abort', onAbort);
                ticket.abort = undefined;
                ticket.state = 'done';
                ticket.endedAt = Date.now();
                void refresh();
            };
        } catch (error) {
            signal?.removeEventListener('abort', onAbort);
            if (ticket.state !== 'running') cancel(ticket.id);
            throw error;
        }
    }
    const timer = setInterval(() => { if (tickets.size) void refresh().catch(() => {}); }, 1000);
    timer.unref?.();

    function registerRoutes(app, { auth }) {
        app.post('/api/request-slots', async (req, res) => {
            if (!await auth(req, res)) return;
            try { res.json(await reserve(req.body?.apiKeyRef)); }
            catch (error) { res.status(400).json({ error: error.message }); }
        });
        app.get('/api/request-slots/:id', async (req, res) => {
            if (!await auth(req, res)) return;
            const ticket = await status(req.params.id);
            if (!ticket) return res.status(404).json({ error: 'Request reservation not found.' });
            res.json(ticket);
        });
        app.delete('/api/request-slots/:id', async (req, res) => {
            if (!await auth(req, res)) return;
            cancel(req.params.id);
            res.json({ success: true });
        });
    }
    return { reserve, status, cancel, acquire, identify, refresh, registerRoutes, close: () => clearInterval(timer) };
}

module.exports = { createRequestSlots, normalizeLimit };
