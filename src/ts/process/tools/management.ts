import { getCurrentCharacter, getCurrentChat, getDatabase } from 'src/ts/storage/database.svelte'
import type { RisuToolPackage, ToolPolicyValue } from './types'
import { toolWireName, unloadToolRuntime } from './tools'

export type ToolActivationScope = 'global' | 'character' | 'chat'

export interface ToolActivationState {
    global: boolean
    character: boolean
    chat: boolean
}

export interface ToolPromptPolicyState {
    tool: ToolPolicyValue
    functions: Array<{
        id: string
        name: string
        wireName: string
        policy: ToolPolicyValue
    }>
}

export function getToolActivation(toolId: string): ToolActivationState {
    const db = getDatabase()
    return {
        global: (db.enabledTools ?? []).includes(toolId),
        character: (getCurrentCharacter()?.tools ?? []).includes(toolId),
        chat: (getCurrentChat()?.tools ?? []).includes(toolId),
    }
}

export function setToolActivation(toolId: string, scope: ToolActivationScope, enabled: boolean) {
    const db = getDatabase()
    if (!(db.tools ?? []).some((tool) => tool.id === toolId)) throw new Error(`Tool with ID ${toolId} not found.`)

    if (scope === 'global') {
        const ids = new Set(db.enabledTools ?? [])
        if (enabled) ids.add(toolId)
        else ids.delete(toolId)
        db.enabledTools = [...ids]
        return
    }

    const character = getCurrentCharacter()
    if (!character) throw new Error('No current character is selected.')
    if (scope === 'character') {
        const ids = new Set(character.tools ?? [])
        if (enabled) ids.add(toolId)
        else ids.delete(toolId)
        character.tools = [...ids]
        return
    }

    const chat = getCurrentChat()
    if (!chat) throw new Error('No current chat is selected.')
    const ids = new Set(chat.tools ?? [])
    if (enabled) ids.add(toolId)
    else ids.delete(toolId)
    chat.tools = [...ids]
}

export function getToolPromptPolicy(tool: RisuToolPackage): ToolPromptPolicyState {
    const policy = getDatabase().toolPolicy ?? { tools: {}, functions: {} }
    return {
        tool: policy.tools[tool.namespace] ?? 'inherit',
        functions: tool.functions.map((fn) => {
            const wireName = toolWireName(tool.namespace, fn.name)
            return { id: fn.id, name: fn.name, wireName, policy: policy.functions[wireName] ?? 'inherit' }
        }),
    }
}

export function setToolPromptPolicy(
    tool: RisuToolPackage,
    level: 'tool' | 'function',
    value: ToolPolicyValue,
    functionId?: string,
) {
    const db = getDatabase()
    if (!(db.tools ?? []).some((item) => item.id === tool.id)) throw new Error(`Tool with ID ${tool.id} not found.`)
    db.toolPolicy ??= { tools: {}, functions: {} }
    if (level === 'tool') {
        if (value === 'inherit') delete db.toolPolicy.tools[tool.namespace]
        else db.toolPolicy.tools[tool.namespace] = value
    } else {
        const fn = tool.functions.find((item) => item.id === functionId)
        if (!fn) throw new Error(`Function ${functionId || '(empty)'} not found.`)
        const wireName = toolWireName(tool.namespace, fn.name)
        if (value === 'inherit') delete db.toolPolicy.functions[wireName]
        else db.toolPolicy.functions[wireName] = value
    }
    db.toolPolicy = db.toolPolicy
}

function migratePolicy(previous: RisuToolPackage, next: RisuToolPackage) {
    const db = getDatabase()
    db.toolPolicy ??= { tools: {}, functions: {} }
    const policy = db.toolPolicy
    if (previous.namespace !== next.namespace && policy.tools[previous.namespace] !== undefined) {
        policy.tools[next.namespace] = policy.tools[previous.namespace]
        delete policy.tools[previous.namespace]
    }

    const nextById = new Map(next.functions.map((fn) => [fn.id, fn]))
    for (const oldFn of previous.functions) {
        const oldWire = toolWireName(previous.namespace, oldFn.name)
        const nextFn = nextById.get(oldFn.id)
        const newWire = nextFn ? toolWireName(next.namespace, nextFn.name) : ''
        const value = policy.functions[oldWire] as ToolPolicyValue | undefined
        if (value !== undefined && newWire && newWire !== oldWire) policy.functions[newWire] = value
        if (!newWire || newWire !== oldWire) delete policy.functions[oldWire]
    }
    db.toolPolicy = policy
}

export function createManagedToolPackage(tool: RisuToolPackage) {
    const db = getDatabase()
    db.tools ??= []
    if (db.tools.some((item) => item.id === tool.id)) throw new Error(`Tool with ID ${tool.id} already exists.`)
    db.tools.push(tool)
    db.tools = db.tools
}

export function replaceManagedToolPackage(previous: RisuToolPackage, next: RisuToolPackage) {
    if (previous.readonly || previous.builtinId) throw new Error('Built-in tools cannot be edited directly.')
    const db = getDatabase()
    const index = db.tools.findIndex((tool) => tool.id === previous.id)
    if (index < 0) throw new Error(`Tool with ID ${previous.id} not found.`)
    if (next.id !== previous.id) throw new Error('Tool ID cannot be changed.')

    unloadToolRuntime(previous.id)
    db.toolPermissions ??= {}
    if (previous.plugin.source !== next.plugin.source) delete db.toolPermissions[previous.id]
    migratePolicy(previous, next)
    db.tools[index] = next
    db.tools = db.tools
}

export function deleteManagedToolPackage(toolId: string) {
    const db = getDatabase()
    const tool = db.tools.find((item) => item.id === toolId)
    if (!tool) throw new Error(`Tool with ID ${toolId} not found.`)
    if (tool.readonly || tool.builtinId) throw new Error('Built-in tools cannot be deleted.')

    unloadToolRuntime(toolId)
    db.toolStates ??= {}
    db.toolPermissions ??= {}
    db.toolPolicy ??= { tools: {}, functions: {} }
    db.enabledTools = (db.enabledTools ?? []).filter((id) => id !== toolId)
    for (const character of db.characters ?? []) {
        character.tools = (character.tools ?? []).filter((id) => id !== toolId)
        for (const chat of character.chats ?? []) chat.tools = (chat.tools ?? []).filter((id) => id !== toolId)
    }
    delete db.toolStates[toolId]
    delete db.toolPermissions[toolId]
    delete db.toolPolicy.tools[tool.namespace]
    for (const fn of tool.functions) delete db.toolPolicy.functions[toolWireName(tool.namespace, fn.name)]
    db.tools = db.tools.filter((item) => item.id !== toolId)
}
