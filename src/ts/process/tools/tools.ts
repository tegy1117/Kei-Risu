import { alertConfirm, alertInput, alertSelect, notifyError, notifySuccess } from 'src/ts/alert'
import { language } from 'src/lang'
import { downloadFile, fetchNative, readImage, saveAsset, type FetchNativeArgs } from 'src/ts/globalApi.svelte'
import { pluginCodeTranspiler } from 'src/ts/plugins/apiV3/transpiler'
import { SandboxHost } from 'src/ts/plugins/apiV3/factory'
import { getCurrentCharacter, getCurrentChat, getDatabase, setDatabase } from 'src/ts/storage/database.svelte'
import { safeStructuredClone } from 'src/ts/polyfill'
import { selectSingleFile } from 'src/ts/util'
import { v4 } from 'uuid'
import type { MCPTool, RPCToolCallContent } from '../mcp/mcplib'
import type {
    RisuToolExportV1,
    RisuToolExportV2,
    RisuToolFunction,
    RisuToolPackage,
    ToolAgentExecution,
    ToolAgentOutputRoute,
    ToolAgentStateAction,
    ToolCallableRef,
    ToolFunctionRegexScript,
    ToolMemoryEntry,
    ToolPackageState,
    ToolPermission,
    ToolPolicyValue,
    ToolPromptPolicy,
    ToolScope,
    ToolScopeState,
    ToolSharedChange,
    ToolAppViewMode,
    ToolAppViewOptions,
    ToolStateStore,
} from './types'
import {
    cancelToolAppSession,
    cancelToolAppForTool,
    closeToolAppSession,
    getToolAppRuntimeMount,
    openToolAppSession,
    setToolAppViewMode,
    toolAppGuestBootstrap,
} from './toolApp'
import { cancelToolInteractionsForOwner } from './interaction'

const namespacePattern = /^[A-Za-z0-9_-]+$/
const functionPattern = /^[A-Za-z0-9_-]+$/
const parameterTypes = new Set(['string', 'number', 'integer', 'boolean', 'json', 'string[]', 'number[]'])
const valueTypes = new Set(['string', 'number', 'boolean', 'json'])
const toolScopes = new Set(['global', 'character', 'chat'])
const regexTypes = new Set(['editdisplay', 'editinput', 'editoutput', 'editprocess', 'edittrans'])
const toolRegexTypes = new Set(['arguments', 'agentOutput', 'modelResult', 'visibleCall', 'pendingCard', 'successCard', 'errorCard'])
const agentOnlyToolRegexTypes = new Set(['agentOutput', 'visibleCall'])
const triggerTypes = new Set(['start', 'manual', 'output', 'input', 'display', 'request'])

type ToolHandler = (args: Record<string, unknown>, context?: ToolInvocationApi) => Promise<unknown>

export interface ToolExecutionContext {
    stack: string[]
    requestStatusId?: string
    interactionOwnerId?: string
    abortSignal?: AbortSignal
    onPendingPresentation?: (presentation: ManagedToolPendingPresentation) => void | Promise<void>
}

export interface ManagedToolPendingPresentation {
    toolId: string
    namespace: string
    functionId: string
    functionName: string
    renderedTemplate?: string
    args: Record<string, unknown>
    showInChat: boolean
}

export interface ManagedToolExecutionResult {
    response: RPCToolCallContent[]
    success: boolean
    error?: string
    presentation?: {
        toolId: string
        namespace: string
        functionId: string
        functionName: string
        template?: string
        rawResult?: unknown
        captures?: Record<string, string>
        stateUpdates?: unknown[]
        renderedTemplate?: string
        showInChat?: boolean
    }
}
type ToolRuntime = {
    source: string
    host: SandboxHost
    handlers: Map<string, ToolHandler>
    iframe: HTMLIFrameElement
}

const runtimes = new Map<string, ToolRuntime>()

interface ToolInvocation {
    id: string
    ownerId: string
    tool: RisuToolPackage
    fn: RisuToolFunction
    runtime: ToolRuntime
    executionContext: ToolExecutionContext
    wireName: string
    cancel: (reason: string) => void
    cancelled: Promise<never>
    characterFingerprint: string
    chatFingerprint: string
    databaseFingerprint: string
    viewId?: string
}

export function toolWireName(namespace: string, functionName: string) {
    return `${namespace}__${functionName}`
}

function validateAllowedToolRefs(value: unknown, functionName: string, errors: string[], required = false) {
    if (!Array.isArray(value)) {
        if (required) errors.push(`Allowed tools must be an array for ${functionName}.`)
        return
    }
    for (const ref of value) {
        if (!isObject(ref) || (ref.kind !== 'managed' && ref.kind !== 'external')) errors.push(`Invalid allowed tool reference in ${functionName}.`)
        else if (ref.kind === 'managed' && (typeof ref.toolId !== 'string' || typeof ref.functionId !== 'string')) errors.push(`Invalid managed tool reference in ${functionName}.`)
        else if (ref.kind === 'external' && typeof ref.name !== 'string') errors.push(`Invalid external tool reference in ${functionName}.`)
    }
}

