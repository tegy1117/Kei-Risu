import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {} as any,
    alertError: vi.fn(),
    requestAgentModelPreset: vi.fn(),
    sayTTS: vi.fn(),
    startGeneration: vi.fn(),
    endGeneration: vi.fn(),
}))

vi.mock('../alert', () => ({ alertError: mocks.alertError }))
vi.mock('../stores.svelte', () => ({
    selectedCharID: { subscribe: (run: (value: number) => void) => { run(0); return () => {} } },
    DBState: { get db() { return mocks.db } },
}))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn(async (value: string) => value.length) }))
vi.mock('./promptBuilder', () => ({
    buildAgentPrompt: vi.fn(async () => ({ messages: [{ role: 'user', content: 'worker prompt' }], warnings: [] })),
    applyAgentPresetRegex: vi.fn((value: string) => value),
}))
vi.mock('../process/request/request', () => ({ requestAgentModelPreset: mocks.requestAgentModelPreset }))
vi.mock('../process/request/modelPresetBinding', () => ({ applyExplicitPromptPresetParams: (preset: unknown) => preset }))
vi.mock('../process/tts', () => ({ sayTTS: mocks.sayTTS }))
vi.mock('../process/generationState', () => ({
    chatGenKey: (id: string) => id,
    isChatGenerating: vi.fn(() => false),
    startGeneration: mocks.startGeneration,
    endGeneration: mocks.endGeneration,
}))

import { runAgentPipeline } from './runtime'

function mainNode() {
    return { kind: 'main' as const, id: 'main', name: 'Main Output', agentInfoBindings: {} }
}

function workerNode(id: string, options: { includeInHistory?: boolean, placement?: 'prepend' | 'append' | 'replace' | 'none' } = {}) {
    return {
        kind: 'agent' as const,
        id,
        name: id,
        promptPresetId: 'prompt',
        modelPresetId: 'model',
        usePromptPresetParams: false,
        post: {
            placement: options.placement ?? 'append',
            includeInHistory: options.includeInHistory ?? false,
        },
        agentInfoBindings: {},
    }
}

function appendMainMessage(data = 'main output') {
    const current = mocks.db.characters[0].chats[0]
    mocks.db.characters[0].chats[0] = {
        ...current,
        message: [...current.message, { role: 'char', data, generationInfo: { model: 'main-model' } }],
    }
}

