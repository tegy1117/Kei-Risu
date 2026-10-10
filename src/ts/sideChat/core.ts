import type { AdapterChatMessage } from '../preset/adapter/types'
import type { PromptItem } from '../process/prompt'

export type SideChatOperation =
    | { kind: 'messages', messages: AdapterChatMessage[] }
    | { kind: 'side', start: number, end: number | 'end' }
    | { kind: 'info', sources: string[], role: 'system' | 'user' | 'assistant', format: string }
    | { kind: 'cache', depth: number, role: string }

export interface SideChatSelection { modelPresetId: string, promptPresetId: string, agentPresetId: string }
export interface SideChatNodeProgram {
    id: string, name: string, kind: 'main' | 'agent', stage: number
    modelPresetId: string, promptPresetId: string, operations: SideChatOperation[]
}
export interface SideChatProgram { nodes: SideChatNodeProgram[] }
export interface SideChatMessage {
    role: 'user' | 'char', data: string, chatId: string, time: number
    displayData?: string, generationInfo?: Record<string, unknown>, agentRun?: unknown
}
export interface SideChatSession {
    id: string, name: string, characterId: string, sourceChatId: string
    source: any, selection: SideChatSelection, messages: SideChatMessage[]
    status: 'idle' | 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'aborted' | 'interrupted'
    phase?: string, error?: string, run?: any, requestId?: string
    revision: number, createdAt: number, updatedAt: number
}

export function sliceSideHistory<T>(history: T[], start: number, end: number | 'end'): T[] {
    const from = start === -1000 ? 0 : start < 0 ? Math.max(0, history.length + start) : start
    const to = end === 'end' ? history.length : end < 0 ? Math.max(0, history.length + end) : end
    return history.slice(from, Math.max(from, to))
}

export function materializeSidePrompt(operations: SideChatOperation[], history: SideChatMessage[], outputs: Map<string, { name: string, text: string }>): AdapterChatMessage[] {
    const result: AdapterChatMessage[] = []
    for (const op of operations) {
        if (op.kind === 'messages') result.push(...structuredClone(op.messages))
        if (op.kind === 'side') result.push(...sliceSideHistory(history, op.start, op.end).map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.data })))
        if (op.kind === 'info') {
            const content = op.sources.flatMap(id => {
                const value = outputs.get(id)
                return value ? [op.format.replaceAll('{{agent_name}}', value.name).replaceAll('{{slot}}', value.text)] : []
            }).join('\n\n')
            if (content) result.push({ role: op.role, content })
        }
        if (op.kind === 'cache') {
            let remaining = op.depth
            for (let i = result.length - 1; i >= 0 && remaining > 0; i--) {
                if (op.role === 'all' || result[i].role === op.role) { result[i].cachePoint = true; remaining-- }
            }
        }
    }
    return result.filter(m => m.content.trim() || m.images?.length)
}

// Only a promoted side session gets this fallback. Ordinary prompts still see
// an empty side-chat block, and stored presets are never rewritten.
export function normalChatTemplate(template: PromptItem[] | null | undefined, promoted: boolean): PromptItem[] | null | undefined {
    if (!template || !promoted || template.some(c => c.type === 'chat')) return template
    let converted = false
    return template.map(card => {
        if (card.type !== 'sideChat' || converted) return card
        converted = true
        return { ...card, type: 'chat', rangeStart: 0, rangeEnd: 'end' } as PromptItem
    })
}