export function validateToolPackage(tool: RisuToolPackage, allTools: RisuToolPackage[] = []): string[] {
    const errors: string[] = []
    const allowedPermissions: ToolPermission[] = [
        'askUser', 'network', 'database', 'interactiveUi', 'invokeTools',
        'character.read', 'character.write', 'chat.read', 'chat.write', 'lorebook.read', 'lorebook.write',
    ]
    if (!tool.name?.trim()) errors.push('Tool name is required.')
    if (!namespacePattern.test(tool.namespace ?? '')) errors.push('Namespace may contain only letters, numbers, _ and -.')
    if (allTools.some((other) => other.id !== tool.id && other.namespace === tool.namespace)) {
        errors.push(`Namespace "${tool.namespace}" is already in use.`)
    }
    if (tool.plugin?.language !== 'javascript' && tool.plugin?.language !== 'typescript') errors.push('Plugin language must be JavaScript or TypeScript.')
    if (tool.plugin?.apiVersion !== undefined && tool.plugin.apiVersion !== 1 && tool.plugin.apiVersion !== 2) errors.push('Plugin API version must be 1 or 2.')
    if (typeof tool.plugin?.source !== 'string') errors.push('Plugin source must be text.')
    if (tool.lowLevelAccess !== undefined && typeof tool.lowLevelAccess !== 'boolean') errors.push('Low-level access must be a boolean.')
    const pluginPermissions: unknown = tool.plugin?.permissions
    if (!Array.isArray(pluginPermissions)) errors.push('Plugin permissions must be an array.')
    else {
        for (const permission of pluginPermissions) {
            if (!allowedPermissions.includes(permission)) errors.push(`Unknown permission: ${String(permission)}`)
        }
    }
    const names = new Set<string>()
    const functionIds = new Set<string>()
    for (const fn of tool.functions ?? []) {
        if (!fn.id?.trim() || functionIds.has(fn.id)) errors.push(`Invalid or duplicate function ID: ${fn.id || '(empty)'}`)
        functionIds.add(fn.id)
        if (!functionPattern.test(fn.name ?? '')) errors.push(`Invalid function name: ${fn.name || '(empty)'}`)
        if (names.has(fn.name)) errors.push(`Duplicate function name: ${fn.name}`)
        names.add(fn.name)
        if (typeof fn.enabled !== 'boolean') errors.push(`Function enabled must be a boolean for ${fn.name}.`)
        if (fn.presentation !== undefined) {
            if (!isObject(fn.presentation)) errors.push(`Invalid presentation for ${fn.name}.`)
            else {
                if (fn.presentation.showInChat !== undefined && typeof fn.presentation.showInChat !== 'boolean') errors.push(`presentation.showInChat must be a boolean for ${fn.name}.`)
                for (const key of ['pendingTemplate', 'successTemplate', 'errorTemplate'] as const) {
                    if (fn.presentation[key] !== undefined && typeof fn.presentation[key] !== 'string') errors.push(`presentation.${key} must be text for ${fn.name}.`)
                }
                const manual = fn.presentation.manualLaunch
                if (manual !== undefined) {
                    if (!isObject(manual) || typeof manual.enabled !== 'boolean') errors.push(`presentation.manualLaunch.enabled must be a boolean for ${fn.name}.`)
                    else {
                        if (manual.label !== undefined && typeof manual.label !== 'string') errors.push(`presentation.manualLaunch.label must be text for ${fn.name}.`)
                        if (manual.includeInModelHistory !== undefined && typeof manual.includeInModelHistory !== 'boolean') errors.push(`presentation.manualLaunch.includeInModelHistory must be a boolean for ${fn.name}.`)
                        if (manual.enabled && (fn.parameters ?? []).some((parameter) => parameter.required)) errors.push(`Manual function ${fn.name} cannot have required parameters.`)
                    }
                }
            }
        }
        const params = new Set<string>()
        const paramIds = new Set<string>()
        for (const param of fn.parameters ?? []) {
            if (!param.id?.trim() || paramIds.has(param.id)) errors.push(`Invalid or duplicate parameter ID in ${fn.name}: ${param.id || '(empty)'}`)
            paramIds.add(param.id)
            if (!functionPattern.test(param.name ?? '')) errors.push(`Invalid parameter name: ${param.name || '(empty)'}`)
            if (params.has(param.name)) errors.push(`Duplicate parameter in ${fn.name}: ${param.name}`)
            params.add(param.name)
            if (!parameterTypes.has(param.type)) errors.push(`Invalid parameter type in ${fn.name}: ${param.type}`)
            if (param.enum !== undefined && (!Array.isArray(param.enum) || !param.enum.every((value) => typeof value === 'string'))) {
                errors.push(`Invalid enum in ${fn.name}: ${param.name}`)
            }
        }
        const execution = fn.execution
        if (execution && execution.kind !== 'script' && execution.kind !== 'agent') errors.push(`Invalid execution kind for ${fn.name}.`)
        if (execution?.kind === 'script' && execution.allowedTools !== undefined) validateAllowedToolRefs(execution.allowedTools, fn.name, errors)
        if (execution?.kind === 'agent') {
            if (typeof execution.modelPresetId !== 'string' || !execution.modelPresetId.trim()) errors.push(`execution.modelPresetId is required for agent function ${fn.name}.`)
            const systemPrompt = typeof execution.systemPrompt === 'string' ? execution.systemPrompt : ''
            const userPrompt = typeof execution.userPrompt === 'string' ? execution.userPrompt : ''
            if (typeof execution.systemPrompt !== 'string' || typeof execution.userPrompt !== 'string') errors.push(`execution.systemPrompt and execution.userPrompt must both be text for agent function ${fn.name}.`)
            if (!systemPrompt.trim() && !userPrompt.trim()) errors.push(`At least one of execution.systemPrompt or execution.userPrompt is required for agent function ${fn.name}.`)
            validateAllowedToolRefs(execution.allowedTools, fn.name, errors, true)
            if (!Array.isArray(execution.outputRoutes) || execution.outputRoutes.length === 0) errors.push(`At least one output route is required for ${fn.name}.`)
            for (const route of Array.isArray(execution.outputRoutes) ? execution.outputRoutes : []) {
                if (!isObject(route)) {
                    errors.push(`Invalid output route in ${fn.name}.`)
                    continue
                }
                if (typeof route.id !== 'string' || !route.id.trim()) errors.push(`Output route ID is required in ${fn.name}.`)
                if (route.outcome !== 'success' && route.outcome !== 'error') errors.push(`Output route outcome must be success or error in ${fn.name}: ${route.name || route.id}`)
                if (route.flags !== undefined && typeof route.flags !== 'string') errors.push(`Output route flags must be text in ${fn.name}: ${route.name || route.id}`)
                if (typeof route.pattern !== 'string') errors.push(`Output route pattern must be text in ${fn.name}: ${route.name || route.id}`)
                else try { new RegExp(route.pattern, normalizeRegexFlags(typeof route.flags === 'string' ? route.flags : '')) }
                catch { errors.push(`Invalid output route regex in ${fn.name}: ${route.name || route.id}`) }
                if (typeof route.modelTemplate !== 'string' || !route.modelTemplate) errors.push(`Output route modelTemplate is required in ${fn.name}: ${route.name || route.id}`)
                if (!Array.isArray(route.actions)) errors.push(`Output route actions must be an array in ${fn.name}: ${route.name || route.id}`)
                for (const action of Array.isArray(route.actions) ? route.actions : []) {
                    if (!isObject(action)) {
                        errors.push(`Invalid state action in ${fn.name}.`)
                        continue
                    }
                    if (typeof action.id !== 'string' || !action.id.trim()) errors.push(`State action ID is required in ${fn.name}.`)
                    if (action.kind === 'setVariable' && !(tool.variables ?? []).some((item) => item.name === action.name)) {
                        errors.push(`Unknown variable in ${fn.name}: ${action.name}`)
                    }
                    if ((action.kind === 'appendList' || action.kind === 'replaceList') && !(tool.lists ?? []).some((item) => item.name === action.name)) {
                        errors.push(`Unknown list in ${fn.name}: ${action.name}`)
                    }
                    if (action.kind === 'upsertMemory' && !toolScopes.has(String(action.scope))) errors.push(`Invalid memory scope in ${fn.name}.`)
                    if (!['setVariable', 'appendList', 'replaceList', 'upsertMemory'].includes(String(action.kind))) errors.push(`Invalid state action kind in ${fn.name}.`)
                }
            }
        }
    }
    for (const fn of tool.functions ?? []) {
        for (const ref of fn.execution?.allowedTools ?? []) {
            if (ref.kind !== 'managed') continue
            if (ref.toolId === tool.id && ref.functionId === fn.id) {
                errors.push(`Function ${fn.name} cannot call itself.`)
                continue
            }
            if (allTools.length > 0) {
                const target = ref.toolId === tool.id ? tool : allTools.find((candidate) => candidate.id === ref.toolId)
                if (!target?.functions.some((candidate) => candidate.id === ref.functionId)) errors.push(`Managed tool reference not found in ${fn.name}.`)
            }
        }
    }
    const variableNames = new Set<string>()
    const variableIds = new Set<string>()
    for (const variable of tool.variables ?? []) {
        if (!variable.id?.trim() || variableIds.has(variable.id)) errors.push(`Invalid or duplicate variable ID: ${variable.id || '(empty)'}`)
        variableIds.add(variable.id)
        if (!functionPattern.test(variable.name ?? '')) errors.push(`Invalid variable name: ${variable.name || '(empty)'}`)
        if (variableNames.has(variable.name)) errors.push(`Duplicate variable name: ${variable.name}`)
        variableNames.add(variable.name)
        if (!valueTypes.has(variable.type)) errors.push(`Invalid variable type for ${variable.name}: ${variable.type}`)
        if (!toolScopes.has(variable.scope)) errors.push(`Invalid variable scope for ${variable.name}: ${variable.scope}`)
        if (!valueMatchesType(variable.defaultValue, variable.type)) errors.push(`Invalid default value for variable ${variable.name}.`)
    }
    const listNames = new Set<string>()
    const listIds = new Set<string>()
    for (const list of tool.lists ?? []) {
        if (!list.id?.trim() || listIds.has(list.id)) errors.push(`Invalid or duplicate list ID: ${list.id || '(empty)'}`)
        listIds.add(list.id)
        if (!functionPattern.test(list.name ?? '')) errors.push(`Invalid list name: ${list.name || '(empty)'}`)
        if (listNames.has(list.name)) errors.push(`Duplicate list name: ${list.name}`)
        listNames.add(list.name)
        if (!valueTypes.has(list.itemType)) errors.push(`Invalid list item type for ${list.name}: ${list.itemType}`)
        if (!toolScopes.has(list.scope)) errors.push(`Invalid list scope for ${list.name}: ${list.scope}`)
        if (!Array.isArray(list.defaultItems) || !list.defaultItems.every((item) => valueMatchesType(item, list.itemType))) {
            errors.push(`Invalid default items for list ${list.name}.`)
        }
    }
    for (const script of tool.regex ?? []) {
        if (!script || typeof script.comment !== 'string' || typeof script.in !== 'string' || typeof script.out !== 'string') {
            errors.push('Regex scripts require comment, in, and out text fields.')
            continue
        }
        if (!regexTypes.has(script.type)) errors.push(`Invalid regex type: ${script.type}`)
        try { new RegExp(script.in, script.ableFlag ? script.flag : 'g') }
        catch { errors.push(`Invalid regex script: ${script.comment || script.in}`) }
    }
    const functionById = new Map((tool.functions ?? []).map((fn) => [fn.id, fn]))
    const functionRegexIds = new Set<string>()
    for (const script of tool.functionRegex ?? []) {
        if (!script || typeof script.id !== 'string' || !script.id.trim() || functionRegexIds.has(script.id)) {
            errors.push(`Invalid or duplicate function regex ID: ${script?.id || '(empty)'}`)
            continue
        }
        functionRegexIds.add(script.id)
        const fn = functionById.get(script.functionId)
        if (!fn) errors.push(`Function regex references an unknown function: ${script.functionId || '(empty)'}`)
        if (!toolRegexTypes.has(script.type)) errors.push(`Invalid function regex type: ${script.type}`)
        if (fn?.execution?.kind !== 'agent' && agentOnlyToolRegexTypes.has(script.type)) {
            errors.push(`Function regex type ${script.type} requires an agent function: ${fn?.name ?? script.functionId}`)
        }
        if (typeof script.comment !== 'string' || typeof script.in !== 'string' || typeof script.out !== 'string') {
            errors.push('Function regex scripts require comment, in, and out text fields.')
            continue
        }
        let settingsValid = true
        if (script.flag !== undefined && typeof script.flag !== 'string') {
            errors.push(`Function regex flags must be text: ${script.comment || script.in}`)
            settingsValid = false
        }
        if (script.ableFlag !== undefined && typeof script.ableFlag !== 'boolean') {
            errors.push(`Function regex ableFlag must be a boolean: ${script.comment || script.in}`)
            settingsValid = false
        }
        if (script.enabled !== undefined && typeof script.enabled !== 'boolean') {
            errors.push(`Function regex enabled must be a boolean: ${script.comment || script.in}`)
            settingsValid = false
        }
        if (settingsValid) {
            try { new RegExp(script.in, normalizeToolRegexFlags(script)) }
            catch { errors.push(`Invalid function regex: ${script.comment || script.in}`) }
        }
    }
    for (const trigger of tool.trigger ?? []) {
        if (!trigger || typeof trigger.comment !== 'string' || !triggerTypes.has(trigger.type) || !Array.isArray(trigger.conditions) || !Array.isArray(trigger.effect)) {
            errors.push(`Invalid trigger structure: ${trigger?.comment || '(unnamed)'}`)
            continue
        }
        if (trigger.effect.some((effect) => !effect || typeof effect.type !== 'string' || !effect.type)) errors.push(`Invalid trigger effect in ${trigger.comment || '(unnamed)'}.`)
    }
    const assetNames = new Set<string>()
    for (const asset of tool.assets ?? []) {
        if (!asset?.[0]?.trim() || !asset?.[1]?.trim()) errors.push('Tool assets require a name and stored path.')
        if (assetNames.has(asset[0])) errors.push(`Duplicate tool asset name: ${asset[0]}`)
        assetNames.add(asset[0])
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
            const scriptFunctions = functions.filter((fn) => fn.execution?.kind !== 'agent')
            const runtime = scriptFunctions.length > 0 ? await ensureRuntime(tool) : null
            for (const fn of functions) {
                if (fn.execution?.kind !== 'agent' && !runtime?.handlers.has(fn.name)) continue
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

export function getManualToolFunctions() {
    return getActiveToolPackages().flatMap(({ tool, functions }) => functions
        .filter((fn) => fn.presentation?.manualLaunch?.enabled === true)
        .map((fn) => ({ tool, fn, wireName: toolWireName(tool.namespace, fn.name) })))
}

export async function callManualTool(toolId: string, functionId: string) {
    const candidate = getManualToolFunctions().find((item) => item.tool.id === toolId && item.fn.id === functionId)
    if (!candidate) throw new Error('This function is not available for manual launch.')
    if (candidate.fn.parameters.some((parameter) => parameter.required)) throw new Error('Manual functions cannot require arguments.')
    const call = { id: v4(), name: candidate.wireName, arg: {} }
    const executed = await callManagedToolDetailed(candidate.wireName, {}, { stack: [] })
    if (!executed) throw new Error('Manual tool function was not found.')
    const { encodeToolExecution } = await import('../mcp/mcp')
    const marker = await encodeToolExecution(call, executed, candidate.fn.presentation?.manualLaunch?.includeInModelHistory !== false)
    const chat = getCurrentChat()
    if (!chat) throw new Error('No current chat is selected.')
    chat.message.push({ role: 'char', data: marker })
    chat.message = chat.message
    return executed
}

export async function callManagedToolDetailed(
    wireName: string,
    args: unknown,
    context: ToolExecutionContext = { stack: [] },
): Promise<ManagedToolExecutionResult | null> {
    const active = getActiveToolPackages()
    for (const { tool, functions } of active) {
        const fn = functions.find((candidate) => toolWireName(tool.namespace, candidate.name) === wireName)
        if (!fn) continue
        const input = applyToolArgumentRegex(tool, fn, isObject(args) ? args : {}) as Record<string, unknown>
        const validationError = validateArguments(fn, input)
        if (validationError) return managedError(tool, fn, validationError, input)
        if (context.stack.includes(wireName)) return managedError(tool, fn, `Recursive tool call blocked: ${[...context.stack, wireName].join(' -> ')}`, input)
        try {
            if (fn.presentation?.showInChat !== false && context.onPendingPresentation) {
                await context.onPendingPresentation({
                    toolId: tool.id,
                    namespace: tool.namespace,
                    functionId: fn.id,
                    functionName: fn.name,
                    renderedTemplate: renderToolCard(tool, fn, 'pending', fn.presentation?.pendingTemplate, input),
                    args: input,
                    showInChat: true,
                })
            }
            if (fn.execution?.kind === 'agent') {
                return await executeAgentFunction(tool, fn, fn.execution, input, {
                    stack: [...context.stack, wireName],
                    requestStatusId: context.requestStatusId,
                })
            }
            const runtime = await ensureRuntime(tool)
            const handler = runtime.handlers.get(fn.name)
            if (!handler) throw new Error(`Handler ${fn.name} is not registered.`)
            const invocation = createToolInvocation(tool, fn, runtime, wireName, {
                ...context,
                stack: [...context.stack, wireName],
            })
            const invocationApi = new ToolInvocationApi(invocation)
            const abortInvocation = () => invocation.cancel('Tool call cancelled by the request.')
            let rawResult: unknown
            try {
                if (context.abortSignal?.aborted) abortInvocation()
                else context.abortSignal?.addEventListener('abort', abortInvocation, { once: true })
                rawResult = await Promise.race([handler(input, invocationApi), invocation.cancelled])
            } finally {
                context.abortSignal?.removeEventListener('abort', abortInvocation)
                if (invocation.viewId) closeToolAppSession(invocation.viewId)
                runtime.host.releaseRemoteInstance(invocationApi)
            }
            const response = normalizeToolResult(rawResult).map((part) => part.type === 'text'
                ? { ...part, text: applyToolFunctionRegexText(tool, fn.id, 'modelResult', part.text) }
                : part)
            return {
                response,
                success: true,
                presentation: {
                    toolId: tool.id,
                    namespace: tool.namespace,
                    functionId: fn.id,
                    functionName: fn.name,
                    template: fn.presentation?.successTemplate,
                    rawResult,
                    renderedTemplate: renderToolCard(tool, fn, 'success', fn.presentation?.successTemplate, input, {}, rawResult),
                    showInChat: fn.presentation?.showInChat !== false,
                },
            }
        } catch (error) {
            return managedError(tool, fn, error instanceof Error ? error.message : String(error), input)
        }
    }
    return null
}

export async function callManagedTool(
    wireName: string,
    args: unknown,
    context?: ToolExecutionContext,
): Promise<RPCToolCallContent[] | null> {
    return (await callManagedToolDetailed(wireName, args, context))?.response ?? null
}

function managedError(tool: RisuToolPackage, fn: RisuToolFunction, error: string, args: Record<string, unknown> = {}): ManagedToolExecutionResult {
    const rawResult = { ok: false, error }
    const modelError = applyToolFunctionRegexText(tool, fn.id, 'modelResult', JSON.stringify(rawResult))
    return {
        response: [{ type: 'text', text: modelError }],
        success: false,
        error,
        presentation: {
            toolId: tool.id,
            namespace: tool.namespace,
            functionId: fn.id,
            functionName: fn.name,
            template: fn.presentation?.errorTemplate,
            rawResult,
            renderedTemplate: renderToolCard(tool, fn, 'error', fn.presentation?.errorTemplate, args, {}, rawResult),
            showInChat: fn.presentation?.showInChat !== false,
        },
    }
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
    const runtimeMount = getToolAppRuntimeMount()
    if (previous?.source === source && (!runtimeMount || previous.iframe.parentElement === runtimeMount)) return previous
    previous?.host.terminate()

    let compiled = source
    if (tool.plugin?.language === 'typescript') compiled = await pluginCodeTranspiler(source)
    const handlers = new Map<string, ToolHandler>()
    let markReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    const host = new SandboxHost(makeToolApi(tool, handlers, markReady))
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    ;(runtimeMount ?? document.body).appendChild(iframe)
    const bootstrap = (tool.plugin.apiVersion ?? 1) >= 2 ? `${toolAppGuestBootstrap}\n` : ''
    host.run(iframe, `${bootstrap}${compiled}\nawait risuai.__ready()`)
    const runtime = { source, host, handlers, iframe }
    runtimes.set(tool.id, runtime)
    await Promise.race([
        ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tool plugin initialization timed out.')), 3000)),
    ])
    return runtime
}

function snapshotFingerprint(value: unknown) {
    try { return JSON.stringify(safeStructuredClone(value)) } catch { return '' }
}

function createToolInvocation(
    tool: RisuToolPackage,
    fn: RisuToolFunction,
    runtime: ToolRuntime,
    wireName: string,
    executionContext: ToolExecutionContext,
): ToolInvocation {
    const id = v4()
    let rejectCancellation: (error: Error) => void = () => {}
    let cancelled = false
    const cancelledPromise = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    const invocation: ToolInvocation = {
        id,
        ownerId: executionContext.interactionOwnerId ?? id,
        tool,
        fn,
        runtime,
        executionContext,
        wireName,
        cancelled: cancelledPromise,
        cancel: (reason: string) => {
            if (cancelled) return
            cancelled = true
            rejectCancellation(new Error(reason))
            cancelToolInteractionsForOwner(invocation.ownerId, reason)
            runtime.host.terminate()
            if (runtimes.get(tool.id) === runtime) runtimes.delete(tool.id)
        },
        characterFingerprint: snapshotFingerprint(getCurrentCharacter()),
        chatFingerprint: snapshotFingerprint(getCurrentChat()),
        databaseFingerprint: sharedDatabaseFingerprint(),
    }
    return invocation
}

function callableRefEquals(left: ToolCallableRef, right: ToolCallableRef) {
    return left.kind === right.kind && (left.kind === 'external'
        ? left.name === (right as Extract<ToolCallableRef, { kind: 'external' }>).name
        : left.toolId === (right as Extract<ToolCallableRef, { kind: 'managed' }>).toolId
            && left.functionId === (right as Extract<ToolCallableRef, { kind: 'managed' }>).functionId)
}

function callableRefName(ref: ToolCallableRef) {
    if (ref.kind === 'external') return ref.name
    const target = getDatabase().tools.find((tool) => tool.id === ref.toolId)
    const fn = target?.functions.find((candidate) => candidate.id === ref.functionId)
    if (!target || !fn) throw new Error('Managed tool reference was not found.')
    return toolWireName(target.namespace, fn.name)
}

export class ToolInvocationApi {
    readonly __classType = 'REMOTE_REQUIRED'

    constructor(private readonly invocation: ToolInvocation) {}

    async openView(options: ToolAppViewOptions) {
        this.requireV2()
        await requirePermission(this.invocation.tool, 'interactiveUi')
        const viewId = v4()
        const opened = openToolAppSession({
            id: viewId,
            ownerId: this.invocation.ownerId,
            toolId: this.invocation.tool.id,
            functionId: this.invocation.fn.id,
            iframe: this.invocation.runtime.iframe,
            options,
            onCancel: (reason) => this.invocation.cancel(reason),
        })
        this.invocation.viewId = viewId
        return opened
    }

    setViewMode(mode: ToolAppViewMode) {
        this.requireV2()
        if (!this.invocation.viewId) throw new Error('No Tool App view is open.')
        return setToolAppViewMode(this.invocation.viewId, mode)
    }

    closeView() {
        this.requireV2()
        if (!this.invocation.viewId) return false
        const closed = closeToolAppSession(this.invocation.viewId)
        this.invocation.viewId = undefined
        return closed
    }

    async requestChoice(request: unknown) {
        this.requireV2()
        await requirePermission(this.invocation.tool, 'askUser')
        if (!isObject(request)) throw new Error('Choice request must be an object.')
        const { requestChoice } = await import('./choice')
        return requestChoice(request as never, this.invocation.ownerId)
    }

    async requestDiceRoll(request: unknown) {
        this.requireV2()
        await requirePermission(this.invocation.tool, 'askUser')
        if (!isObject(request)) throw new Error('Dice roll request must be an object.')
        const { requestDiceRoll } = await import('./dice')
        return requestDiceRoll(request as never, this.invocation.ownerId)
    }

    async callTool(ref: ToolCallableRef, args: unknown = {}) {
        this.requireV2()
        await requirePermission(this.invocation.tool, 'invokeTools')
        if (!isObject(ref) || (ref.kind !== 'managed' && ref.kind !== 'external')) throw new Error('Invalid callable tool reference.')
        const execution = this.invocation.fn.execution
        const allowed = execution?.kind === 'script' ? execution.allowedTools ?? [] : []
        if (!allowed.some((candidate) => callableRefEquals(candidate, ref))) throw new Error('Tool call was not declared in execution.allowedTools.')
        if (this.invocation.executionContext.stack.length >= 32) throw new Error('Nested tool call limit reached.')
        const name = callableRefName(ref)
        const { callToolDetailed } = await import('../mcp/mcp')
        return callToolDetailed(name, args, {
            stack: this.invocation.executionContext.stack,
            requestStatusId: this.invocation.executionContext.requestStatusId,
            interactionOwnerId: this.invocation.ownerId,
            abortSignal: this.invocation.executionContext.abortSignal,
        })
    }

    async getCurrentCharacter() {
        this.requireV2()
        await requirePermission(this.invocation.tool, 'character.read')
        const character = getCurrentCharacter()
        if (!character) return null
        const snapshot = safeStructuredClone(character) as unknown as Record<string, unknown>
        delete snapshot.chats
        return snapshot
    }

    async getCurrentChat() {
        this.requireV2()
        await requirePermission(this.invocation.tool, 'chat.read')
        const chat = getCurrentChat()
        return chat ? safeStructuredClone(chat) : null
    }

    async listLorebooks() {
        this.requireV2()
        await requirePermission(this.invocation.tool, 'lorebook.read')
        const character = getCurrentCharacter()
        const chat = getCurrentChat()
        const { getModuleLorebooks } = await import('src/ts/process/modules')
        return [
            ...(character?.globalLore ?? []).map((entry) => ({ source: 'character', entry: safeStructuredClone(entry) })),
            ...(chat?.localLore ?? []).map((entry) => ({ source: 'chat', entry: safeStructuredClone(entry) })),
            ...getModuleLorebooks().map((entry) => ({ source: 'module', entry: safeStructuredClone(entry) })),
        ]
    }

    async commitChanges(changes: ToolSharedChange[]) {
        this.requireV2()
        return commitToolSharedChanges(this.invocation, changes)
    }

    private requireV2() {
        if ((this.invocation.tool.plugin.apiVersion ?? 1) < 2) throw new Error('Tool App invocation APIs require plugin.apiVersion 2.')
    }
}

function makeToolApi(tool: RisuToolPackage, handlers: Map<string, ToolHandler>, ready: () => void) {
    return {
        _getPropertiesForInitialization: () => ({ apiVersion: 'tool-2.0', apiVersionCompatibleWith: ['tool-1.0', 'tool-2.0'], list: ['apiVersion', 'apiVersionCompatibleWith'] }),
        _getAliases: () => ({}),
        _getOldKeys: () => [],
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
        requestDiceRoll: async (request: unknown) => {
            await requirePermission(tool, 'askUser')
            if (!isObject(request)) throw new Error('Dice roll request must be an object.')
            const { requestDiceRoll } = await import('./dice')
            return requestDiceRoll(request as never)
        },
        requestChoice: async (request: unknown) => {
            await requirePermission(tool, 'askUser')
            if (!isObject(request)) throw new Error('Choice request must be an object.')
            const { requestChoice } = await import('./choice')
            return requestChoice(request as never)
        },
        httpRequest: async (args: unknown) => {
            if (tool.builtinId !== 'http') throw new Error('httpRequest is reserved for the bundled HTTP tool.')
            if (!isObject(args)) throw new Error('HTTP request must be an object.')
            const { executeHttpTool } = await import('./network')
            return executeHttpTool(args as never)
        },
        webSearch: async (args: unknown) => {
            if (tool.builtinId !== 'websearch') throw new Error('webSearch is reserved for the bundled Web Search tool.')
            if (!isObject(args)) throw new Error('Search request must be an object.')
            const { executeSearchTool } = await import('./network')
            return executeSearchTool(args as never)
        },
        networkProfiles: async (kind: unknown) => {
            if (tool.builtinId !== 'http' && tool.builtinId !== 'websearch') throw new Error('networkProfiles is reserved for bundled network tools.')
            const expected = tool.builtinId === 'http' ? 'http' : 'search'
            if (kind !== expected) throw new Error(`Expected ${expected} network profiles.`)
            const { listNetworkProfiles } = await import('./network')
            return listNetworkProfiles(expected)
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
            if ((tool.plugin.apiVersion ?? 1) >= 2) throw new Error('API v2 tools must use invocation.commitChanges for database writes.')
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
    const { hasher } = await import('src/ts/parser/parser.svelte')
    const codeHash = await hasher(new TextEncoder().encode(tool.plugin.source ?? ''))
    const key = `${codeHash}:${permission}`
    db.toolPermissions[tool.id] ??= {}
    const stored = db.toolPermissions[tool.id][key]
    if (stored === true) return
    if (stored === false) throw new Error(`Permission ${permission} was denied.`)
    const permissionLabel = permission === 'askUser' ? language.toolPermissionAskUser
        : permission === 'network' ? language.toolPermissionNetwork
            : permission === 'database' ? language.toolPermissionDatabase
                : permission
    const granted = await alertConfirm(language.toolPermissionRequest.replace('{name}', tool.name).replace('{permission}', permissionLabel))
    db.toolPermissions[tool.id][key] = granted
    if (!granted) throw new Error(`Permission ${permission} was denied.`)
}

function safeSharedPath(path: string, blockedRoots: string[]) {
    const parts = path.split('.').filter(Boolean)
    if (parts.length === 0 || parts.length > 12) throw new Error(`Invalid shared data path: ${path}`)
    if (blockedRoots.includes(parts[0])) throw new Error(`Shared data path is protected: ${path}`)
    if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error(`Unsafe shared data path: ${path}`)
    return parts
}

function setSharedPath(target: Record<string, unknown>, parts: string[], value: unknown) {
    let current = target
    for (const part of parts.slice(0, -1)) {
        const existing = current[part]
        if (!isObject(existing)) current[part] = {}
        current = current[part] as Record<string, unknown>
    }
    current[parts.at(-1)!] = safeStructuredClone(value)
}

function normalizeSharedLorebook(value: Record<string, unknown>) {
    const content = typeof value.content === 'string' ? value.content.trim() : ''
    if (!content) throw new Error('Lorebook content is required.')
    const comment = typeof value.comment === 'string' ? value.comment.trim() : ''
    return {
        key: typeof value.key === 'string' ? value.key : '',
        secondkey: typeof value.secondkey === 'string' ? value.secondkey : '',
        insertorder: Number.isFinite(value.insertorder) ? Number(value.insertorder) : 0,
        comment,
        content,
        mode: ['multiple', 'constant', 'normal', 'child', 'folder'].includes(String(value.mode)) ? value.mode : 'normal',
        alwaysActive: value.alwaysActive === true,
        selective: value.selective === true,
        ...(typeof value.id === 'string' && value.id ? { id: value.id } : { id: v4() }),
    }
}

function sharedDatabaseFingerprint() {
    const snapshot = safeStructuredClone(getDatabase()) as unknown as Record<string, unknown>
    delete snapshot.toolPermissions
    delete snapshot.toolStates
    return snapshotFingerprint(snapshot)
}

async function commitToolSharedChanges(invocation: ToolInvocation, changes: ToolSharedChange[]) {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) throw new Error('Changes must contain 1 to 100 operations.')
    if (changes.some((change) => change.kind === 'replaceDatabase') && changes.length !== 1) throw new Error('replaceDatabase cannot be combined with other changes.')

    const permissions = new Set<ToolPermission>()
    for (const change of changes) {
        if (!isObject(change)) throw new Error('Every shared change must be an object.')
        if (change.kind === 'setCharacterField') permissions.add('character.write')
        else if (change.kind === 'setChatField') permissions.add('chat.write')
        else if (change.kind === 'upsertLorebook' || change.kind === 'deleteLorebook') permissions.add('lorebook.write')
        else if (change.kind === 'replaceDatabase') permissions.add('database')
        else throw new Error('Unsupported shared change.')
    }
    for (const permission of permissions) await requirePermission(invocation.tool, permission)

    const replacementChange = changes[0].kind === 'replaceDatabase' ? changes[0] : null
    const replacesDatabase = replacementChange !== null
    const requiresCharacterSnapshot = !replacesDatabase
    const requiresChatSnapshot = changes.some((change) => change.kind === 'setChatField' || change.kind === 'upsertLorebook' && change.scope === 'chat' || change.kind === 'deleteLorebook' && change.scope === 'chat')
    const assertSnapshotsAreCurrent = () => {
        const currentCharacter = getCurrentCharacter()
        const currentChat = getCurrentChat()
        if (requiresCharacterSnapshot) {
            if (!currentCharacter) throw new Error('No current character is selected.')
            if (snapshotFingerprint(currentCharacter) !== invocation.characterFingerprint) throw new Error('The current character changed while the Tool App was open.')
        }
        if (requiresChatSnapshot) {
            if (!currentChat) throw new Error('No current chat is selected.')
            if (snapshotFingerprint(currentChat) !== invocation.chatFingerprint) throw new Error('The current chat changed while the Tool App was open.')
        }
        if (replacesDatabase && sharedDatabaseFingerprint() !== invocation.databaseFingerprint) {
            throw new Error('The database changed while the Tool App was open.')
        }
    }
    assertSnapshotsAreCurrent()

    const character = getCurrentCharacter()
    const chat = getCurrentChat()

    const characterDraft = character ? safeStructuredClone(character) as unknown as Record<string, unknown> : null
    const chatIndex = character?.chatPage ?? -1
    const chatDraft = characterDraft && chatIndex >= 0
        ? (characterDraft.chats as Array<Record<string, unknown>> | undefined)?.[chatIndex]
        : null
    const summaries: string[] = []
    for (const change of changes) {
        if (change.kind === 'setCharacterField') {
            if (!characterDraft) throw new Error('No current character is selected.')
            setSharedPath(characterDraft, safeSharedPath(change.path, ['chaId', 'chats', 'globalLore']), change.value)
            summaries.push(`Character: set ${change.path}`)
        } else if (change.kind === 'setChatField') {
            if (!chatDraft) throw new Error('No current chat is selected.')
            setSharedPath(chatDraft, safeSharedPath(change.path, ['id', 'localLore']), change.value)
            summaries.push(`Chat: set ${change.path}`)
        } else if (change.kind === 'upsertLorebook') {
            const target = change.scope === 'character'
                ? characterDraft?.globalLore as Array<Record<string, unknown>> | undefined
                : chatDraft?.localLore as Array<Record<string, unknown>> | undefined
            if (!target) throw new Error(`No current ${change.scope} lorebook is available.`)
            const entry = normalizeSharedLorebook(change.entry)
            const index = target.findIndex((candidate) => candidate.id === entry.id || (!!entry.comment && candidate.comment === entry.comment))
            if (index >= 0) target[index] = { ...target[index], ...entry }
            else target.push(entry)
            summaries.push(`${change.scope} lorebook: ${index >= 0 ? 'update' : 'add'} ${entry.comment || entry.id}`)
        } else if (change.kind === 'deleteLorebook') {
            const target = change.scope === 'character'
                ? characterDraft?.globalLore as Array<Record<string, unknown>> | undefined
                : chatDraft?.localLore as Array<Record<string, unknown>> | undefined
            if (!target) throw new Error(`No current ${change.scope} lorebook is available.`)
            const index = target.findIndex((candidate) => change.id ? candidate.id === change.id : candidate.comment === change.name)
            if (index < 0) throw new Error('Lorebook entry to delete was not found.')
            const [deleted] = target.splice(index, 1)
            summaries.push(`${change.scope} lorebook: delete ${deleted.comment || deleted.id}`)
        } else {
            if (!isObject(change.value)) throw new Error('Replacement database must be an object.')
            summaries.push('Replace the complete RisuAI database')
        }
    }

    const approved = await alertConfirm(`Tool App "${invocation.tool.name}" requests these changes:\n\n${summaries.join('\n')}\n\nApply all changes?`)
    if (!approved) return { committed: false, cancelled: true, changes: summaries }
    assertSnapshotsAreCurrent()
    if (replacementChange) setDatabase(safeStructuredClone(replacementChange.value) as never)
    else if (characterDraft && character) {
        const db = getDatabase()
        const index = db.characters.findIndex((candidate) => candidate.chaId === character.chaId)
        if (index < 0) throw new Error('The current character is no longer available.')
        db.characters[index] = characterDraft as never
        db.characters = db.characters
    }
    invocation.characterFingerprint = snapshotFingerprint(getCurrentCharacter())
    invocation.chatFingerprint = snapshotFingerprint(getCurrentChat())
    invocation.databaseFingerprint = sharedDatabaseFingerprint()
    return { committed: true, changes: summaries }
}

function getToolStates(): ToolStateStore {
    const db = getDatabase()
    db.toolStates ??= {}
    return db.toolStates
}

function replaceToolTokens(
    template: string,
    args: Record<string, unknown>,
    captures: Record<string, string> = {},
    result: unknown = '',
) {
    return (template ?? '')
        .replace(/\{\{tool_arg::([^}]+)\}\}/g, (_match, name: string) => stringifyTemplateValue(args[name]))
        .replace(/\{\{tool_capture::([^}]+)\}\}/g, (_match, name: string) => captures[name] ?? '')
        .replace(/\{\{tool_result(?:::(.*?))?\}\}/g, (_match, path: string | undefined) => stringifyTemplateValue(readPath(result, path)))
}

function renderToolCard(
    tool: RisuToolPackage,
    fn: RisuToolFunction,
    status: 'pending' | 'success' | 'error',
    template: string | undefined,
    args: Record<string, unknown>,
    captures: Record<string, string> = {},
    result: unknown = '',
    stateUpdates: unknown[] = [],
    routeCard = false,
): string | undefined {
    const stateType = status === 'pending' ? 'pendingCard' : status === 'success' ? 'successCard' : 'errorCard'
    const hasStageRegex = (tool.functionRegex ?? []).some((script) =>
        script.enabled !== false && script.functionId === fn.id && (script.type === stateType || (routeCard && script.type === 'visibleCall')))
    if (!template?.trim() && status !== 'pending' && !hasStageRegex) return undefined
    const fallback = status === 'pending'
        ? `<div class="x-risu-tool-call-title"><strong>${escapeToolCardHtml(fn.name)}</strong><span>pending</span></div>`
        : `<div class="x-risu-tool-call-title"><strong>${escapeToolCardHtml(fn.name)}</strong><span>${status}</span></div>`
            + `<details><summary>Details</summary><div><strong>Arguments</strong><pre>${escapeToolCardHtml(JSON.stringify(args, null, 2))}</pre>`
            + `<strong>Result</strong><pre>${escapeToolCardHtml(stringifyTemplateValue(result))}</pre>`
            + (Object.keys(captures).length ? `<strong>Decisions</strong><pre>${escapeToolCardHtml(JSON.stringify(captures, null, 2))}</pre>` : '')
            + (stateUpdates.length ? `<strong>Updates</strong><pre>${escapeToolCardHtml(JSON.stringify(stateUpdates, null, 2))}</pre>` : '')
            + `</div></details>`
    let rendered = replaceToolTokens(template?.trim() ? template : fallback, args, captures, result)
        .replaceAll('{{tool_status}}', status)
        .replaceAll('{{tool_name}}', fn.name)
        .replaceAll('{{tool_updates}}', stringifyTemplateValue(stateUpdates))
    if (routeCard) rendered = applyToolFunctionRegexText(tool, fn.id, 'visibleCall', rendered)
    return applyToolFunctionRegexText(tool, fn.id, stateType, rendered)
}

function escapeToolCardHtml(value: unknown) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char] ?? char))
}

