import { alertConfirm, alertInput, alertSelect, notifyError, notifySuccess } from 'src/ts/alert'
import { language } from 'src/lang'
import { downloadFile, fetchNative, type FetchNativeArgs } from 'src/ts/globalApi.svelte'
import { pluginCodeTranspiler } from 'src/ts/plugins/apiV3/transpiler'
import { SandboxHost } from 'src/ts/plugins/apiV3/factory'
import { getCurrentCharacter, getCurrentChat, getDatabase, setDatabase } from 'src/ts/storage/database.svelte'
import { hasher } from 'src/ts/parser/parser.svelte'
import { safeStructuredClone } from 'src/ts/polyfill'
import { selectSingleFile } from 'src/ts/util'
import { v4 } from 'uuid'
import type { MCPTool, RPCToolCallContent } from '../mcp/mcplib'
import type {
    RisuToolExportV1,
    RisuToolFunction,
    RisuToolPackage,
    ToolMemoryEntry,
    ToolPackageState,
    ToolPermission,
    ToolPolicyValue,
    ToolPromptPolicy,
    ToolScope,
    ToolScopeState,
    ToolStateStore,
} from './types'

const namespacePattern = /^[A-Za-z0-9_-]+$/
const functionPattern = /^[A-Za-z0-9_-]+$/

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>
type ToolRuntime = {
    source: string
    host: SandboxHost
    handlers: Map<string, ToolHandler>
}

const runtimes = new Map<string, ToolRuntime>()

export function toolWireName(namespace: string, functionName: string) {
    return `${namespace}__${functionName}`
}

export function validateToolPackage(tool: RisuToolPackage, allTools: RisuToolPackage[] = []): string[] {
    const errors: string[] = []
    const allowedPermissions: ToolPermission[] = ['askUser', 'network', 'database']
    if (!tool.name?.trim()) errors.push('Tool name is required.')
    if (!namespacePattern.test(tool.namespace ?? '')) errors.push('Namespace may contain only letters, numbers, _ and -.')
    if (allTools.some((other) => other.id !== tool.id && other.namespace === tool.namespace)) {
        errors.push(`Namespace "${tool.namespace}" is already in use.`)
    }
    if (tool.plugin?.language !== 'javascript' && tool.plugin?.language !== 'typescript') errors.push('Plugin language must be JavaScript or TypeScript.')
    if (typeof tool.plugin?.source !== 'string') errors.push('Plugin source must be text.')
    for (const permission of tool.plugin?.permissions ?? []) {
        if (!allowedPermissions.includes(permission)) errors.push(`Unknown permission: ${permission}`)
    }
    const names = new Set<string>()
    for (const fn of tool.functions ?? []) {
        if (!functionPattern.test(fn.name ?? '')) errors.push(`Invalid function name: ${fn.name || '(empty)'}`)
        if (names.has(fn.name)) errors.push(`Duplicate function name: ${fn.name}`)
        names.add(fn.name)
        const params = new Set<string>()
        for (const param of fn.parameters ?? []) {
            if (!functionPattern.test(param.name ?? '')) errors.push(`Invalid parameter name: ${param.name || '(empty)'}`)
            if (params.has(param.name)) errors.push(`Duplicate parameter in ${fn.name}: ${param.name}`)
            params.add(param.name)
        }
    }
    const variableNames = new Set<string>()
    for (const variable of tool.variables ?? []) {
        if (!functionPattern.test(variable.name ?? '')) errors.push(`Invalid variable name: ${variable.name || '(empty)'}`)
        if (variableNames.has(variable.name)) errors.push(`Duplicate variable name: ${variable.name}`)
        variableNames.add(variable.name)
        if (!valueMatchesType(variable.defaultValue, variable.type)) errors.push(`Invalid default value for variable ${variable.name}.`)
    }
    const listNames = new Set<string>()
    for (const list of tool.lists ?? []) {
        if (!functionPattern.test(list.name ?? '')) errors.push(`Invalid list name: ${list.name || '(empty)'}`)
        if (listNames.has(list.name)) errors.push(`Duplicate list name: ${list.name}`)
        listNames.add(list.name)
        if (!Array.isArray(list.defaultItems) || !list.defaultItems.every((item) => valueMatchesType(item, list.itemType))) {
            errors.push(`Invalid default items for list ${list.name}.`)
        }
    }
    return errors
}

