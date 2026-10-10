import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import type { Chat, Database, character } from '../storage/database.svelte'

export interface ChatExecutionContext {
    cacheKey: number
    characterId: string
    chatId: string
    db: Database
    resolve: () => { character: character, chat: Chat, characterIndex: number, chatIndex: number } | undefined
}

let sequence = 0
export { getExecutionContext, withExecutionContext, bindExecutionContext, lazyFunction } from './executionScope'

export function createChatExecutionContext(characterId?: string, chatId?: string): ChatExecutionContext | undefined {
    const live = DBState.db
    const char = characterId ? live.characters.find(c => c.chaId === characterId) : live.characters[get(selectedCharID)]
    const chat = chatId ? char?.chats.find(c => c.id === chatId) : char?.chats[char.chatPage]
    if (!char || !chat) return undefined
    const resolve = () => {
        const characterIndex = DBState.db.characters.findIndex(c => c.chaId === char.chaId)
        const character = DBState.db.characters[characterIndex]
        const chatIndex = character?.chats.findIndex(c => c.id === chat.id) ?? -1
        return character && chatIndex >= 0 ? { character, chat: character.chats[chatIndex], characterIndex, chatIndex } : undefined
    }
    // Copy settings once; conversations stay live for persistence and rebases.
    const settings = $state.snapshot(Object.fromEntries(Object.entries(live).filter(([key]) => key !== 'characters'))) as Database
    const facade = new Proxy(settings, {
        set(target, key, value, receiver) {
            if (key === 'statics' || key === 'toolStates' || key === 'toolPermissions') {
                DBState.db[key] = value
                return true
            }
            return Reflect.set(target, key, value, receiver)
        },
        get(target, key, receiver) {
            if (key === 'statics' || key === 'toolStates' || key === 'toolPermissions') return DBState.db[key]
            if (key !== 'characters') return Reflect.get(target, key, receiver)
            const selected = resolve()
            const characters = DBState.db.characters.map(c => c.chaId !== char.chaId ? c : new Proxy(c, {
                get(c, key, receiver) { return key === 'chatPage' ? (selected?.chatIndex ?? -1) : Reflect.get(c, key, receiver) },
                set(c, key, value) { if (key === 'chatPage') return true; return Reflect.set(c, key, value) },
            }))
            return new Proxy(characters, {
                set(array, key, value) {
                    if (/^\d+$/.test(String(key))) {
                        const index = Number(key)
                        const previous = DBState.db.characters[index]
                        if (value?.chaId === char.chaId) {
                            const target = resolve()
                            if (!target) return true
                            // A trigger may return a whole character cloned before
                            // another chat changed. Only its own chat is replaced.
                            value = {
                                ...value,
                                chatPage: target.character.chatPage,
                                chats: target.character.chats.map(chat => chat.id === target.chat.id
                                    ? value.chats.find(c => c.id === chat.id) ?? chat : chat),
                            }
                            DBState.db.characters[target.characterIndex] = value
                        } else if (previous) DBState.db.characters[index] = value
                    }
                    return Reflect.set(array, key, value)
                },
            })
        },
    })
    return { cacheKey: ++sequence, characterId: char.chaId, chatId: chat.id, db: facade, resolve }
}