function stringifyTemplateValue(value: unknown) {
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
}

function readPath(value: unknown, path?: string) {
    if (!path) return value
    let current = value
    for (const key of path.split('.').filter(Boolean)) {
        if (!isObject(current) && !Array.isArray(current)) return undefined
        current = (current as Record<string, unknown>)[key]
    }
    return current
}

function renderAgentPrompt(template: string, tool: RisuToolPackage, args: Record<string, unknown>) {
    const character = getCurrentCharacter()
    const chat = getCurrentChat()
    const history = (chat?.message ?? []).filter((message) => !message.disabled && !message.isComment).map((message) => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.data,
    }))
    const lastUser = [...history].reverse().find((message) => message.role === 'user')?.content ?? ''
    const characterInfo = character ? {
        id: character.chaId,
        name: character.name,
        description: character.desc,
        personality: character.personality,
        scenario: character.scenario,
    } : null
    const contextId = (scope: ToolScope) => scope === 'global' ? '' : scope === 'character' ? character?.chaId ?? '' : chat?.id ?? ''
    return replaceToolTokens(template, args)
        .replaceAll('{{tool_args}}', JSON.stringify(args))
        .replaceAll('{{tool_last_user}}', lastUser)
        .replaceAll('{{tool_chat_history}}', JSON.stringify(history))
        .replaceAll('{{tool_character}}', JSON.stringify(characterInfo))
        .replace(/\{\{tool_state::(global|character|chat)\}\}/g, (_match, scope: ToolScope) =>
            JSON.stringify(readToolScopeState(tool.id, scope, contextId(scope))))
}

