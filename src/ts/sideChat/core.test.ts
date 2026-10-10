import { describe, expect, it } from 'vitest'
import { materializeSidePrompt, normalChatTemplate, sliceSideHistory } from './core'
import type { PromptItem } from '../process/prompt'

describe('side-chat prompt separation', () => {
    it('keeps source messages and side history in independently ranged blocks', () => {
        const operations = [{ kind: 'messages' as const, messages: [{ role: 'assistant' as const, content: 'frozen source' }] }, { kind: 'side' as const, start: -1, end: 'end' as const }]
        const history = [{ role: 'user' as const, data: 'older', chatId: 'a', time: 1 }, { role: 'char' as const, data: 'side reply', chatId: 'b', time: 2 }]
        expect(materializeSidePrompt(operations, history, new Map())).toEqual([{ role: 'assistant', content: 'frozen source' }, { role: 'assistant', content: 'side reply' }])
        expect(operations[0].messages[0].content).toBe('frozen source')
        expect(sliceSideHistory(history, -1000, -1)).toEqual([history[0]])
    })
    it('resolves agent information after preceding stages complete, without reparsing output', () => {
        expect(materializeSidePrompt([{ kind: 'info', sources: ['worker'], role: 'system', format: '{{agent_name}}: {{slot}}' }], [], new Map([['worker', { name: 'Review', text: '{{getvar::untouched}}' }]]))).toEqual([{ role: 'system', content: 'Review: {{getvar::untouched}}' }])
    })
    it('promoted side-only prompts read normal history once while ordinary prompts stay unchanged', () => {
        const template: PromptItem[] = [{ type: 'sideChat', rangeStart: -1, rangeEnd: 'end' }, { type: 'sideChat', rangeStart: 0, rangeEnd: 2 }]
        expect(normalChatTemplate(template, false)).toBe(template)
        const converted = normalChatTemplate(template, true)
        expect(converted.filter(c => c.type === 'chat')).toHaveLength(1)
        expect(converted[0]).toEqual({ type: 'chat', rangeStart: 0, rangeEnd: 'end' })
        expect(template[0].type).toBe('sideChat')
        const withChat: PromptItem[] = [{ type: 'chat', rangeStart: 0, rangeEnd: 'end' }, ...template]
        expect(normalChatTemplate(withChat, true)).toBe(withChat)
    })
})
