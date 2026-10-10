import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { buildAgentPrompt } from '../agent/promptBuilder'
import { validateAgentPreset } from '../agent/pipeline'
import { bindExecutionContext, type ChatExecutionContext } from '../process/executionScope'
import { createChatExecutionContext } from '../process/executionContext.svelte'
import type { PromptItem } from '../process/prompt'
import type { Database, Chat, character } from '../storage/database.svelte'
import type { AgentPipelineNode } from '../agent/types'
import type { SideChatSelection, SideChatProgram, SideChatOperation } from './core'

export function selectedSideOrigin() {
    const char = DBState.db.characters[get(selectedCharID)]
    return char?.chats[char.chatPage]?.id ? { characterId: char.chaId, chatId: char.chats[char.chatPage].id } : null
}

export function snapshotSideOrigin(characterId: string, chatId: string) {
    const execution = createChatExecutionContext(characterId, chatId)
    const origin = execution?.resolve()
    if (!origin || origin.chat._placeholder) throw new Error('Open the source conversation and wait for it to load.')
    // The facade is copied first, so CBS/lore evaluation can only write into this
    // private snapshot. Credentials and unrelated chats are not retained.
    const settings = $state.snapshot(Object.fromEntries(Object.entries(execution.db).filter(([key]) =>
        !['characters', 'apiKeyPool', 'modelPresets', 'botPresets', 'agentPresets', 'pluginStorage'].includes(key)
        && !/key|token|password|credential/i.test(key))))
    const character = $state.snapshot({ ...origin.character, chats: [], chatPage: 0 })
    const chat = $state.snapshot(origin.chat)
    return { settings, character, chat }
}

export async function prepareSideProgram(source: ReturnType<typeof snapshotSideOrigin>, selection: SideChatSelection): Promise<SideChatProgram> {
    const live = DBState.db
    const model = live.modelPresets.find(p => p.id === selection.modelPresetId)
    const prompt = live.botPresets.find(p => p.id === selection.promptPresetId)
    const agent = selection.agentPresetId ? live.agentPresets.find(p => p.id === selection.agentPresetId) : null
    if (!model || !prompt || (selection.agentPresetId && !agent)) throw new Error('Choose a model and prompt preset.')
    if (agent) {
        const valid = validateAgentPreset(agent, { modelPresetIds: new Set(live.modelPresets.map(p => p.id)), promptPresetIds: new Set(live.botPresets.map(p => p.id)) })
        if (valid.errors.length) throw new Error(valid.errors.join('\n'))
    }
    const isolated = structuredClone(source)
    const character = { ...isolated.character, chats: [isolated.chat], chatPage: 0 } as character
    const chat = isolated.chat as Chat
    const db = { ...isolated.settings, characters: [character], botPresets: $state.snapshot(live.botPresets), agentPresets: $state.snapshot(live.agentPresets), modelPresets: [], apiKeyPool: {} } as Database
    const context: ChatExecutionContext = { cacheKey: -Date.now(), characterId: character.chaId, chatId: chat.id, db, resolve: () => ({ character, chat, characterIndex: 0, chatIndex: 0 }) }
    const build = bindExecutionContext(context, buildAgentPrompt)
    const nodes = agent ? agent.stages.flatMap((stage, stageIndex) => stage.nodes.map(node => ({ node: $state.snapshot(node), stage: stageIndex })))
        : [{ node: { id: 'main', name: 'Main', kind: 'main', agentInfoBindings: {} } as AgentPipelineNode, stage: 0 }]
    const program: SideChatProgram = { nodes: [] }
    for (const { node, stage } of nodes) {
        const promptId = node.kind === 'main' ? selection.promptPresetId : node.promptPresetId
        const modelId = node.kind === 'main' ? selection.modelPresetId : node.modelPresetId
        const preset = $state.snapshot(live.botPresets.find(p => p.id === promptId))
        if (!preset) throw new Error('Agent prompt preset no longer exists.')
        const cards = preset.promptTemplate ?? ([
            { type: 'plain', type2: 'main', role: 'system', text: preset.mainPrompt || '' },
            { type: 'description' }, { type: 'persona' }, { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
            { type: 'lorebook' }, { type: 'plain', type2: 'globalNote', role: 'system', text: preset.globalNote || '' },
            { type: 'jailbreak', type2: 'normal', role: 'system', text: preset.jailbreak || '' },
        ] satisfies PromptItem[])
        const operations: SideChatOperation[] = []
        for (const card of cards) {
            if (card.type === 'sideChat') operations.push({ kind: 'side', start: card.rangeStart ?? 0, end: card.rangeEnd ?? 'end' })
            else if (card.type === 'agentInfo') {
                const order = agent?.stages.flatMap(s => s.nodes).map(n => n.id) || []
                const sources = [...(node.agentInfoBindings?.[promptId]?.[card.id] || [])].sort((a, b) => order.indexOf(a) - order.indexOf(b))
                operations.push({ kind: 'info', sources, role: card.role2 === 'user' ? 'user' : card.role2 === 'bot' ? 'assistant' : 'system', format: card.innerFormat ?? '<AgentInfo name="{{agent_name}}">\n{{slot}}\n</AgentInfo>' })
            } else if (card.type === 'cache') operations.push({ kind: 'cache', depth: card.depth, role: card.role })
            else {
                const built = await build({ node, promptPreset: { ...preset, promptTemplate: [card] }, character, chat, outputs: new Map() })
                operations.push({ kind: 'messages', messages: built.messages.filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })) })
            }
        }
        if (!cards.some(card => card.type === 'sideChat')) operations.push({ kind: 'side', start: 0, end: 'end' })
        program.nodes.push({ id: node.id, name: node.name, kind: node.kind, stage, modelPresetId: modelId, promptPresetId: promptId, operations })
    }
    return program
}