async function resolveAllowedTools(refs: ToolCallableRef[]) {
    const { getTools } = await import('../mcp/mcp')
    const available = await getTools()
    const db = getDatabase()
    const names = new Set<string>()
    for (const ref of refs ?? []) {
        if (ref.kind === 'external') {
            names.add(ref.name)
            continue
        }
        const tool = (db.tools ?? []).find((item) => item.id === ref.toolId)
        const fn = tool?.functions?.find((item) => item.id === ref.functionId)
        if (tool && fn) names.add(toolWireName(tool.namespace, fn.name))
    }
    return available.filter((tool) => names.has(tool.name))
}

async function executeAgentFunction(
    tool: RisuToolPackage,
    fn: RisuToolFunction,
    execution: ToolAgentExecution,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
): Promise<ManagedToolExecutionResult> {
    const db = getDatabase()
    const preset = db.modelPresets.find((item) => item.id === execution.modelPresetId)
    if (!preset) return managedError(tool, fn, 'The configured model preset was not found.', args)
    const allowedTools = await resolveAllowedTools(execution.allowedTools)
    const requestedCount = execution.allowedTools?.length ?? 0
    if (allowedTools.length !== requestedCount) return managedError(tool, fn, 'One or more allowed tools are unavailable.', args)
    if (allowedTools.length > 0 && preset.toolUse !== true) return managedError(tool, fn, 'The selected model preset has tool use disabled.', args)
    const formated = [
        ...(execution.systemPrompt.trim() ? [{ role: 'system' as const, content: renderAgentPrompt(execution.systemPrompt, tool, args) }] : []),
        ...(execution.userPrompt.trim() ? [{ role: 'user' as const, content: renderAgentPrompt(execution.userPrompt, tool, args) }] : []),
    ]
    const { requestAgentModelPreset } = await import('../request/request')
    const response = await requestAgentModelPreset({
        formated,
        bias: {},
        biasString: [],
        currentChar: getCurrentCharacter(),
        useStreaming: true,
        chatId: `tool-agent:${v4()}`,
        rememberToolUsage: false,
        tools: allowedTools,
        toolExecutionContext: {
            stack: context.stack,
            requestStatusId: context.requestStatusId,
            abortSignal: context.abortSignal,
        },
        requestStatus: {
            kind: 'tool-agent',
            label: `${tool.name} · ${fn.name}`,
            parentId: context.requestStatusId,
        },
        persistToolDisplay: false,
    }, preset, context.abortSignal ?? null)
    if (!response.ok) return managedError(tool, fn, 'error' in response ? response.error : 'Agent request failed.', args)
    const agentOutput = applyToolFunctionRegexText(tool, fn.id, 'agentOutput', response.text)
    const routed = await routeAgentOutput(tool, fn, execution.outputRoutes, args, agentOutput)
    if (!routed) return managedError(tool, fn, 'Agent output did not match any configured route.', args)
    return routed
}

