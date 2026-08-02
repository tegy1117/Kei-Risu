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
    execution?: ToolFunctionExecution
    presentation?: ToolFunctionPresentation
}

export type ToolCallableRef =
    | { kind: 'managed', toolId: string, functionId: string }
    | { kind: 'external', name: string }

export interface ToolFunctionPresentation {
    pendingTemplate?: string
    successTemplate?: string
    errorTemplate?: string
}

export type ToolAgentRouteOutcome = 'success' | 'error'

export type ToolAgentStateAction =
    | { id: string, kind: 'setVariable', name: string, valueTemplate: string }
    | { id: string, kind: 'appendList', name: string, valueTemplate: string }
    | { id: string, kind: 'replaceList', name: string, valueTemplate: string }
    | {
        id: string
        kind: 'upsertMemory'
        scope: ToolScope
        memoryIdTemplate?: string
        titleTemplate: string
        contentTemplate: string
        tagsTemplate?: string
        importanceTemplate?: string
    }

export interface ToolAgentOutputRoute {
    id: string
    name: string
    pattern: string
    flags?: string
    outcome: ToolAgentRouteOutcome
    modelTemplate: string
    cardTemplate?: string
    actions: ToolAgentStateAction[]
}

export interface ToolAgentExecution {
    kind: 'agent'
    modelPresetId: string
    systemPrompt: string
    userPrompt: string
    allowedTools: ToolCallableRef[]
    outputRoutes: ToolAgentOutputRoute[]
}

export type ToolFunctionExecution = { kind: 'script' } | ToolAgentExecution

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
    builtinId?: 'question' | 'localtime' | 'memory' | 'dice'
    readonly?: boolean
    functions: RisuToolFunction[]
    variables: RisuToolVariable[]
    lists: RisuToolList[]
    customToggle?: string
    backgroundEmbedding?: string
    regex?: import('src/ts/storage/database.svelte').customscript[]
    trigger?: import('src/ts/storage/database.svelte').triggerscript[]
    assets?: [string, string, string][]
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

export interface RisuToolExportAssetV2 {
    name: string
    extension: string
    data: string
}

export interface RisuToolExportV2 {
    type: 'risuTool'
    version: 2
    tool: RisuToolPackage
    state?: ToolPackageState
    assets: RisuToolExportAssetV2[]
}

export const emptyToolPromptPolicy = (): ToolPromptPolicy => ({
    tools: {},
    functions: {},
})