function normalizePolicy(policy?: ToolPromptPolicy): ToolPromptPolicy {
    return {
        tools: policy?.tools && typeof policy.tools === 'object' ? policy.tools : {},
        functions: policy?.functions && typeof policy.functions === 'object' ? policy.functions : {},
    }
}

function packagePolicy(tool: RisuToolPackage, policy: ToolPromptPolicy): ToolPolicyValue {
    return policy.tools[tool.namespace] ?? 'inherit'
}

function functionEnabled(tool: RisuToolPackage, fn: RisuToolFunction, policy: ToolPromptPolicy) {
    const value = policy.functions[toolWireName(tool.namespace, fn.name)] ?? 'inherit'
    return value === 'on' || (value === 'inherit' && fn.enabled !== false)
}

export function getActiveToolPackages(): Array<{ tool: RisuToolPackage, functions: RisuToolFunction[] }> {
    const db = getDatabase()
    const character = getCurrentCharacter()
    const chat = getCurrentChat()
    const activeIds = new Set([
        ...(db.enabledTools ?? []),
        ...(character?.tools ?? []),
        ...(chat?.tools ?? []),
    ])
    return resolveActiveToolPackages(db.tools ?? [], activeIds, db.toolPolicy)
}

export function resolveActiveToolPackages(
    tools: RisuToolPackage[],
    activeIds: Iterable<string>,
    rawPolicy?: ToolPromptPolicy,
): Array<{ tool: RisuToolPackage, functions: RisuToolFunction[] }> {
    const activeIdSet = activeIds instanceof Set ? activeIds : new Set(activeIds)
    const policy = normalizePolicy(rawPolicy)
    const result: Array<{ tool: RisuToolPackage, functions: RisuToolFunction[] }> = []
    for (const tool of tools) {
        const p = packagePolicy(tool, policy)
        const active = p === 'on' || (p === 'inherit' && activeIdSet.has(tool.id))
        if (!active) continue
        const functions = (tool.functions ?? []).filter((fn) => functionEnabled(tool, fn, policy))
        if (functions.length > 0) result.push({ tool, functions })
    }
    return result
}