export async function routeAgentOutput(
    tool: RisuToolPackage,
    fn: RisuToolFunction,
    routes: ToolAgentOutputRoute[],
    args: Record<string, unknown>,
    raw: string,
): Promise<ManagedToolExecutionResult | null> {
    for (const route of routes ?? []) {
        const match = new RegExp(route.pattern, normalizeRegexFlags(route.flags)).exec(raw)
        if (!match) continue
        const captures = Object.fromEntries(Object.entries(match.groups ?? {}).map(([key, value]) => [key, value ?? '']))
        const modelText = applyToolFunctionRegexText(tool, fn.id, 'modelResult', replaceToolTokens(route.modelTemplate, args, captures, raw))
        try {
            const stateUpdates = await applyAgentStateActions(tool, route.actions ?? [], args, captures, raw)
            const success = route.outcome === 'success'
            const response = success
                ? [{ type: 'text' as const, text: modelText }]
                : [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: modelText }) }]
            const template = route.cardTemplate || (success ? fn.presentation?.successTemplate : fn.presentation?.errorTemplate)
            const renderedTemplate = renderToolCard(
                tool,
                fn,
                success ? 'success' : 'error',
                template,
                args,
                captures,
                raw,
                stateUpdates,
                true,
            )
            return {
                response,
                success,
                error: success ? undefined : modelText,
                presentation: {
                    toolId: tool.id,
                    namespace: tool.namespace,
                    functionId: fn.id,
                    functionName: fn.name,
                    template,
                    rawResult: raw,
                    captures,
                    stateUpdates,
                    renderedTemplate,
                    showInChat: fn.presentation?.showInChat !== false,
                },
            }
        } catch (error) {
            return managedError(tool, fn, `Agent output state update failed: ${error instanceof Error ? error.message : String(error)}`, args)
        }
    }
    return null
}

