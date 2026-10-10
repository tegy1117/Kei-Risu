import { getExecutionContext } from '../process/executionScope'
import { get } from 'svelte/store'
import { DBState as liveDBState, selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'

export function getChatVar(key:string): string {
    const context = getExecutionContext()
    if (context && !context.resolve()) return 'null'
    const selectedChar = context?.resolve()?.characterIndex ?? get(selectedCharID)
    const DBState = { db: context?.db ?? liveDBState.db }
    const char = DBState.db.characters[selectedChar]
    if(!char){
        return 'null'
    }
    const chat = char.chats[char.chatPage]
    chat.scriptstate ??= {}
    const state = (chat.scriptstate['$' + key])
    if(state === undefined || state === null){
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(DBState.db.templateDefaultVariables))
        const findResult = defaultVariables.find((f) => {
            return f[0] === key
        })
        if(findResult){
            return findResult[1]
        }
        return 'null'
    }
    return state.toString()
}

export function setChatVar(key:string, value:string): boolean {
    const context = getExecutionContext()
    if (context && !context.resolve()) return false
    const selectedChar = context?.resolve()?.characterIndex ?? get(selectedCharID)
    const DBState = { db: context?.db ?? liveDBState.db }
    const chat = DBState.db.characters[selectedChar].chats[DBState.db.characters[selectedChar].chatPage]
    chat.scriptstate ??= {}

    const stateKey = '$' + key
    if(chat.scriptstate[stateKey] === value){
        return false
    }

    chat.scriptstate[stateKey] = value
    return true
}

export function getGlobalChatVar(key:string): string {
    return (getExecutionContext()?.db ?? liveDBState.db).globalChatVariables[key] ?? 'null'
}
