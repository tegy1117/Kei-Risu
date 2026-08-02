import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RisuToolPackage } from './types'

let mockDb: any
const requestMocks = vi.hoisted(() => ({
    requestAgentModelPreset: vi.fn(),
}))

vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(), alertInput: vi.fn(), alertSelect: vi.fn(),
    notifyError: vi.fn(), notifySuccess: vi.fn(),
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    downloadFile: vi.fn(), fetchNative: vi.fn(), saveAsset: vi.fn(),
    readImage: vi.fn(async () => Uint8Array.from([60, 115, 118, 103, 47, 62])),
}))
vi.mock('src/ts/plugins/apiV3/transpiler', () => ({ pluginCodeTranspiler: vi.fn((source) => source) }))
vi.mock('src/ts/plugins/apiV3/factory', () => ({ SandboxHost: class {} }))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
    setDatabase: vi.fn(),
    getCurrentCharacter: () => undefined,
    getCurrentChat: () => undefined,
}))
vi.mock('src/ts/parser/parser.svelte', () => ({ hasher: vi.fn(() => 'hash') }))
vi.mock('src/ts/util', () => ({ selectSingleFile: vi.fn() }))
vi.mock('../mcp/mcp', () => ({ getTools: vi.fn(async () => []) }))
vi.mock('../request/request', () => ({ requestAgentModelPreset: requestMocks.requestAgentModelPreset }))

import { createBuiltinTools, reconcileBuiltinTools } from './builtins'
import { getToolTriggers } from './features'
import {
    createToolScopeStateSnapshot,
    createToolExportPayload,
    createToolExportPayloadV2,
    createMemoryToolResult,
    callManagedToolDetailed,
    deleteToolScopeState,
    parseToolExport,
    readToolScopeState,
    resolveActiveToolPackages,
    routeAgentOutput,
    toolWireName,
    validateToolScopeState,
    validateToolPackage,
    validateToolPluginSource,
    writeToolScopeState,
} from './tools'

function sampleTool(): RisuToolPackage {
    return {
        id: 'tool-1', name: 'Sample', description: 'Sample tool', namespace: 'sample', version: '1.0.0',
        functions: [
            { id: 'fn-a', name: 'alpha', description: 'Alpha', enabled: true, parameters: [] },
            { id: 'fn-b', name: 'beta', description: 'Beta', enabled: false, parameters: [] },
        ],
        variables: [], lists: [],
        plugin: { language: 'javascript', source: '', permissions: [] },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    requestMocks.requestAgentModelPreset.mockResolvedValue({ ok: true, text: 'OK:door-a', model: 'model' })
    mockDb = { tools: [], enabledTools: [], toolStates: {}, toolPermissions: {}, toolPolicy: { tools: {}, functions: {} } }
})

describe('built-in tool packages', () => {
    test('ships Dice, Question, Localtime, and Memory as read-only packages', () => {
        const tools = createBuiltinTools()
        expect(tools.map((tool) => tool.builtinId)).toEqual(['dice', 'question', 'localtime', 'memory'])
        expect(tools.every((tool) => tool.readonly)).toBe(true)
        expect(tools.find((tool) => tool.builtinId === 'dice')?.functions[0].parameters.find((parameter) => parameter.name === 'kind')?.enum)
            .toEqual(['coin', 'd4', 'd6', 'd10', 'd20', 'd100', 'range'])
        expect(tools.find((tool) => tool.builtinId === 'memory')?.functions.map((fn) => fn.name))
            .toEqual(['list', 'search', 'read', 'upsert', 'delete'])
    })

    test('refreshes bundled definitions while preserving function switches and user tools', () => {
        const current = createBuiltinTools()
        current[0].functions[0].enabled = false
        current[0].description = 'stale'
        const userTool = sampleTool()
        const reconciled = reconcileBuiltinTools([...current, userTool])
        expect(reconciled[0].description).not.toBe('stale')
        expect(reconciled[0].functions[0].enabled).toBe(false)
        expect(reconciled.at(-1)).toMatchObject(userTool)
        expect(reconciled.at(-1)?.functions[0].execution).toEqual({ kind: 'script' })
    })

    test('each bundled plugin registers every declared function', async () => {
        for (const tool of createBuiltinTools()) {
            const handlers = new Map<string, Function>()
            const risuai = new Proxy({
                registerFunction: async (name: string, handler: Function) => { handlers.set(name, handler) },
            }, { get: (target, key) => (target as any)[key] ?? vi.fn() })
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
            await new AsyncFunction('risuai', tool.plugin.source)(risuai)
            expect([...handlers.keys()]).toEqual(tool.functions.map((fn) => fn.name))
        }
    })
})