function actionValue(template: string, args: Record<string, unknown>, captures: Record<string, string>, result: unknown) {
    return replaceToolTokens(template, args, captures, result)
}

function parseTypedValue(value: string, type: 'string' | 'number' | 'boolean' | 'json') {
    if (type === 'string') return value
    if (type === 'number') {
        const parsed = Number(value)
        if (!Number.isFinite(parsed)) throw new Error(`Expected a number, received ${value}.`)
        return parsed
    }
    if (type === 'boolean') {
        if (value === 'true') return true
        if (value === 'false') return false
        throw new Error(`Expected true or false, received ${value}.`)
    }
    const parsed = JSON.parse(value)
    if (!isObject(parsed)) throw new Error('Expected a JSON object.')
    return parsed
}

async function applyAgentStateActions(
    tool: RisuToolPackage,
    actions: ToolAgentStateAction[],
    args: Record<string, unknown>,
    captures: Record<string, string>,
    result: unknown,
) {
    if (actions.length === 0) return []
    const character = getCurrentCharacter()
    const chat = getCurrentChat()
    if (chat && !chat.id) chat.id = v4()
    const contextId = (scope: ToolScope) => scope === 'global' ? '' : scope === 'character' ? character?.chaId ?? '' : chat?.id ?? ''
    const drafts = new Map<ToolScope, ToolScopeState>()
    const updates: unknown[] = []
    const draft = (scope: ToolScope) => {
        if (scope !== 'global' && !contextId(scope)) throw new Error(`No active ${scope} context.`)
        if (!drafts.has(scope)) drafts.set(scope, readToolScopeState(tool.id, scope, contextId(scope)))
        return drafts.get(scope)!
    }
    for (const action of actions) {
        if (action.kind === 'setVariable') {
            const definition = tool.variables.find((item) => item.name === action.name)
            if (!definition) throw new Error(`Variable ${action.name} is not declared.`)
            draft(definition.scope).variables[action.name] = parseTypedValue(actionValue(action.valueTemplate, args, captures, result), definition.type)
            updates.push({ kind: action.kind, scope: definition.scope, name: action.name, value: draft(definition.scope).variables[action.name] })
            continue
        }
        if (action.kind === 'appendList' || action.kind === 'replaceList') {
            const definition = tool.lists.find((item) => item.name === action.name)
            if (!definition) throw new Error(`List ${action.name} is not declared.`)
            const state = draft(definition.scope)
            if (action.kind === 'replaceList') {
                const value = JSON.parse(actionValue(action.valueTemplate, args, captures, result))
                if (!Array.isArray(value)) throw new Error(`Replacement for ${action.name} must be an array.`)
                state.lists[action.name] = value
                updates.push({ kind: action.kind, scope: definition.scope, name: action.name, value })
            } else {
                const current = state.lists[action.name] ?? safeStructuredClone(definition.defaultItems ?? [])
                current.push(parseTypedValue(actionValue(action.valueTemplate, args, captures, result), definition.itemType))
                state.lists[action.name] = current
                updates.push({ kind: action.kind, scope: definition.scope, name: action.name, value: current.at(-1) })
            }
            continue
        }
        const state = draft(action.scope)
        state.memories ??= []
        const id = action.memoryIdTemplate ? actionValue(action.memoryIdTemplate, args, captures, result) : v4()
        const now = Date.now()
        const index = state.memories.findIndex((entry) => entry.id === id)
        const rawTags = action.tagsTemplate ? actionValue(action.tagsTemplate, args, captures, result) : '[]'
        let tags: string[]
        try {
            const parsed = JSON.parse(rawTags)
            tags = Array.isArray(parsed) ? parsed.map(String) : []
        } catch { tags = rawTags.split(',').map((tag) => tag.trim()).filter(Boolean) }
        const memory: ToolMemoryEntry = {
            id,
            title: actionValue(action.titleTemplate, args, captures, result),
            content: actionValue(action.contentTemplate, args, captures, result),
            tags,
            importance: Number(action.importanceTemplate ? actionValue(action.importanceTemplate, args, captures, result) : 3),
            createdAt: index >= 0 ? state.memories[index].createdAt : now,
            updatedAt: now,
        }
        if (index >= 0) state.memories[index] = memory
        else state.memories.push(memory)
        updates.push({ kind: action.kind, scope: action.scope, id: memory.id, title: memory.title })
    }
    for (const [scope, state] of drafts) {
        const errors = validateToolScopeState(tool, scope, state)
        if (errors.length) throw new Error(errors.join('\n'))
    }
    for (const [scope, state] of drafts) writeToolScopeState(tool.id, scope, contextId(scope), state)
    return updates
}