function parameterSchema(fn: RisuToolFunction) {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const param of fn.parameters ?? []) {
        let schema: Record<string, unknown>
        switch (param.type) {
            case 'integer': schema = { type: 'integer' }; break
            case 'string[]': schema = { type: 'array', items: { type: 'string' } }; break
            case 'number[]': schema = { type: 'array', items: { type: 'number' } }; break
            case 'json': schema = { type: 'object' }; break
            default: schema = { type: param.type }
        }
        schema.description = param.description
        if (param.enum?.length) schema.enum = param.enum
        properties[param.name] = schema
        if (param.required) required.push(param.name)
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

export async function getManagedTools(): Promise<Array<MCPTool & { managedToolId: string }>> {
    const output: Array<MCPTool & { managedToolId: string }> = []
    for (const { tool, functions } of getActiveToolPackages()) {
        try {
            const runtime = await ensureRuntime(tool)
            for (const fn of functions) {
                if (!runtime.handlers.has(fn.name)) continue
                output.push({
                    name: toolWireName(tool.namespace, fn.name),
                    description: fn.description,
                    inputSchema: parameterSchema(fn),
                    managedToolId: tool.id,
                })
            }
        } catch (error) {
            console.error(`[Tool:${tool.namespace}] failed to initialize`, error)
        }
    }
    return output
}

export async function callManagedTool(wireName: string, args: unknown): Promise<RPCToolCallContent[] | null> {
    const active = getActiveToolPackages()
    for (const { tool, functions } of active) {
        const fn = functions.find((candidate) => toolWireName(tool.namespace, candidate.name) === wireName)
        if (!fn) continue
        const input = isObject(args) ? args : {}
        const validationError = validateArguments(fn, input)
        if (validationError) return [{ type: 'text', text: JSON.stringify({ ok: false, error: validationError }) }]
        try {
            const runtime = await ensureRuntime(tool)
            const handler = runtime.handlers.get(fn.name)
            if (!handler) throw new Error(`Handler ${fn.name} is not registered.`)
            return normalizeToolResult(await handler(input))
        } catch (error) {
            return [{ type: 'text', text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }]
        }
    }
    return null
}

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function valueMatchesType(value: unknown, type: 'string' | 'number' | 'boolean' | 'json') {
    return type === 'json' ? isObject(value) : typeof value === type
}

function validateArguments(fn: RisuToolFunction, args: Record<string, unknown>) {
    for (const param of fn.parameters ?? []) {
        const value = args[param.name]
        if (param.required && (value === undefined || value === null || value === '')) return `Missing required argument: ${param.name}`
        if (value === undefined || value === null) continue
        const ok = param.type === 'integer' ? Number.isInteger(value)
            : param.type === 'string[]' ? Array.isArray(value) && value.every((item) => typeof item === 'string')
            : param.type === 'number[]' ? Array.isArray(value) && value.every((item) => typeof item === 'number')
            : param.type === 'json' ? isObject(value)
            : typeof value === param.type
        if (!ok) return `Invalid type for ${param.name}; expected ${param.type}.`
    }
    return ''
}

function normalizeToolResult(value: unknown): RPCToolCallContent[] {
    if (Array.isArray(value) && value.every((item) => isObject(item) && typeof item.type === 'string')) {
        return value as RPCToolCallContent[]
    }
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify({ ok: true, data: value }) }]
}

async function ensureRuntime(tool: RisuToolPackage): Promise<ToolRuntime> {
    const source = tool.plugin?.source ?? ''
    const previous = runtimes.get(tool.id)
    if (previous?.source === source) return previous
    previous?.host.terminate()

    let compiled = source
    if (tool.plugin?.language === 'typescript') compiled = await pluginCodeTranspiler(source)
    const handlers = new Map<string, ToolHandler>()
    let markReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    const host = new SandboxHost(makeToolApi(tool, handlers, markReady))
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    document.body.appendChild(iframe)
    host.run(iframe, `${compiled}\nawait risuai.__ready()`)
    const runtime = { source, host, handlers }
    runtimes.set(tool.id, runtime)
    await Promise.race([
        ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tool plugin initialization timed out.')), 3000)),
    ])
    return runtime
}

function makeToolApi(tool: RisuToolPackage, handlers: Map<string, ToolHandler>, ready: () => void) {
    return {
        __ready: () => ready(),
        registerFunction: (name: string, handler: ToolHandler) => {
            if (!(tool.functions ?? []).some((fn) => fn.name === name)) throw new Error(`Function ${name} is not declared.`)
            handlers.set(name, handler)
        },
        askUser: async (question: string, options: string[] = [], allowFreeText = true) => {
            await requirePermission(tool, 'askUser')
            if (!allowFreeText && options.length === 0) throw new Error('At least one option is required when free text is disabled.')
            if (!allowFreeText && options.length > 0) {
                const index = Number(await alertSelect(options, question))
                return Number.isInteger(index) && options[index] !== undefined
                    ? { status: 'answered', answer: options[index] }
                    : { status: 'cancelled' }
            }
            const answer = await alertInput(question, options.map((option) => [option, option]))
            return answer === '' ? { status: 'cancelled' } : { status: 'answered', answer }
        },
        getVariable: (name: string) => getVariable(tool, name),
        setVariable: (name: string, value: unknown) => setVariable(tool, name, value),
        resetVariable: (name: string) => resetVariable(tool, name),
        getList: (name: string) => getList(tool, name),
        setList: (name: string, value: unknown[]) => setList(tool, name, value),
        memoryList: (args: Record<string, unknown>) => memoryList(tool, args),
        memorySearch: (args: Record<string, unknown>) => memorySearch(tool, args),
        memoryRead: (args: Record<string, unknown>) => memoryRead(tool, args),
        memoryUpsert: (args: Record<string, unknown>) => memoryUpsert(tool, args),
        memoryDelete: (args: Record<string, unknown>) => memoryDelete(tool, args),
        nativeFetch: async (url: string, init?: FetchNativeArgs) => {
            await requirePermission(tool, 'network')
            return fetchNative(url, init ?? {})
        },
        databaseGet: async () => {
            await requirePermission(tool, 'database')
            return safeStructuredClone(getDatabase())
        },
        databaseSet: async (value: unknown) => {
            await requirePermission(tool, 'database')
            if (!isObject(value)) throw new Error('Database value must be an object.')
            setDatabase(value as never)
            return true
        },
    }
}

