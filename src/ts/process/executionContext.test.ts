import { afterEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
const mocks = vi.hoisted(() => ({ state: { db: {} as any } }))
vi.mock('../stores.svelte', () => ({ DBState: mocks.state, selectedCharID: writable(0) }))
import { selectedCharID } from '../stores.svelte'
import { bindExecutionContext, createChatExecutionContext, getExecutionContext, withExecutionContext } from './executionContext.svelte'

afterEach(() => selectedCharID.set(0))
function seed() {
    mocks.state.db = {
        mainPrompt: 'prompt A', globalChatVariables: { toggle_mode: 'A' }, statics: { messages: 0 },
        characters: [
            { chaId: 'alice', chatPage: 0, chats: [{ id: 'a', message: [] }, { id: 'b', message: [] }] },
            { chaId: 'bob', chatPage: 0, chats: [{ id: 'c', message: [] }] },
        ],
    }
}
describe('chat execution context', () => {
    it('keeps the originating chat and settings when another chat of the same bot is selected', () => {
        seed()
        const context = createChatExecutionContext()!
        mocks.state.db.characters[0].chatPage = 1
        mocks.state.db.mainPrompt = 'prompt B'
        mocks.state.db.globalChatVariables.toggle_mode = 'B'
        expect(context.db.characters[0].chatPage).toBe(0)
        expect(context.db.mainPrompt).toBe('prompt A')
        expect(context.db.globalChatVariables.toggle_mode).toBe('A')
        context.resolve()!.chat.message.push({ data: 'answer A' } as any)
        expect(mocks.state.db.characters[0].chats[0].message[0].data).toBe('answer A')
        expect(mocks.state.db.characters[0].chats[1].message).toEqual([])
    })

    it('does not hold a global scope over an await, and each continuation uses its own captured scope', async () => {
        seed()
        const a = createChatExecutionContext()!
        selectedCharID.set(1)
        mocks.state.db.mainPrompt = 'prompt C'
        const c = createChatExecutionContext()!
        const producer = async () => {
            const context = getExecutionContext()!
            const read = bindExecutionContext(context, () => getExecutionContext()!.db.mainPrompt)
            await Promise.resolve()
            return read()
        }
        const pendingA = withExecutionContext(a, producer)
        const pendingC = withExecutionContext(c, producer)
        expect(getExecutionContext()).toBeUndefined()
        expect(await Promise.all([pendingA, pendingC])).toEqual(['prompt A', 'prompt C'])
        expect(getExecutionContext()).toBeUndefined()
    })

    it('resolves by IDs after a database rebase and cannot address a deleted chat', () => {
        seed()
        const context = createChatExecutionContext()!
        mocks.state.db = structuredClone(mocks.state.db)
        mocks.state.db.characters.reverse()
        mocks.state.db.characters[1].chats.reverse()
        expect(context.resolve()!.characterIndex).toBe(1)
        expect(context.resolve()!.chatIndex).toBe(1)
        mocks.state.db.characters[1].chats.pop()
        expect(context.resolve()).toBeUndefined()
    })

    it('persists whole-character writes without changing the selected chat page', () => {
        seed()
        const context = createChatExecutionContext()!
        mocks.state.db.characters[0].chatPage = 1
        context.db.characters[0] = { ...context.db.characters[0], name: 'updated' } as any
        expect(mocks.state.db.characters[0].name).toBe('updated')
        expect(mocks.state.db.characters[0].chatPage).toBe(1)
        expect(context.db.characters[0].chatPage).toBe(0)
    })

    it('persists shared tool state and statistics initialized during a generation', () => {
        seed()
        const context = createChatExecutionContext()!
        context.db.toolStates = { fixture: { value: 1 } } as any
        context.db.statics = { messages: 2 } as any
        expect(mocks.state.db.toolStates.fixture.value).toBe(1)
        expect(mocks.state.db.statics.messages).toBe(2)
    })

    it('keeps concurrent changes in another chat when a trigger returns an older whole-character snapshot', () => {
        seed()
        const context = createChatExecutionContext()!
        const replacement = JSON.parse(JSON.stringify(context.db.characters[0]))
        replacement.chats[0].message.push({ data: 'answer A' })
        mocks.state.db.characters[0].chats[1].message.push({ data: 'answer B' })
        context.db.characters[0] = replacement
        expect(mocks.state.db.characters[0].chats[0].message[0].data).toBe('answer A')
        expect(mocks.state.db.characters[0].chats[1].message[0].data).toBe('answer B')
    })
})