export function getActiveToolFeaturePackages(): RisuToolPackage[] {
    const db = getDatabase()
    const character = getCurrentCharacter()
    const chat = getCurrentChat()
    const activeIds = new Set([
        ...(db.enabledTools ?? []),
        ...(character?.tools ?? []),
        ...(chat?.tools ?? []),
    ])
    const policy = normalizePolicy(db.toolPolicy)
    return (db.tools ?? []).filter((tool) => {
        const value = packagePolicy(tool, policy)
        return value === 'on' || (value === 'inherit' && activeIds.has(tool.id))
    })
}

export function createToolScopeStateSnapshot(state?: ToolScopeState): ToolScopeState {
    return {
        variables: safeStructuredClone(state?.variables ?? {}),
        lists: Object.fromEntries(Object.entries(state?.lists ?? {}).map(([name, items]) => [name, safeStructuredClone([...items])])),
        memories: (state?.memories ?? []).map((entry) => ({
            id: entry.id,
            title: entry.title,
            content: entry.content,
            tags: [...entry.tags],
            importance: entry.importance,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
        })),
    }
}

function toolScopeState(toolId: string, scope: ToolScope, contextId = ''): ToolScopeState | undefined {
    const toolState = getToolStates()[toolId]
    if (!toolState) return undefined
    if (scope === 'global') return toolState.global
    if (!contextId) return undefined
    return scope === 'character' ? toolState.characters?.[contextId] : toolState.chats?.[contextId]
}

export function readToolScopeState(toolId: string, scope: ToolScope, contextId = ''): ToolScopeState {
    return createToolScopeStateSnapshot(toolScopeState(toolId, scope, contextId))
}

