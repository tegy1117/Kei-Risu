import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { materializeSidePrompt } from '../../src/ts/sideChat/core'
const require = createRequire(import.meta.url)
const { createSideChats } = require('./side-chats.cjs')
const { createRequestSlots } = require('./request-slots.cjs')
const Database = require('better-sqlite3')
const resources: any[] = []
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.service.close(); resource.slots.close(); rmSync(resource.dir, { recursive: true, force: true }) } })

const source = { character: { chaId: 'bot', name: 'Bot' }, chat: { id: 'source', name: 'Source', message: [{ role: 'user', data: 'original', chatId: 'original' }], note: '', localLore: [] }, settings: { statics: { keep: 'same' } } }
function setup(runModel = async (_model, _options, _credential, onText) => { onText('answer'); return { text: 'answer' } }, extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'kei-side-test-'))
    const settings: any = { characters: [{ chaId: 'bot' }], modelPresets: [{ id: 'model', name: 'Model', profileSnapshot: { adapterKind: 'openai-compatible', schema: [] }, userValues: {}, apiKeyRef: 'key' }], botPresets: [{ id: 'prompt', name: 'Prompt' }], agentPresets: [], apiKeyPool: { key: { id: 'key', key: 'secret', maxConcurrentRequests: 1 } }, sideChatSessionLimit: 3 }
    const slots = createRequestSlots({ getPool: async () => settings.apiKeyPool })
    const service = createSideChats({ saveDir: dir, getDatabase: async () => settings, requestSlots: slots, runModel, materialize: materializeSidePrompt, branch: async () => 'new-chat', updateLimit: async value => { settings.sideChatSessionLimit = value }, ...extra })
    const fixture = { service, slots, settings, dir }; resources.push(fixture); return fixture
}
function turn(requestId = 'request', overrides = {}) {
    return { requestId, text: 'side question', source, selection: { modelPresetId: 'model', promptPresetId: 'prompt', agentPresetId: '' }, program: { nodes: [{ id: 'main', kind: 'main', stage: 0, modelPresetId: 'model', promptPresetId: 'prompt', operations: [{ kind: 'messages', messages: [{ role: 'user', content: 'frozen original' }] }, { kind: 'side', start: 0, end: 'end' }] }] }, ...overrides }
}
const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); expect(fn()).toBe(true) }