async function requirePermission(tool: RisuToolPackage, permission: ToolPermission) {
    if (!(tool.plugin.permissions ?? []).includes(permission)) throw new Error(`Permission ${permission} was not declared.`)
    if (tool.builtinId && tool.readonly) return
    const db = getDatabase()
    db.toolPermissions ??= {}
    const codeHash = await hasher(new TextEncoder().encode(tool.plugin.source ?? ''))
    const key = `${codeHash}:${permission}`
    db.toolPermissions[tool.id] ??= {}
    const stored = db.toolPermissions[tool.id][key]
    if (stored === true) return
    if (stored === false) throw new Error(`Permission ${permission} was denied.`)
    const permissionLabel = permission === 'askUser' ? language.toolPermissionAskUser
        : permission === 'network' ? language.toolPermissionNetwork : language.toolPermissionDatabase
    const granted = await alertConfirm(language.toolPermissionRequest.replace('{name}', tool.name).replace('{permission}', permissionLabel))
    db.toolPermissions[tool.id][key] = granted
    if (!granted) throw new Error(`Permission ${permission} was denied.`)
}

function getToolStates(): ToolStateStore {
    const db = getDatabase()
    db.toolStates ??= {}
    return db.toolStates
}

function scopeState(toolId: string, scope: ToolScope, create = true): ToolScopeState | undefined {
    const states = getToolStates()
    const toolState: ToolPackageState = states[toolId] ?? (create ? (states[toolId] = {}) : undefined)
    if (!toolState) return undefined
    if (scope === 'global') {
        if (!toolState.global && create) toolState.global = { variables: {}, lists: {} }
        return toolState.global
    }
    const character = getCurrentCharacter()
    if (!character?.chaId) return undefined
    if (scope === 'character') {
        toolState.characters ??= {}
        if (!toolState.characters[character.chaId] && create) toolState.characters[character.chaId] = { variables: {}, lists: {} }
        return toolState.characters[character.chaId]
    }
    const chat = getCurrentChat()
    if (!chat) return undefined
    chat.id ??= v4()
    toolState.chats ??= {}
    if (!toolState.chats[chat.id] && create) toolState.chats[chat.id] = { variables: {}, lists: {} }
    return toolState.chats[chat.id]
}

function getVariable(tool: RisuToolPackage, name: string) {
    const definition = (tool.variables ?? []).find((item) => item.name === name)
    if (!definition) throw new Error(`Variable ${name} is not declared.`)
    const state = scopeState(tool.id, definition.scope)
    if (!(name in state.variables)) state.variables[name] = safeStructuredClone(definition.defaultValue)
    return state.variables[name]
}

function setVariable(tool: RisuToolPackage, name: string, value: unknown) {
    const definition = (tool.variables ?? []).find((item) => item.name === name)
    if (!definition) throw new Error(`Variable ${name} is not declared.`)
    if (!valueMatchesType(value, definition.type)) throw new Error(`Invalid value for ${name}; expected ${definition.type}.`)
    scopeState(tool.id, definition.scope).variables[name] = value
    return value
}