export function writeToolScopeState(toolId: string, scope: ToolScope, contextId: string, state: ToolScopeState) {
    const states = getToolStates()
    const toolState = states[toolId] ?? (states[toolId] = {})
    const clean = createToolScopeStateSnapshot(state)
    if (scope === 'global') toolState.global = clean
    else {
        if (!contextId) throw new Error(`A ${scope} context is required.`)
        const scoped = scope === 'character'
            ? (toolState.characters ??= {})
            : (toolState.chats ??= {})
        scoped[contextId] = clean
    }
    return createToolScopeStateSnapshot(clean)
}

export function deleteToolScopeState(toolId: string, scope: ToolScope, contextId = '') {
    const states = getToolStates()
    const toolState = states[toolId]
    if (!toolState) return false
    if (scope === 'global') {
        if (!toolState.global) return false
        delete toolState.global
        return true
    }
    if (!contextId) return false
    const scoped = scope === 'character' ? toolState.characters : toolState.chats
    if (!scoped?.[contextId]) return false
    delete scoped[contextId]
    return true
}

export function validateToolScopeState(tool: RisuToolPackage, scope: ToolScope, state: ToolScopeState): string[] {
    const errors: string[] = []
    for (const definition of tool.variables ?? []) {
        if (definition.scope !== scope || !(definition.name in state.variables)) continue
        if (!valueMatchesType(state.variables[definition.name], definition.type)) {
            errors.push(`Invalid value for ${definition.name}; expected ${definition.type}.`)
        }
    }
    for (const [name, items] of Object.entries(state.lists)) {
        if (!Array.isArray(items)) {
            errors.push(`List ${name} must be an array.`)
            continue
        }
        const definition = (tool.lists ?? []).find((item) => item.scope === scope && item.name === name)
        if (definition && !items.every((item) => valueMatchesType(item, definition.itemType))) {
            errors.push(`Invalid list item for ${name}; expected ${definition.itemType}.`)
        }
    }
    for (const entry of state.memories ?? []) {
        if (!entry.id || !entry.title.trim() || !entry.content.trim()) errors.push('Memory title and content are required.')
        if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === 'string')) errors.push(`Invalid tags for memory ${entry.id || '(new)'}.`)
        if (!Number.isFinite(entry.importance) || entry.importance < 1 || entry.importance > 5) errors.push(`Invalid importance for memory ${entry.id || '(new)'}.`)
        if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) errors.push(`Invalid timestamps for memory ${entry.id || '(new)'}.`)
    }
    return errors
}

function toolRegexOrder(script: ToolFunctionRegexScript): number {
    const parsed = script.flag?.match(/<order (-?\d+)>/)?.[1]
    return parsed === undefined ? 0 : Number.parseInt(parsed, 10)
}

function normalizeToolRegexFlags(script: Pick<ToolFunctionRegexScript, 'ableFlag' | 'flag'>): string {
    const raw = script.ableFlag ? (script.flag || 'g') : 'g'
    const metadataIndex = raw.indexOf('<')
    const flagText = metadataIndex === -1 ? raw : raw.slice(0, metadataIndex)
    const flags = flagText.replace(/[^dgimsuvy]/g, '')
    const unique = [...new Set(flags)].join('')
    return unique || 'u'
}

export function applyToolFunctionRegexText(
    tool: RisuToolPackage,
    functionId: string,
    type: ToolFunctionRegexScript['type'],
    input: string,
): string {
    const scripts = (tool.functionRegex ?? [])
        .filter((script) => script.enabled !== false && script.functionId === functionId && script.type === type && script.in !== '')
        .map((script, index) => ({ script, index, order: toolRegexOrder(script) }))
        .sort((a, b) => b.order - a.order || a.index - b.index)
    let output = input
    for (const { script } of scripts) {
        const replacement = script.out.replaceAll('$n', '\n').replace(/\{\{data\}\}/g, () => '$&')
        output = output.replace(new RegExp(script.in, normalizeToolRegexFlags(script)), replacement)
    }
    return output
}

export function applyToolArgumentRegex(
    tool: RisuToolPackage,
    fn: RisuToolFunction,
    value: unknown,
): unknown {
    if (typeof value === 'string') return applyToolFunctionRegexText(tool, fn.id, 'arguments', value)
    if (Array.isArray(value)) return value.map((item) => applyToolArgumentRegex(tool, fn, item))
    if (isObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyToolArgumentRegex(tool, fn, item)]))
    }
    return value
}

export async function validateToolPluginSource(tool: RisuToolPackage): Promise<string[]> {
    try {
        const source = tool.plugin.language === 'typescript' ? await pluginCodeTranspiler(tool.plugin.source) : tool.plugin.source
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
        new AsyncFunction('risuai', source)
        return []
    } catch (error) {
        return [`Plugin source is invalid: ${error instanceof Error ? error.message : String(error)}`]
    }
}

function normalizeRegexFlags(flags = '') {
    return [...new Set(flags.replace(/[^dgimsuvy]/g, '').split(''))].join('')
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
        cancelToolAppForTool(toolId)
        runtimes.get(toolId)?.host.terminate()
        runtimes.delete(toolId)
        return
    }
    for (const id of runtimes.keys()) cancelToolAppForTool(id)
    for (const runtime of runtimes.values()) runtime.host.terminate()
    runtimes.clear()
}

export async function exportTool(tool: RisuToolPackage, includeState = false) {
    const payload = await createToolExportPayloadV2(tool, includeState ? getToolStates()[tool.id] : undefined)
    await downloadFile(`${tool.namespace}.risutool`, Buffer.from(JSON.stringify(payload, null, 2)))
    notifySuccess(language.toolExported)
}

export async function createToolExportPayloadV2(tool: RisuToolPackage, state?: ToolPackageState): Promise<RisuToolExportV2> {
    const clean = safeStructuredClone(tool)
    clean.id = v4()
    clean.builtinId = undefined
    clean.readonly = false
    const assets: RisuToolExportV2['assets'] = []
    clean.assets = []
    for (const [index, asset] of (tool.assets ?? []).entries()) {
        const data = await readImage(asset[1])
        const placeholder = `__tool_asset:${index}`
        clean.assets.push([asset[0], placeholder, asset[2]])
        assets.push({ name: asset[0], extension: asset[2], data: Buffer.from(data).toString('base64') })
    }
    const payload: RisuToolExportV2 = { type: 'risuTool', version: 2, tool: clean, assets }
    if (state) payload.state = safeStructuredClone(state)
    return payload
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

export function parseToolExport(text: string): RisuToolExportV1 | RisuToolExportV2 {
    const payload = JSON.parse(text) as RisuToolExportV1 | RisuToolExportV2
    if (payload.type !== 'risuTool' || (payload.version !== 1 && payload.version !== 2) || !payload.tool) throw new Error('Invalid .risutool file.')
    payload.tool.functions ??= []
    payload.tool.variables ??= []
    payload.tool.lists ??= []
    payload.tool.regex ??= []
    payload.tool.functionRegex ??= []
    payload.tool.trigger ??= []
    payload.tool.assets ??= []
    payload.tool.lowLevelAccess ??= false
    payload.tool.plugin ??= { language: 'javascript', source: '', permissions: [] }
    payload.tool.plugin.apiVersion ??= 1
    payload.tool.plugin.permissions ??= []
    for (const fn of payload.tool.functions) {
        fn.id ||= v4()
        fn.parameters ??= []
        for (const parameter of fn.parameters) parameter.id ||= v4()
        fn.execution ??= { kind: 'script', allowedTools: [] }
        if (fn.execution.kind === 'script') fn.execution.allowedTools ??= []
        if (fn.execution.kind === 'agent') {
            fn.execution.allowedTools ??= []
            fn.execution.outputRoutes ??= []
            for (const route of fn.execution.outputRoutes) {
                route.id ||= v4()
                route.actions ??= []
                for (const action of route.actions) action.id ||= v4()
            }
        }
        fn.presentation ??= {}
    }
    for (const script of payload.tool.functionRegex) script.id ||= v4()
    for (const variable of payload.tool.variables) variable.id ||= v4()
    for (const list of payload.tool.lists) list.id ||= v4()
    if (payload.version === 2) payload.assets ??= []
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
        if (tool.lowLevelAccess && !(await alertConfirm(language.lowLevelAccessConfirm))) return
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
        if (payload.version === 2) {
            for (const [index, asset] of payload.assets.entries()) {
                const target = tool.assets?.find((entry) => entry[1] === `__tool_asset:${index}`)
                if (!target) throw new Error(`Missing tool asset manifest entry: ${index}`)
                target[1] = await saveAsset(Buffer.from(asset.data, 'base64'), '', asset.extension)
            }
        }
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