describe('server side-chat sessions', () => {
    it('checkpoints partial output as interrupted on shutdown without restarting a provider call', async () => {
        let started = false
        const fixture = setup(async (_model, options, _credentials, onText) => {
            started = true; onText('retained partial')
            await new Promise<void>(resolve => options.abortSignal.addEventListener('abort', () => resolve(), { once: true }))
            throw new Error('stopped')
        })
        const session = await fixture.service.send(null, turn())
        await until(() => started)
        await fixture.service.close()
        fixture.service = createSideChats({ saveDir: fixture.dir, getDatabase: async () => fixture.settings, requestSlots: fixture.slots })
        const restored = fixture.service.find(session.id)
        expect(restored.status).toBe('interrupted')
        expect(restored.run.status).toBe('interrupted')
        expect(restored.messages.at(-1).data).toBe('retained partial')
        expect(fixture.service.wait(session.id)).toBeUndefined()
    })
    it('keeps retained sessions when persisting a reduced limit fails', async () => {
        const { service } = setup(undefined, { updateLimit: async () => { throw new Error('disk failed') } })
        for (const request of ['one', 'two']) { const session = await service.send(null, turn(request)); await service.wait(session.id) }
        await expect(service.setLimit(1)).rejects.toThrow('disk failed')
        expect(service.list()).toHaveLength(2)
    })
    it('persists idle selection changes, rejects stale edits and uses the last selection when branching', async () => {
        let branched: any
        const { service, settings } = setup(undefined, { branch: async session => { branched = session; return 'new-chat' } })
        settings.modelPresets.push({ ...settings.modelPresets[0], id: 'second' })
        const session = await service.send(null, turn()); await service.wait(session.id)
        const selection = { ...session.selection, modelPresetId: 'second' }
        const changed = await service.select(session.id, { revision: 1, selection })
        expect(changed.revision).toBe(2)
        await expect(service.select(session.id, { revision: 1, selection })).rejects.toMatchObject({ status: 409 })
        await service.promote(session.id, 'branch')
        expect(branched.selection).toEqual(selection)
    })
    it('reports agent failures accurately and keeps the main answer when a post node fails', async () => {
        let stage = 0
        const { service, settings } = setup(async () => { if (++stage !== 2) throw new Error('provider failed'); return { text: 'main answer' } })
        const worker = { id: 'worker', name: 'Worker', kind: 'agent', modelPresetId: 'model', promptPresetId: 'prompt', post: { placement: 'append', includeInHistory: true } }
        const arg = turn('pre-fails'); arg.selection.agentPresetId = 'agent'
        settings.agentPresets = [{ id: 'agent', name: 'Agent', stages: [{ nodes: [worker] }, { nodes: [{ id: 'main', kind: 'main' }] }] }]
        arg.program.nodes = ['worker', 'main'].map((id, stage) => ({ ...arg.program.nodes[0], id, stage }))
        const failed = await service.send(null, arg); await service.wait(failed.id)
        expect(service.find(failed.id).status).toBe('failed')
        expect(stage).toBe(1)
        settings.agentPresets[0].stages.reverse()
        arg.program.nodes.reverse().forEach((node, index) => { node.stage = index })
        arg.requestId = 'post-fails'
        const partial = await service.send(null, arg); await service.wait(partial.id)
        expect(service.find(partial.id).status).toBe('partial')
        expect(service.find(partial.id).messages.at(-1).data).toBe('main answer')
    })
    it('stores side turns independently and freezes the original context across continued turns', async () => {
        const prompts: any[] = []
        const { service } = setup(async (_m, options, _c, text) => { prompts.push(options.messages); text('answer'); return { text: 'answer' } })
        const original = structuredClone(source)
        const session = await service.send(null, turn())
        await service.wait(session.id)
        expect(source).toEqual(original)
        expect(service.find(session.id).status).toBe('done')
        const second = await service.send(session.id, turn('second', { revision: 1, text: 'follow up', source: { ...source, chat: { ...source.chat, message: [] } } }))
        await service.wait(second.id)
        expect(prompts[1].map(m => m.content)).toEqual(['frozen original', 'side question', 'answer', 'follow up'])
        expect(service.find(session.id).source).toEqual(original)
    })
    it('is idempotent under concurrent create retries and guards an existing busy session', async () => {
        let calls = 0
        const { service, settings } = setup(async (_m, options, _c, text) => { calls++; await new Promise<void>(r => options.abortSignal.addEventListener('abort', () => r(), { once: true })); text('partial'); return { text: 'partial' } })
        settings.sideChatSessionLimit = 1
        const [a, b] = await Promise.all([service.send(null, turn()), service.send(null, turn())])
        expect(a.id).toBe(b.id); expect(service.list()).toHaveLength(1)
        await until(() => calls === 1)
        await expect(service.send(a.id, turn('another', { revision: 1 }))).rejects.toMatchObject({ status: 409 })
        service.stop(a.id); await service.wait(a.id)
        expect(calls).toBe(1)
    })
    it('evicts the oldest inactive session and protects queued/running work when changing limits', async () => {
        const { service, settings, slots } = setup()
        for (let i = 0; i < 3; i++) { const s = await service.send(null, turn('r' + i)); await service.wait(s.id); service.find(s.id).updatedAt = i }
        const oldest = service.list().sort((a, b) => a.updatedAt - b.updatedAt)[0].id
        const next = await service.send(null, turn('four')); await service.wait(next.id)
        expect(service.list()).toHaveLength(3); expect(() => service.find(oldest)).toThrow('not found')
        await service.setLimit(1); expect(service.list()).toHaveLength(1)
        const release = await slots.acquire({ apiKeyRef: 'key' })
        settings.sideChatSessionLimit = 2
        const a = await service.send(null, turn('busy-a')); const b = await service.send(null, turn('busy-b'))
        await expect(service.setLimit(1)).rejects.toMatchObject({ status: 409 })
        expect(() => service.erase(a.id)).toThrow('Stop')
        await expect(service.send(null, turn('overflow'))).rejects.toMatchObject({ status: 409 })
        service.stop(a.id); service.stop(b.id); release(); await Promise.all([service.wait(a.id), service.wait(b.id)])
    })
    it('shares FIFO slots with ordinary requests and cancels queued work without calling a model', async () => {
        const calls: string[] = []
        const { service, slots } = setup(async (_m, options) => { calls.push(options.messages.at(-1).content); return { text: 'response' } })
        const release = await slots.acquire({ apiKeyRef: 'key' })
        const a = await service.send(null, turn('a', { text: 'first' }))
        const b = await service.send(null, turn('b', { text: 'second' }))
        service.stop(b.id); await service.wait(b.id)
        expect(calls).toEqual([])
        release(); await service.wait(a.id)
        expect(calls).toEqual(['first']); expect(service.find(b.id).status).toBe('aborted')
    })
    it('finishes every agent stage without a client and preserves postprocessing semantics', async () => {
        const calls: any[] = []
        const { service, settings } = setup(async (_m, options) => { calls.push(options.messages); return { text: 'stage ' + calls.length } })
        const worker = { id: 'pre', name: 'Pre', kind: 'agent', modelPresetId: 'model', promptPresetId: 'prompt', post: { placement: 'none', includeInHistory: false } }
        settings.agentPresets = [{ id: 'agent', name: 'Pipeline', maxParallel: 2, stages: [{ nodes: [worker] }, { nodes: [{ id: 'main', name: 'Main', kind: 'main' }] }, { nodes: [{ ...worker, id: 'post', name: 'Post', post: { placement: 'append', includeInHistory: false } }] }] }]
        const arg = turn('pipeline'); arg.selection.agentPresetId = 'agent'
        arg.program.nodes = ['pre', 'main', 'post'].map((id, stage) => ({ ...arg.program.nodes[0], id, stage, operations: [{ kind: 'side', start: 0, end: 'end' }, ...(id === 'main' ? [{ kind: 'info', sources: ['pre'], role: 'system', format: '{{slot}}' }] : [])] })) as any
        const session = await service.send(null, arg); await service.wait(session.id)
        expect(calls).toHaveLength(3); expect(calls[1].at(-1).content).toBe('stage 1')
        expect(calls[2].at(-1).content).toBe('stage 2')
        const answer = service.find(session.id).messages.at(-1)
        expect(answer.data).toBe('stage 2'); expect(answer.displayData).toBe('stage 2\n\nstage 3')
        expect(answer.agentRun.nodes.every(n => n.status === 'done')).toBe(true)
    })
    it('restores retained answers and marks interrupted work after a server restart', async () => {
        const fixture = setup(); const { service, dir, settings, slots } = fixture
        const result = await service.send(null, turn()); await service.wait(result.id); await service.close()
        const stored = new Database(join(dir, 'side-chats.db'))
        const body = JSON.parse(stored.prepare('SELECT body FROM sessions').get().body); body.status = 'running'
        stored.prepare('UPDATE sessions SET body = ?').run(JSON.stringify(body)); stored.close()
        const reopened = createSideChats({ saveDir: dir, getDatabase: async () => settings, requestSlots: slots })
        fixture.service = reopened
        expect(reopened.find(result.id).status).toBe('interrupted')
        expect(reopened.find(result.id).messages.at(-1).data).toBe('answer')
    })
    it('rejects stale revisions and allows branching only after a response is retained', async () => {
        const { service } = setup()
        const session = await service.send(null, turn()); await service.wait(session.id)
        await expect(service.send(session.id, turn('stale', { revision: 0 }))).rejects.toMatchObject({ status: 409 })
        expect(await service.promote(session.id, 'branch')).toMatchObject({ chatId: 'new-chat', characterId: 'bot' })
        expect(service.find(session.id).messages.at(-1).data).toBe('answer')
    })
})
