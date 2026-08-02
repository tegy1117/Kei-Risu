import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {} as any,
    requestAgentModelPreset: vi.fn(),
    startGeneration: vi.fn(),
    endGeneration: vi.fn(),
}))

vi.mock('../alert', () => ({ alertError: vi.fn() }))
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
vi.mock('../process/tts', () => ({ sayTTS: vi.fn() }))
vi.mock('../process/generationState', () => ({
    chatGenKey: (id: string) => id,
    isChatGenerating: vi.fn(() => false),
    startGeneration: mocks.startGeneration,
    endGeneration: mocks.endGeneration,
}))

import { runAgentPipeline } from './runtime'

describe('agent pipeline runtime', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.requestAgentModelPreset.mockResolvedValue({ ok: true, text: 'agent output', model: 'worker-model' })
        mocks.db = {
            agentPresets: [{
                id: 'agent-preset', name: 'Agent preset', maxParallel: 2,
                stages: [
                    { id: 'main-stage', nodes: [{ kind: 'main', id: 'main', name: 'Main Output', agentInfoBindings: {} }] },
                    { id: 'worker-stage', nodes: [{
                        kind: 'agent', id: 'worker', name: 'Agent 1', promptPresetId: 'prompt', modelPresetId: 'model',
                        usePromptPresetParams: false, post: { placement: 'append', includeInHistory: false }, agentInfoBindings: {},
                    }] },
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
                const current = mocks.db.characters[0].chats[0]
                mocks.db.characters[0].chats[0] = {
                    ...current,
                    message: [...current.message, { role: 'char', data: 'main output', generationInfo: { model: 'main-model' } }],
                }
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
})
