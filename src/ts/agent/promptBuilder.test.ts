import { describe, expect, test, vi } from 'vitest'

vi.mock('../parser/chatML', () => ({ parseChatML: () => [] }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (value: string) => value }))
vi.mock('../process/lorebook.svelte', () => ({
    loadLoreBookV3Prompt: async () => ({ actives: [] }),
}))
vi.mock('../util', () => ({ getPersonaPrompt: () => '' }))

import { buildAgentPrompt, type AgentOutputValue } from './promptBuilder'

describe('agent prompt response routing', () => {
    test('inserts only selected earlier outputs at the configured prompt position', async () => {
        const outputs = new Map<string, AgentOutputValue>([
            ['agent-a', { nodeId: 'agent-a', nodeName: 'Agent A', output: 'A response' }],
            ['agent-b', { nodeId: 'agent-b', nodeName: 'Agent B', output: 'B response' }],
            ['agent-c', { nodeId: 'agent-c', nodeName: 'Agent C', output: 'C response' }],
        ])
        const result = await buildAgentPrompt({
            node: {
                kind: 'agent', id: 'agent-d', name: 'Agent D',
                promptPresetId: 'prompt-d', modelPresetId: 'model', usePromptPresetParams: false,
                post: { placement: 'none', includeInHistory: false },
                agentInfoBindings: { 'prompt-d': { responses: ['agent-c', 'agent-a'] } },
            },
            promptPreset: {
                id: 'prompt-d',
                promptTemplate: [
                    { type: 'plain', type2: 'normal', role: 'system', text: 'Before' },
                    { type: 'agentInfo', id: 'responses', role2: 'system', innerFormat: '[{{agent_name}}] {{slot}}' },
                    { type: 'plain', type2: 'normal', role: 'system', text: 'After' },
                ],
            } as any,
            character: { firstMessage: '' } as any,
            chat: { firstMessageDisabled: false, message: [] } as any,
            outputs,
            outputOrder: new Map([['agent-a', 0], ['agent-b', 1], ['agent-c', 2]]),
        })

        expect(result.warnings).toEqual([])
        expect(result.messages.map((message) => message.content)).toEqual([
            'Before',
            '[Agent A] A response\n\n[Agent C] C response',
            'After',
        ])
        expect(result.messages.some((message) => message.content.includes('B response'))).toBe(false)
    })
})