describe('memory tool results', () => {
    test('returns a structured-cloneable tag array when stored state is reactive', () => {
        const reactiveTags = new Proxy(['character', 'plot'], {})
        const result = createMemoryToolResult('chat', {
            id: 'memory-1', title: 'Title', content: 'Content', tags: reactiveTags,
            importance: 3, createdAt: 1, updatedAt: 2,
        })

        expect(result.tags).toEqual(['character', 'plot'])
        expect(() => structuredClone(result)).not.toThrow()
    })
})

describe('tool state management', () => {
    test('creates a cloneable snapshot from reactive state', () => {
        const state = createToolScopeStateSnapshot({
            variables: { count: 2 },
            lists: { names: new Proxy(['A', 'B'], {}) },
            memories: [{
                id: 'm1', title: 'Title', content: 'Content', tags: new Proxy(['plot'], {}),
                importance: 3, createdAt: 1, updatedAt: 2,
            }],
        })
        expect(state.lists.names).toEqual(['A', 'B'])
        expect(state.memories?.[0].tags).toEqual(['plot'])
        expect(() => structuredClone(state)).not.toThrow()
    })

    test('reads, writes, and deletes an isolated scope', () => {
        writeToolScopeState('tool-1', 'chat', 'chat-1', { variables: { count: 1 }, lists: {} })
        const read = readToolScopeState('tool-1', 'chat', 'chat-1')
        read.variables.count = 9
        expect(readToolScopeState('tool-1', 'chat', 'chat-1').variables.count).toBe(1)
        expect(deleteToolScopeState('tool-1', 'chat', 'chat-1')).toBe(true)
        expect(readToolScopeState('tool-1', 'chat', 'chat-1')).toEqual({ variables: {}, lists: {}, memories: [] })
    })

    test('validates declared values, lists, and memories', () => {
        const tool = sampleTool()
        tool.variables = [{ id: 'v1', name: 'count', description: '', type: 'number', scope: 'global', defaultValue: 0 }]
        tool.lists = [{ id: 'l1', name: 'labels', description: '', itemType: 'string', scope: 'global', defaultItems: [] }]
        const errors = validateToolScopeState(tool, 'global', {
            variables: { count: 'wrong' },
            lists: { labels: [1] },
            memories: [{ id: 'm1', title: '', content: '', tags: [], importance: 8, createdAt: 1, updatedAt: 2 }],
        })
        expect(errors.join('\n')).toContain('expected number')
        expect(errors.join('\n')).toContain('expected string')
        expect(errors.join('\n')).toContain('Memory title and content are required')
        expect(errors.join('\n')).toContain('Invalid importance')
    })
})

describe('tool package validation', () => {
    test('validates plugin syntax and managed feature structures', async () => {
        const tool = sampleTool()
        tool.plugin.source = 'await risuai.registerFunction('
        tool.lowLevelAccess = true
        tool.regex = [{ comment: 'bad', in: '[', out: '', type: 'editdisplay', ableFlag: true, flag: 'g' }]
        tool.trigger = [{ comment: 'bad', type: 'manual', conditions: [], effect: [{ type: '' } as never] }]
        expect(validateToolPackage(tool).join('\n')).toContain('Invalid regex script')
        expect(validateToolPackage(tool).join('\n')).toContain('Invalid trigger effect')
        expect((await validateToolPluginSource(tool)).join('\n')).toContain('Plugin source is invalid')
    })

    test('reports malformed nested agent settings instead of throwing', () => {
        const tool = sampleTool()
        tool.plugin.permissions = 'network' as never
        tool.functions[0].execution = {
            kind: 'agent', modelPresetId: 'model-1', systemPrompt: 1,
            userPrompt: null, allowedTools: 'bad', outputRoutes: { bad: true },
        } as never

        expect(() => validateToolPackage(tool)).not.toThrow()
        const errors = validateToolPackage(tool).join('\n')
        expect(errors).toContain('Plugin permissions must be an array')
        expect(errors).toContain('execution.systemPrompt and execution.userPrompt must both be text')
        expect(errors).toContain('Allowed tools must be an array')
        expect(errors).toContain('At least one output route is required')
    })

    test('reports canonical agent route fields and rejects invalid route metadata', () => {
        const tool = sampleTool()
        tool.functions[0].execution = {
            kind: 'agent', modelPresetId: 'model-1', systemPrompt: '', userPrompt: 'prompt', allowedTools: [],
            outputRoutes: [{
                id: 'route-1', name: 'Route', pattern: '.*', flags: 1, outcome: 'unknown',
                modelTemplate: '', actions: [],
            }],
        } as never

        const errors = validateToolPackage(tool).join('\n')
        expect(errors).toContain('Output route outcome must be success or error')
        expect(errors).toContain('Output route flags must be text')
        expect(errors).toContain('Output route modelTemplate is required')
    })

    test('passes approved low-level access to active tool triggers', () => {
        const tool = sampleTool()
        tool.lowLevelAccess = true
        tool.trigger = [{ comment: 'lua', type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: 'print(1)' }] }]
        mockDb.tools = [tool]
        mockDb.enabledTools = [tool.id]
        expect(getToolTriggers()[0].lowLevelAccess).toBe(true)
        tool.lowLevelAccess = false
        expect(getToolTriggers()[0].lowLevelAccess).toBe(false)
    })
})

