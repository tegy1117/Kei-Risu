const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const activeStatus = status => status === 'queued' || status === 'running';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);

function createSideChats({ saveDir, getDatabase, requestSlots, branch, updateLimit, runModel, materialize } = {}) {
    fs.mkdirSync(saveDir, { recursive: true });
    const db = new Database(path.join(saveDir, 'side-chats.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, session_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL)');
    const sessions = new Map(db.prepare('SELECT * FROM sessions').all().map(row => [row.id, JSON.parse(row.body)]));
    const runs = new Map();
    const listeners = new Map();
    const timers = new Map();
    let admission = Promise.resolve();
    let shutdown;
    const serializeAdmission = action => {
        const result = admission.catch(() => {}).then(() => { if (shutdown) throw failure('Server is stopping.', 503); return action(); });
        admission = result;
        return result;
    };
    const write = db.prepare('INSERT OR REPLACE INTO sessions (id, body) VALUES (?, ?)');
    const removeRow = db.prepare('DELETE FROM sessions WHERE id = ?');
    const runtime = () => require('../../dist/side-chat-runtime.cjs');
    const modelRunner = (...args) => (runModel || runtime().runSideModel)(...args);
    const buildPrompt = (...args) => (materialize || runtime().materializeSidePrompt)(...args);

    function interrupted(session, message) {
        session.status = 'interrupted'; session.phase = 'interrupted'; session.error = message;
        if (session.run) {
            session.run.status = 'interrupted'; session.run.endedAt = Date.now();
            for (const node of session.run.nodes) if (['pending', 'queued', 'running'].includes(node.status)) { node.status = 'interrupted'; node.error = message; }
        }
        save(session, true);
    }

    function save(session, immediate = false) {
        session.updatedAt = Date.now();
        if (immediate) {
            clearTimeout(timers.get(session.id)); timers.delete(session.id);
            write.run(session.id, JSON.stringify(session));
        } else if (!timers.has(session.id)) {
            timers.set(session.id, setTimeout(() => { timers.delete(session.id); write.run(session.id, JSON.stringify(session)); }, 50));
        }
        for (const notify of listeners.get(session.id) || []) notify();
    }
    for (const session of sessions.values()) {
        if (activeStatus(session.status)) interrupted(session, 'Server restarted before this request completed.');
    }
    const find = id => { const session = sessions.get(id); if (!session) throw failure('Side-chat session not found.', 404); return session; };
    const summary = session => { const { source, messages, run, ...metadata } = session; return { ...metadata, messageCount: messages.length }; };
    function erase(id) {
        const session = find(id);
        if (activeStatus(session.status)) throw failure('Stop the side chat before deleting it.', 409);
        clearTimeout(timers.get(id)); timers.delete(id);
        db.transaction(() => { removeRow.run(id); db.prepare('DELETE FROM requests WHERE session_id = ?').run(id); })();
        sessions.delete(id);
    }
    async function limit() {
        const configured = (await getDatabase()).sideChatSessionLimit;
        return Number.isSafeInteger(configured) && configured > 0 ? configured : 3;
    }
    function trim(maximum, keep = 0) {
        const candidates = [...sessions.values()].filter(s => !activeStatus(s.status)).sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt);
        if (sessions.size + keep > maximum && candidates.length < sessions.size + keep - maximum) throw failure('All side-chat slots are busy.', 409);
        while (sessions.size + keep > maximum) erase(candidates.shift().id);
    }
    async function setLimitImpl(value) {
        if (!Number.isSafeInteger(value) || value < 1) throw failure('Session limit must be a positive integer.');
        if ([...sessions.values()].filter(s => activeStatus(s.status)).length > value) throw failure('All side-chat slots are busy.', 409);
        if (updateLimit) await updateLimit(value);
        trim(value);
        return value;
    }
    const setLimit = value => serializeAdmission(() => setLimitImpl(value));
    function validateSelection(selection, settings) {
        const model = settings.modelPresets?.find(p => p.id === selection?.modelPresetId);
        const prompt = settings.botPresets?.find(p => p.id === selection?.promptPresetId);
        const agent = selection?.agentPresetId ? settings.agentPresets?.find(p => p.id === selection.agentPresetId) : null;
        if (!model || !prompt || (selection?.agentPresetId && !agent)) throw failure('The selected model, prompt or agent no longer exists.');
        return { model, prompt, agent };
    }
    function validateProgram(program, selection, settings) {
        const { agent } = validateSelection(selection, settings);
        const expected = agent ? agent.stages.flatMap((stage, stageIndex) => stage.nodes.map(node => ({ ...node, stage: stageIndex })))
            : [{ id: 'main', name: 'Main', kind: 'main', stage: 0 }];
        if (!program || !Array.isArray(program.nodes) || program.nodes.length !== expected.length) throw failure('Invalid side-chat execution plan.');
        if (expected.filter(n => n.kind === 'main').length !== 1) throw failure('An agent must contain exactly one main node.');
        return expected.map(node => {
            const prepared = program.nodes.find(n => n.id === node.id);
            const modelId = node.kind === 'main' ? selection.modelPresetId : node.modelPresetId;
            const promptId = node.kind === 'main' ? selection.promptPresetId : node.promptPresetId;
            const model = settings.modelPresets.find(p => p.id === modelId);
            const prompt = settings.botPresets.find(p => p.id === promptId);
            if (!prepared || !model || !prompt || prepared.modelPresetId !== modelId || prepared.promptPresetId !== promptId || !Array.isArray(prepared.operations)) throw failure('Side-chat presets changed. Refresh and send again.', 409);
            for (const op of prepared.operations) {
                if (!op || !['messages', 'side', 'info', 'cache'].includes(op.kind)) throw failure('Invalid side-chat prompt operation.');
                if (op.kind === 'messages' && (!Array.isArray(op.messages) || op.messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string'))) throw failure('Invalid side-chat prompt messages.');
                if (op.kind === 'side' && (!Number.isSafeInteger(op.start) || !(op.end === 'end' || Number.isSafeInteger(op.end)))) throw failure('Invalid side-chat range.');
                if (op.kind === 'info' && (!Array.isArray(op.sources) || typeof op.format !== 'string' || !['system', 'user', 'assistant'].includes(op.role))) throw failure('Invalid agent-info operation.');
                if (op.kind === 'cache' && (!Number.isSafeInteger(op.depth) || op.depth < 0)) throw failure('Invalid cache depth.');
            }
            return { ...clone(node), model: clone(model), prompt: clone(prompt), operations: clone(prepared.operations) };
        });
    }
    function applyRegex(text, scripts) {
        for (const script of scripts || []) {
            if (script.type !== 'editoutput' || !script.in) continue;
            try { text = text.replace(new RegExp(script.in, script.ableFlag ? ((script.flag || 'g').replace(/[^dgimsuvy]/g, '') || 'u') : 'g'), script.out.replaceAll('$n', '\n')); } catch { /* Match existing preset behavior. */ }
        }
        return text;
    }
    function sampling(model, prompt) {
        const values = { temperature: prompt.temperature / 100, top_p: prompt.top_p, topP: prompt.top_p, top_k: prompt.top_k, topK: prompt.top_k, frequency_penalty: prompt.frequencyPenalty / 100, presence_penalty: prompt.PresensePenalty / 100 };
        for (const field of model.profileSnapshot.schema || []) if (Number.isFinite(values[field.key]) && values[field.key] >= 0) model.userValues[field.key] = values[field.key];
    }
    async function execute(session, nodes, agent, settings, controller) {
        const generationId = session.requestId;
        const records = nodes.map(node => ({ nodeId: node.id, nodeName: node.name, kind: node.kind, stageIndex: node.stage, status: 'pending', modelPresetId: node.model.id, modelPresetName: node.model.name, promptPresetId: node.prompt.id, promptPresetName: node.prompt.name }));
        const run = session.run = { generationId, agentPresetId: agent?.id, agentPresetName: agent?.name, startedAt: Date.now(), status: 'running', nodes: records, warnings: [] };
        const outputs = new Map();
        let mainMessage, historyOutput = '', displayOutput = '';
        const place = (base, output, placement) => placement === 'none' ? base : placement === 'replace' ? output : !output ? base : !base ? output : placement === 'prepend' ? `${output}\n\n${base}` : `${base}\n\n${output}`;
        async function nodeRequest(node) {
            const record = records.find(r => r.nodeId === node.id);
            record.status = 'running'; record.startedAt = Date.now();
            let release = () => {};
            let timeout;
            let accumulated = '';
            try {
                const preset = node.model;
                if (node.kind === 'agent' && node.usePromptPresetParams) sampling(preset, node.prompt);
                let credential = preset.apiKeyRef ? { apiKey: settings.apiKeyPool?.[preset.apiKeyRef]?.key }
                    : typeof preset.inlineCredential === 'string' ? { apiKey: preset.inlineCredential } : preset.inlineCredential;
                if (!credential) {
                    const field = preset.profileSnapshot.schema?.find(f => f.mapsTo?.target === 'auth' && typeof preset.userValues?.[f.key] === 'string' && preset.userValues[f.key]);
                    if (field) credential = { apiKey: preset.userValues[field.key] };
                }
                if (preset.apiKeyRef && !credential?.apiKey) throw failure('Managed API key not found.');
                record.status = 'queued'; session.status = 'queued'; session.phase = 'queued'; save(session);
                release = await requestSlots.acquire({ apiKeyRef: preset.apiKeyRef, headers: credential?.apiKey ? { authorization: `Bearer ${credential.apiKey}` } : {}, signal: controller.signal, abort: () => controller.abort() });
                if (controller.signal.aborted) throw new Error('Request stopped.');
                record.status = 'running'; session.status = 'running'; session.phase = node.kind === 'main' ? 'responding' : 'postprocessing'; save(session);
                timeout = setTimeout(() => controller.abort(new Error('Side-chat model request timed out.')), 600000);
                const response = await modelRunner(preset, {
                    messages: buildPrompt(node.operations, session.messages, outputs), abortSignal: controller.signal,
                    roleSettings: session.source.settings,
                    collectStreamUsage: !!preset.collectStreamUsage, anthropicCache1h: !!settings.claude1HourCaching,
                }, credential, text => {
                    accumulated = text; record.output = text;
                    if (node.kind === 'main') { mainMessage.data = text; save(session); }
                });
                accumulated = applyRegex(response.text.trim(), node.prompt.regex);
                record.output = accumulated; record.status = 'done'; record.model = preset.userValues?.model || preset.name;
                record.inputTokens = response.usage?.promptTokens; record.outputTokens = response.usage?.completionTokens;
                outputs.set(node.id, { name: node.name, text: accumulated });
                return accumulated;
            } catch (error) {
                record.status = controller.signal.aborted && controller.signal.reason?.name === 'AbortError' ? 'aborted' : 'failed'; record.error = error.message;
                record.output = accumulated;
                throw error;
            } finally { clearTimeout(timeout); release(); record.endedAt = Date.now(); save(session); }
        }
        try {
            const stages = [...new Set(nodes.map(node => node.stage))].sort((a, b) => a - b);
            for (const stage of stages) {
                if (controller.signal.aborted) throw new Error('Request stopped.');
                const group = nodes.filter(node => node.stage === stage);
                const main = group.find(node => node.kind === 'main');
                if (main) {
                    if (group.length !== 1) throw failure('The main agent stage must contain only the main node.');
                    mainMessage = { role: 'char', data: '', chatId: randomUUID(), time: Date.now() };
                    session.messages.push(mainMessage);
                    // Its empty streaming placeholder must not become prompt input.
                    historyOutput = await nodeRequest(main); displayOutput = historyOutput;
                    mainMessage.data = historyOutput;
                    mainMessage.generationInfo = { generationId, model: main.model.name };
                    run.rawMainOutput = historyOutput;
                } else {
                    let next = 0;
                    const results = new Map();
                    await Promise.all(Array.from({ length: Math.min(group.length, Math.max(1, Math.min(16, agent?.maxParallel || 1))) }, async () => {
                        while (next < group.length) {
                            const node = group[next++];
                            try { results.set(node.id, await nodeRequest(node)); }
                            catch (error) { if (!mainMessage) controller.abort(error); }
                        }
                    }));
                    if (!mainMessage && records.some(r => r.stageIndex === stage && r.status !== 'done')) throw new Error('An agent stage did not complete.');
                    if (mainMessage) for (const node of group) {
                        if (!results.has(node.id)) continue;
                        const output = results.get(node.id);
                        displayOutput = place(displayOutput, output, node.post?.placement || 'none');
                        if (node.post?.includeInHistory) historyOutput = place(historyOutput, output, node.post.placement);
                    }
                    if (mainMessage) { mainMessage.data = historyOutput; mainMessage.displayData = displayOutput !== historyOutput ? displayOutput : undefined; }
                }
                save(session);
            }
            if (controller.signal.aborted) throw new Error('Request stopped.');
            session.status = records.some(r => r.status === 'failed') ? 'partial' : 'done';
        } catch (error) {
            session.status = controller.signal.aborted && controller.signal.reason?.name === 'AbortError' ? 'aborted' : 'failed'; session.error = controller.signal.reason?.name !== 'AbortError' && controller.signal.reason?.message || error.message;
        } finally {
            if (mainMessage && !mainMessage.data) session.messages = session.messages.filter(m => m !== mainMessage);
            run.status = session.status; run.endedAt = Date.now(); run.historyOutput = mainMessage?.data; run.displayOutput = mainMessage?.displayData || mainMessage?.data;
            if (agent && mainMessage?.data) mainMessage.agentRun = clone(run);
            session.phase = session.status; runs.delete(session.id); save(session, true);
        }
    }
    async function sendImpl(id, arg) {
        if (typeof arg.requestId !== 'string' || !arg.requestId || typeof arg.text !== 'string') throw failure('Request ID and text required.');
        const settings = await getDatabase();
        // Idempotency is checked again after the asynchronous settings load.
        const previous = db.prepare('SELECT session_id FROM requests WHERE id = ?').get(arg.requestId);
        if (previous) return clone(find(previous.session_id));
        let session = id ? find(id) : null;
        if (session && activeStatus(session.status)) throw failure('This side chat is already generating.', 409);
        if (session && session.revision !== arg.revision) throw failure('Side chat changed on another device. Refresh and send again.', 409);
        const selection = clone(arg.selection);
        const nodes = validateProgram(arg.program, selection, settings);
        const { agent } = validateSelection(selection, settings);
        if (!session) {
            if (!arg.source?.character?.chaId || !arg.source?.chat?.id || !Array.isArray(arg.source.chat.message)) throw failure('A complete source conversation is required.');
            if (!settings.characters.some(c => c.chaId === arg.source.character.chaId)) throw failure('Source bot no longer exists.', 404);
            const maximum = await limit();
            // Recheck after the await: another request may have occupied a slot.
            if (db.prepare('SELECT session_id FROM requests WHERE id = ?').get(arg.requestId)) return clone(find(db.prepare('SELECT session_id FROM requests WHERE id = ?').get(arg.requestId).session_id));
            trim(maximum, 1);
            session = { id: randomUUID(), name: arg.source.chat.name || arg.source.character.name, characterId: arg.source.character.chaId, sourceChatId: arg.source.chat.id, source: clone(arg.source), selection, messages: [], revision: 0, createdAt: Date.now(), updatedAt: Date.now(), status: 'idle' };
            sessions.set(session.id, session);
        }
        session.selection = selection; session.requestId = arg.requestId; session.revision++; session.status = 'queued'; session.phase = 'queued'; delete session.error;
        if (arg.text.trim()) session.messages.push({ role: 'user', data: arg.text, chatId: randomUUID(), time: Date.now() });
        db.prepare('INSERT INTO requests (id, session_id) VALUES (?, ?)').run(arg.requestId, session.id);
        save(session, true);
        const controller = new AbortController();
        const running = { controller, promise: null }; runs.set(session.id, running);
        running.promise = execute(session, nodes, clone(agent), settings, controller);
        return clone(session);
    }
    const send = (id, arg) => serializeAdmission(() => sendImpl(id, arg));
    async function promote(id, requestId) {
        if (typeof requestId !== 'string' || !requestId) throw failure('Branch request ID required.');
        const session = find(id);
        if (activeStatus(session.status)) throw failure('Wait for generation to end before branching.', 409);
        if (!session.messages.some(m => m.role === 'char' && m.data)) throw failure('A side-chat response is required before branching.');
        const result = await branch(clone(session), requestId);
        const chatId = typeof result === 'string' ? result : result.chatId;
        db.prepare('INSERT OR REPLACE INTO branches (id, chat_id) VALUES (?, ?)').run(requestId, chatId);
        return { chatId, characterId: session.characterId, ...(typeof result === 'object' ? result : {}) };
    }
    async function select(id, arg) {
        const settings = await getDatabase();
        const session = find(id);
        if (activeStatus(session.status) || session.revision !== arg.revision) throw failure('Side chat changed or is generating. Refresh and try again.', 409);
        validateSelection(arg.selection, settings);
        session.selection = clone(arg.selection); session.revision++; save(session, true);
        return clone(session);
    }
    function registerRoutes(app, { auth }) {
        const route = handler => async (req, res) => { if (!await auth(req, res)) return; try { await handler(req, res); } catch (error) { res.status(error.status || 500).json({ error: error.message }); } };
        app.get('/api/side-chats', route(async (req, res) => { trim(await limit()); res.json({ sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary), limit: await limit() }); }));
        app.post('/api/side-chats/limit', route(async (req, res) => res.json({ limit: await setLimit(req.body.limit) })));
        app.get('/api/side-chats/:id', route((req, res) => res.json(clone(find(req.params.id)))));
        app.patch('/api/side-chats/:id', route(async (req, res) => res.json(await select(req.params.id, req.body))));
        app.post('/api/side-chats', route(async (req, res) => res.json(await send(null, req.body))));
        app.post('/api/side-chats/:id/turns', route(async (req, res) => res.json(await send(req.params.id, req.body))));
        app.post('/api/side-chats/:id/stop', route((req, res) => { runs.get(req.params.id)?.controller.abort(); res.json({ success: true }); }));
        app.delete('/api/side-chats/:id', route((req, res) => { erase(req.params.id); res.json({ success: true }); }));
        app.post('/api/side-chats/:id/branch', route(async (req, res) => res.json(await promote(req.params.id, req.body.requestId))));
        app.get('/api/side-chats/:id/events', route((req, res) => {
            const session = find(req.params.id);
            res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders();
            const notify = () => { if (!res.destroyed) { const { source, ...state } = session; res.write(`data: ${JSON.stringify(state)}\n\n`); } };
            if (!listeners.has(session.id)) listeners.set(session.id, new Set());
            listeners.get(session.id).add(notify); notify();
            const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
            req.on('close', () => { clearInterval(heartbeat); listeners.get(session.id)?.delete(notify); });
        }));
    }
    function close() {
        return shutdown ||= (async () => {
            await admission.catch(() => {});
            const active = [...runs.keys()];
            for (const run of runs.values()) run.controller.abort();
            await Promise.all([...runs.values()].map(r => r.promise));
            for (const id of active) interrupted(find(id), 'Server stopped before this request completed.');
            for (const session of sessions.values()) save(session, true);
            db.close();
        })();
    }
    return { registerRoutes, send, select, promote, find, erase, setLimit, list: () => [...sessions.values()].map(summary), stop: id => runs.get(id)?.controller.abort(), wait: id => runs.get(id)?.promise, close };
}
module.exports = { createSideChats };