function resetVariable(tool: RisuToolPackage, name: string) {
    const definition = (tool.variables ?? []).find((item) => item.name === name)
    if (!definition) throw new Error(`Variable ${name} is not declared.`)
    const value = safeStructuredClone(definition.defaultValue)
    scopeState(tool.id, definition.scope).variables[name] = value
    return value
}

function getList(tool: RisuToolPackage, name: string) {
    const definition = (tool.lists ?? []).find((item) => item.name === name)
    if (!definition) throw new Error(`List ${name} is not declared.`)
    const state = scopeState(tool.id, definition.scope)
    if (!(name in state.lists)) state.lists[name] = safeStructuredClone(definition.defaultItems ?? [])
    return state.lists[name]
}

function setList(tool: RisuToolPackage, name: string, value: unknown[]) {
    const definition = (tool.lists ?? []).find((item) => item.name === name)
    if (!definition) throw new Error(`List ${name} is not declared.`)
    if (!Array.isArray(value)) throw new Error('List value must be an array.')
    if (!value.every((item) => valueMatchesType(item, definition.itemType))) throw new Error(`Invalid list item for ${name}; expected ${definition.itemType}.`)
    scopeState(tool.id, definition.scope).lists[name] = value
    return value
}

function validReadScopes(raw: unknown): Array<ToolScope> {
    if (raw === 'all') return ['chat', 'character', 'global']
    return [raw === 'character' || raw === 'global' ? raw : 'chat']
}

function validWriteScope(raw: unknown): ToolScope {
    return raw === 'character' || raw === 'global' ? raw : 'chat'
}

function memoryEntries(tool: RisuToolPackage, scope: ToolScope) {
    const state = scopeState(tool.id, scope)
    state.memories ??= []
    return state.memories
}

export function createMemoryToolResult(scope: ToolScope, entry: ToolMemoryEntry): ToolMemoryEntry & { scope: ToolScope } {
    return {
        scope,
        id: entry.id,
        title: entry.title,
        content: entry.content,
        tags: [...entry.tags],
        importance: entry.importance,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
    }
}

function memoryList(tool: RisuToolPackage, args: Record<string, unknown>) {
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
    return validReadScopes(args.scope).flatMap((scope) => memoryEntries(tool, scope).map((entry) => createMemoryToolResult(scope, entry)))
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

function memorySearch(tool: RisuToolPackage, args: Record<string, unknown>) {
    const query = String(args.query ?? '').trim().toLowerCase()
    if (!query) throw new Error('Query is required.')
    return memoryList(tool, { scope: args.scope, limit: 100 }).filter((entry) =>
        `${entry.title}\n${entry.content}\n${entry.tags.join(' ')}`.toLowerCase().includes(query)
    ).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 20)))
}

function memoryRead(tool: RisuToolPackage, args: Record<string, unknown>) {
    const id = String(args.id ?? '')
    for (const scope of validReadScopes(args.scope)) {
        const found = memoryEntries(tool, scope).find((entry) => entry.id === id)
        if (found) return createMemoryToolResult(scope, found)
    }
    throw new Error(`Memory ${id} was not found.`)
}

function memoryUpsert(tool: RisuToolPackage, args: Record<string, unknown>) {
    const title = String(args.title ?? '').trim()
    const content = String(args.content ?? '').trim()
    if (!title || !content) throw new Error('Title and content are required.')
    const scope = validWriteScope(args.scope)
    const entries = memoryEntries(tool, scope)
    const now = Date.now()
    const id = typeof args.id === 'string' && args.id ? args.id : v4()
    const index = entries.findIndex((entry) => entry.id === id)
    const entry: ToolMemoryEntry = {
        id, title, content,
        tags: Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        importance: Math.max(1, Math.min(5, Number(args.importance) || 3)),
        createdAt: index >= 0 ? entries[index].createdAt : now,
        updatedAt: now,
    }
    if (index >= 0) entries[index] = entry
    else entries.push(entry)
    return { scope, ...entry }
}