describe('agent pipeline runtime', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.requestAgentModelPreset.mockResolvedValue({ ok: true, text: 'agent output', model: 'worker-model' })
        mocks.db = {
            agentPresets: [{
                id: 'agent-preset', name: 'Agent preset', maxParallel: 2,
                stages: [
                    { id: 'main-stage', nodes: [mainNode()] },
                    { id: 'worker-stage', nodes: [{ ...workerNode('worker'), name: 'Agent 1' }] },
                ],
            }],
            botPresets: [{ id: 'prompt', name: 'Prompt', bias: [], regex: [] }],
            botPresetsId: 0,
            modelPresets: [{ id: 'model', name: 'Model' }],
            characters: [{
                chaId: 'character', name: 'Character', chatPage: 0, reloadKeys: 0,
                chats: [{ id: 'chat', name: 'Chat', boundAgentPresetId: 'agent-preset', message: [{ role: 'user', data: 'hello' }] }],
            }],
            rememberToolUsage: false,
            ttsAutoSpeech: false,
            notification: false,
        }
    })

    test('continues on the current chat when the main send replaces the chat object', async () => {
        let mainGenerationId = ''
        const result = await runAgentPipeline({
            runMain: async (context) => {
                mainGenerationId = context?.generationId ?? ''
                appendMainMessage()
                return true
            },
        })

        expect(result).toBe(true)
        expect(mainGenerationId).toBeTruthy()
        expect(mocks.startGeneration).toHaveBeenCalledWith('chat', mainGenerationId)
        expect(mocks.requestAgentModelPreset).toHaveBeenCalledOnce()
        expect(mocks.requestAgentModelPreset.mock.calls[0][0]).toMatchObject({
            chatId: `${mainGenerationId}:worker`,
            requestStatus: { kind: 'agent', parentId: mainGenerationId, order: 1 },
        })
        const message = mocks.db.characters[0].chats[0].message.at(-1)
        expect(message.data).toBe('main output')
        expect(message.displayData).toBe('main output\n\nagent output')
        expect(message.agentRun).toMatchObject({
            status: 'done',
            nodes: [
                { nodeName: 'Main Output', status: 'done' },
                { nodeName: 'Agent 1', status: 'done', output: 'agent output' },
            ],
        })
    })

    test('marks one failed post worker partial while keeping successful outputs and continuing later stages', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        mocks.db.agentPresets[0].stages = [
            { id: 'main-stage', nodes: [mainNode()] },
            { id: 'post-1', nodes: [workerNode('failed-worker'), workerNode('successful-worker')] },
            { id: 'post-2', nodes: [workerNode('later-worker')] },
        ]
        mocks.requestAgentModelPreset.mockImplementation(async (arg: any) => {
            const nodeId = String(arg.chatId).split(':').at(-1)
            if(nodeId === 'failed-worker') return { ok: false, error: 'worker exploded', model: 'worker-model' }
            return { ok: true, text: `${nodeId} output`, model: 'worker-model' }
        })

        const result = await runAgentPipeline({
            runMain: async () => { appendMainMessage(); return true },
        })

        expect(result).toBe(true)
        const message = mocks.db.characters[0].chats[0].message.at(-1)
        expect(message.displayData).toBe('main output\n\nsuccessful-worker output\n\nlater-worker output')
        expect(message.agentRun).toMatchObject({
            status: 'partial',
            nodes: [
                { nodeId: 'main', status: 'done' },
                { nodeId: 'failed-worker', status: 'failed', error: 'worker exploded' },
                { nodeId: 'successful-worker', status: 'done' },
                { nodeId: 'later-worker', status: 'done' },
            ],
        })
        expect(console.warn).toHaveBeenCalledWith('[Agent] post-stage worker failures', expect.objectContaining({
            outcome: 'partial',
            failedAgents: [{ nodeId: 'failed-worker', nodeName: 'failed-worker', error: 'worker exploded' }],
        }))
    })

    test('marks multiple and all post worker failures partial while preserving the main output', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        mocks.db.agentPresets[0].stages = [
            { id: 'main-stage', nodes: [mainNode()] },
            { id: 'post', nodes: [workerNode('failed-a'), workerNode('failed-b')] },
        ]
        mocks.requestAgentModelPreset.mockImplementation(async (arg: any) => {
            const nodeId = String(arg.chatId).split(':').at(-1)
            return { ok: false, error: `${nodeId} error`, model: 'worker-model' }
        })

        const result = await runAgentPipeline({
            runMain: async () => { appendMainMessage(); return true },
        })

        expect(result).toBe(true)
        const message = mocks.db.characters[0].chats[0].message.at(-1)
        expect(message.data).toBe('main output')
        expect(message.displayData).toBeUndefined()
        expect(message.agentRun.status).toBe('partial')
        expect(message.agentRun.nodes.filter((node: any) => node.status === 'failed').map((node: any) => node.nodeName))
            .toEqual(['failed-a', 'failed-b'])
    })

    test('keeps main and required pre-stage failures fatal', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        mocks.db.agentPresets[0].stages = [
            { id: 'pre', nodes: [workerNode('required-worker')] },
            { id: 'main-stage', nodes: [mainNode()] },
        ]
        mocks.requestAgentModelPreset.mockResolvedValue({ ok: false, error: 'required failure', model: 'worker-model' })
        const runMain = vi.fn(async () => { appendMainMessage(); return true })

        await expect(runAgentPipeline({ runMain })).resolves.toBe(false)
        expect(runMain).not.toHaveBeenCalled()
        expect(mocks.alertError).toHaveBeenCalledWith('required-worker: required failure')

        mocks.db.agentPresets[0].stages = [
            { id: 'main-stage', nodes: [mainNode()] },
            { id: 'post', nodes: [workerNode('unused-worker')] },
        ]
        mocks.requestAgentModelPreset.mockClear()
        await expect(runAgentPipeline({ runMain: async () => false })).resolves.toBe(false)
        expect(mocks.requestAgentModelPreset).not.toHaveBeenCalled()
    })

    test('aborts without applying outputs from the interrupted post stage', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const abortController = new AbortController()
        mocks.db.ttsAutoSpeech = true
        mocks.db.agentPresets[0].stages = [
            { id: 'main-stage', nodes: [mainNode()] },
            { id: 'committed-post', nodes: [workerNode('committed-worker')] },
            { id: 'interrupted-post', nodes: [workerNode('late-worker')] },
        ]
        mocks.requestAgentModelPreset.mockImplementation(async (arg: any) => {
            const nodeId = String(arg.chatId).split(':').at(-1)
            if(nodeId === 'late-worker') abortController.abort()
            return { ok: true, text: `${nodeId} output`, model: 'worker-model' }
        })

        const result = await runAgentPipeline({
            signal: abortController.signal,
            runMain: async () => { appendMainMessage(); return true },
        })

        expect(result).toBe(false)
        const message = mocks.db.characters[0].chats[0].message.at(-1)
        expect(message.displayData).toBe('main output\n\ncommitted-worker output')
        expect(message.displayData).not.toContain('late-worker output')
        expect(message.agentRun.status).toBe('aborted')
        expect(mocks.sayTTS).not.toHaveBeenCalled()
    })
})