describe('tool activation policy', () => {
    test('inherits package activation and declared function switches', () => {
        const tool = sampleTool()
        const active = resolveActiveToolPackages([tool], [tool.id], { tools: {}, functions: {} })
        expect(active[0].functions.map((fn) => fn.name)).toEqual(['alpha'])
    })

    test('prompt policy can force a package on and independently override functions', () => {
        const tool = sampleTool()
        const active = resolveActiveToolPackages([tool], [], {
            tools: { sample: 'on' },
            functions: { [toolWireName('sample', 'alpha')]: 'off', [toolWireName('sample', 'beta')]: 'on' },
        })
        expect(active[0].functions.map((fn) => fn.name)).toEqual(['beta'])
    })

    test('package off blocks all functions even when its scope and a function are on', () => {
        const tool = sampleTool()
        expect(resolveActiveToolPackages([tool], [tool.id], {
            tools: { sample: 'off' }, functions: { sample__alpha: 'on' },
        })).toEqual([])
    })
})

describe('sub-agent output routing', () => {
    test('publishes a nested tool-agent status under the request that invoked it', async () => {
        const tool = sampleTool()
        tool.functions[0].execution = {
            kind: 'agent', modelPresetId: 'model-1', systemPrompt: 'system', userPrompt: 'prompt', allowedTools: [],
            outputRoutes: [{ id: 'ok', name: 'ok', pattern: '^OK:(?<choice>.+)$', outcome: 'success', modelTemplate: '{{tool_capture::choice}}', actions: [] }],
        }
        mockDb = {
            ...mockDb,
            tools: [tool],
            enabledTools: [tool.id],
            modelPresets: [{ id: 'model-1', name: 'Model', toolUse: false }],
        }

        const result = await callManagedToolDetailed(toolWireName(tool.namespace, 'alpha'), {}, {
            stack: [],
            requestStatusId: 'parent-request',
        })

        expect(result?.success).toBe(true)
        expect(requestMocks.requestAgentModelPreset).toHaveBeenCalledOnce()
        expect(requestMocks.requestAgentModelPreset.mock.calls[0][0]).toMatchObject({
            toolExecutionContext: { stack: ['sample__alpha'], requestStatusId: 'parent-request' },
            requestStatus: { kind: 'tool-agent', label: 'Sample · alpha', parentId: 'parent-request' },
        })
        expect(requestMocks.requestAgentModelPreset.mock.calls[0][0].chatId).toMatch(/^tool-agent:/)
    })

    test('uses the first matching regex, exposes decisions, and commits state updates', async () => {
        const tool = sampleTool()
        tool.variables = [{ id: 'v1', name: 'decision', description: '', type: 'string', scope: 'global', defaultValue: '' }]
        const routed = await routeAgentOutput(tool, tool.functions[0], [
            { id: 'skip', name: 'skip', pattern: '^NO$', outcome: 'error', modelTemplate: 'no', actions: [] },
            {
                id: 'ok', name: 'ok', pattern: '^OK:(?<choice>.+)$', outcome: 'success',
                modelTemplate: 'Selected {{tool_capture::choice}}', cardTemplate: 'Decision: {{tool_capture::choice}}',
                actions: [{ id: 'a1', kind: 'setVariable', name: 'decision', valueTemplate: '{{tool_capture::choice}}' }],
            },
        ], {}, 'OK:door-a')
        expect(routed?.response).toEqual([{ type: 'text', text: 'Selected door-a' }])
        expect(routed?.presentation?.captures).toEqual({ choice: 'door-a' })
        expect(routed?.presentation?.stateUpdates).toEqual([{ kind: 'setVariable', scope: 'global', name: 'decision', value: 'door-a' }])
        expect(readToolScopeState(tool.id, 'global').variables.decision).toBe('door-a')
    })

    test('returns no result when raw output matches no configured route', async () => {
        const tool = sampleTool()
        expect(await routeAgentOutput(tool, tool.functions[0], [{ id: 'only', name: 'only', pattern: '^OK$', outcome: 'success', modelTemplate: 'ok', actions: [] }], {}, 'unexpected')).toBeNull()
    })
})