function memoryDelete(tool: RisuToolPackage, args: Record<string, unknown>) {
    const scope = validWriteScope(args.scope)
    const entries = memoryEntries(tool, scope)
    const index = entries.findIndex((entry) => entry.id === String(args.id ?? ''))
    if (index < 0) return { deleted: false, scope }
    const [deleted] = entries.splice(index, 1)
    return { deleted: true, scope, id: deleted.id }
}

export function unloadToolRuntime(toolId?: string) {
    if (toolId) {
        runtimes.get(toolId)?.host.terminate()
        runtimes.delete(toolId)
        return
    }
    for (const runtime of runtimes.values()) runtime.host.terminate()
    runtimes.clear()
}

export async function exportTool(tool: RisuToolPackage, includeState = false) {
    const payload = createToolExportPayload(tool, includeState ? getToolStates()[tool.id] : undefined)
    await downloadFile(`${tool.namespace}.risutool`, Buffer.from(JSON.stringify(payload, null, 2)))
    notifySuccess(language.toolExported)
}

export function createToolExportPayload(tool: RisuToolPackage, state?: ToolPackageState): RisuToolExportV1 {
    const clean = safeStructuredClone(tool)
    clean.id = v4()
    clean.builtinId = undefined
    clean.readonly = false
    const payload: RisuToolExportV1 = { type: 'risuTool', version: 1, tool: clean }
    if (state) payload.state = safeStructuredClone(state)
    return payload
}

export function parseToolExport(text: string): RisuToolExportV1 {
    const payload = JSON.parse(text) as RisuToolExportV1
    if (payload.type !== 'risuTool' || payload.version !== 1 || !payload.tool) throw new Error('Invalid .risutool file.')
    payload.tool.functions ??= []
    payload.tool.variables ??= []
    payload.tool.lists ??= []
    payload.tool.plugin ??= { language: 'javascript', source: '', permissions: [] }
    payload.tool.plugin.permissions ??= []
    return payload
}

export async function importTool() {
    const file = await selectSingleFile(['risutool', 'json'])
    if (!file) return
    try {
        const payload = parseToolExport(Buffer.from(file.data).toString('utf-8'))
        const db = getDatabase()
        const tool = safeStructuredClone(payload.tool)
        tool.id = v4()
        tool.builtinId = undefined
        tool.readonly = false
        const permissions = tool.plugin.permissions ?? []
        const permissionSummary = permissions.length ? permissions.map((permission) => permission === 'askUser' ? language.toolPermissionAskUser : permission === 'network' ? language.toolPermissionNetwork : language.toolPermissionDatabase).join(', ') : language.none
        const shouldImport = await alertConfirm(language.toolImportConfirm
            .replace('{name}', tool.name)
            .replace('{namespace}', tool.namespace)
            .replace('{permissions}', permissionSummary)
            .replace('{state}', payload.state ? language.yes : language.no))
        if (!shouldImport) return
        const base = tool.namespace
        if ((db.tools ?? []).some((item) => item.namespace === tool.namespace)) {
            let suffix = 2
            while ((db.tools ?? []).some((item) => item.namespace === `${base}-${suffix}`)) suffix++
            const namespace = (await alertInput(language.toolNamespaceConflict.replace('{namespace}', base), [], `${base}-${suffix}`)).trim()
            if (!namespace) return
            tool.namespace = namespace
        }
        const errors = validateToolPackage(tool, db.tools ?? [])
        if (errors.length) throw new Error(errors.join('\n'))
        db.tools.push(tool)
        if (payload.state) {
            db.toolStates ??= {}
            db.toolStates[tool.id] = payload.state
        }
        notifySuccess(language.toolImported)
    } catch (error) {
        notifyError(error)
    }
}
