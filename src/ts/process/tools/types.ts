export type ToolScope = 'global' | 'character' | 'chat'
export type ToolPolicyValue = 'inherit' | 'on' | 'off'
export type ToolValueType = 'string' | 'number' | 'boolean' | 'json'
export type ToolParameterType = ToolValueType | 'integer' | 'string[]' | 'number[]'

export interface RisuToolParameter {
    id: string
    name: string
    description: string
    type: ToolParameterType
    required?: boolean
    enum?: string[]
}

export interface RisuToolFunction {
    id: string
    name: string
    description: string
    enabled: boolean
    parameters: RisuToolParameter[]
}

export interface RisuToolVariable {
    id: string
    name: string
    description: string
    type: ToolValueType
    scope: ToolScope
    defaultValue: unknown
}

export interface RisuToolList {
    id: string
    name: string
    description: string
    itemType: ToolValueType
    scope: ToolScope
    defaultItems: unknown[]
}

export type ToolPermission = 'askUser' | 'network' | 'database'

export interface RisuToolPackage {
    id: string
    name: string
    description: string
    namespace: string
    version: string
    builtinId?: 'question' | 'localtime' | 'memory'
    readonly?: boolean
    functions: RisuToolFunction[]
    variables: RisuToolVariable[]
    lists: RisuToolList[]
    plugin: {
        language: 'javascript' | 'typescript'
        source: string
        permissions: ToolPermission[]
    }
}

export interface ToolPromptPolicy {
    tools: Record<string, ToolPolicyValue>
    functions: Record<string, ToolPolicyValue>
}

export interface ToolMemoryEntry {
    id: string
    title: string
    content: string
    tags: string[]
    importance: number
    createdAt: number
    updatedAt: number
}

export interface ToolScopeState {
    variables: Record<string, unknown>
    lists: Record<string, unknown[]>
    memories?: ToolMemoryEntry[]
}

export interface ToolPackageState {
    global?: ToolScopeState
    characters?: Record<string, ToolScopeState>
    chats?: Record<string, ToolScopeState>
}

export type ToolStateStore = Record<string, ToolPackageState>

export interface RisuToolExportV1 {
    type: 'risuTool'
    version: 1
    tool: RisuToolPackage
    state?: ToolPackageState
}

export const emptyToolPromptPolicy = (): ToolPromptPolicy => ({
    tools: {},
    functions: {},
})