describe('.risutool definition format', () => {
    test('exports a cloneable definition and includes state only when requested', () => {
        const tool = { ...sampleTool(), builtinId: 'question', readonly: true } as RisuToolPackage
        const withoutState = createToolExportPayload(tool)
        expect(withoutState.tool.id).not.toBe(tool.id)
        expect(withoutState.tool.builtinId).toBeUndefined()
        expect(withoutState.tool.readonly).toBe(false)
        expect(withoutState.state).toBeUndefined()

        const withState = createToolExportPayload(tool, { global: { variables: { count: 1 }, lists: {} } })
        expect(withState.state?.global?.variables.count).toBe(1)
    })

    test('parses v1 and fills optional collections from older files', () => {
        const tool = sampleTool() as any
        delete tool.variables
        delete tool.lists
        tool.plugin = { language: 'javascript', source: '' }
        const parsed = parseToolExport(JSON.stringify({ type: 'risuTool', version: 1, tool }))
        expect(parsed.tool.variables).toEqual([])
        expect(parsed.tool.lists).toEqual([])
        expect(parsed.tool.plugin.permissions).toEqual([])
        expect(parsed.tool.functions[0].execution).toEqual({ kind: 'script' })
        expect(parsed.tool.regex).toEqual([])
        expect(parsed.tool.trigger).toEqual([])
        expect(parsed.tool.assets).toEqual([])
    })

    test('parses a self-contained v2 definition with agent routes and assets', () => {
        const tool = sampleTool()
        tool.assets = [['badge.svg', '__tool_asset:0', 'svg']]
        tool.functions[0].execution = {
            kind: 'agent', modelPresetId: 'model-1', systemPrompt: 'system', userPrompt: '{{tool_args}}', allowedTools: [],
            outputRoutes: [{ id: 'route-1', name: 'ok', pattern: '^(?<value>.+)$', outcome: 'success', modelTemplate: '{{tool_capture::value}}', actions: [] }],
        }
        const parsed = parseToolExport(JSON.stringify({ type: 'risuTool', version: 2, tool, assets: [{ name: 'badge.svg', extension: 'svg', data: 'PHN2Zy8+' }] }))
        expect(parsed.version).toBe(2)
        expect(parsed.tool.functions[0].execution?.kind).toBe('agent')
        expect(parsed.tool.assets?.[0][1]).toBe('__tool_asset:0')
        if (parsed.version === 2) expect(parsed.assets[0].name).toBe('badge.svg')
    })

    test('embeds asset bytes and replaces stored paths in a v2 export', async () => {
        const tool = sampleTool()
        tool.assets = [['badge.svg', 'assets/local.svg', 'svg']]
        const exported = await createToolExportPayloadV2(tool)
        expect(exported.version).toBe(2)
        expect(exported.tool.assets).toEqual([['badge.svg', '__tool_asset:0', 'svg']])
        expect(Buffer.from(exported.assets[0].data, 'base64').toString()).toBe('<svg/>')
    })

    test('rejects an unsupported payload', () => {
        expect(() => parseToolExport('{"type":"other"}')).toThrow('Invalid .risutool file.')
    })
})

describe('tool validation', () => {
    test('guards namespaces, duplicate functions, parameters, and package collisions', () => {
        const tool = sampleTool()
        tool.namespace = 'not valid'
        tool.functions.push({ ...tool.functions[0], id: 'duplicate' })
        tool.functions[0].parameters = [
            { id: 'p1', name: 'arg', description: '', type: 'string' },
            { id: 'p2', name: 'arg', description: '', type: 'string' },
        ]
        const errors = validateToolPackage(tool, [{ ...sampleTool(), id: 'other' }])
        expect(errors.join('\n')).toContain('Namespace may contain')
        expect(errors.join('\n')).toContain('Duplicate function name')
        expect(errors.join('\n')).toContain('Duplicate parameter')
        expect(validateToolPackage(sampleTool(), [{ ...sampleTool(), id: 'other' }]).join('\n')).toContain('already in use')
    })
})
