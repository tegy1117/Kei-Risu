import { beforeEach, expect, test, vi } from 'vitest'
import type { RPCToolCallTextContent } from '../../mcplib'
import type { RisuToolPackage } from 'src/ts/process/tools/types'

let mockDb: any
let currentCharacter: any
let currentChat: any

const mocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  unloadToolRuntime: vi.fn(),
}))

vi.mock('src/lang', () => ({
  language: { mcpAccessPrompt: '{{tool}}: {{action}}' },
}))
vi.mock('src/ts/alert', () => ({ alertConfirm: mocks.alertConfirm, alertInput: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ fetchNative: vi.fn(), openURL: vi.fn() }))
vi.mock('src/ts/storage/database.svelte', () => ({
  getDatabase: () => mockDb,
  getCurrentCharacter: () => currentCharacter,
  getCurrentChat: () => currentChat,
}))
vi.mock('src/ts/process/tools/tools', () => ({
  toolWireName: (namespace: string, name: string) => `${namespace}__${name}`,
  unloadToolRuntime: mocks.unloadToolRuntime,
  validateToolPackage: () => [],
  validateToolPluginSource: async () => [],
}))
vi.mock('src/ts/process/mcp/mcp', () => ({ getMCPTools: vi.fn(async () => []) }))

import { ToolPackageHandler } from '../tools'

function sampleTool(overrides: Partial<RisuToolPackage> = {}): RisuToolPackage {
  return {
    id: 'tool-1',
    name: 'Sample',
    description: 'A tool',
    namespace: 'sample',
    version: '1.0.0',
    functions: [{ id: 'fn-1', name: 'run', description: '', enabled: true, parameters: [], execution: { kind: 'script' }, presentation: {} }],
    variables: [],
    lists: [],
    regex: [],
    trigger: [],
    assets: [['badge.svg', 'assets/private.svg', 'svg']],
    plugin: { language: 'javascript', source: "await risuai.registerFunction('run', async () => true)", permissions: [] },
    ...overrides,
  }
}

function payload(result: Awaited<ReturnType<ToolPackageHandler['handle']>>) {
  const block = result?.[0] as RPCToolCallTextContent
  return JSON.parse(block.text)
}

beforeEach(() => {
  vi.clearAllMocks()
  currentChat = { id: 'chat-1', tools: [] }
  currentCharacter = { chaId: 'char-1', tools: [], chats: [currentChat] }
  mockDb = {
    tools: [], enabledTools: [], toolStates: {}, toolPermissions: {},
    toolPolicy: { tools: {}, functions: {} },
    characters: [currentCharacter], modelPresets: [],
  }
})

test('exposes the complete tool authoring workflow', () => {
  const names = new ToolPackageHandler().getTools().map((tool) => tool.name)
  expect(names).toEqual([
    'risu-list-tools', 'risu-get-tool', 'risu-get-tool-authoring-context', 'risu-start-tool-draft',
    'risu-get-tool-draft', 'risu-edit-tool-draft', 'risu-validate-tool-draft', 'risu-commit-tool-draft',
    'risu-discard-tool-draft', 'risu-set-tool-activation', 'risu-set-tool-policy', 'risu-delete-tool',
  ])
})

test('publishes the canonical agent execution schema with a usable preset example', async () => {
  mockDb.modelPresets = [{ id: 'model-1', name: 'Model 1', toolUse: true }]
  const context = payload(await new ToolPackageHandler().handle('risu-get-tool-authoring-context', {}))

  expect(context.schemaVersion).toBe(3)
  expect(context.operationSchemas.setFunctionExecution.anyOf[0].properties).toHaveProperty('allowedTools')
  expect(context.operationSchemas.setFunctionPresentation.properties.manualLaunch.properties).toHaveProperty('includeInModelHistory')
  expect(context.operationSchemas.setPlugin.properties.apiVersion.enum).toEqual([1, 2])
  expect(context.invocationApiV2).toContain('openView')
  expect(context.invocationApiV2).toContain('commitChanges')
  expect(context.toolUiSdk).toContain('numberStepper')
  expect(context.authoringExamples.attackToolAppTemplate.source).toContain('invocation.listLorebooks()')
  expect(context.authoringExamples.attackToolAppTemplate.source).toContain('invocation.openView')
  expect(context.authoringExamples.attackToolAppTemplate.source).toContain('invocation.callTool')
  expect(context.authoringExamples.attackToolAppTemplate.source).toContain('invocation.commitChanges')
  expect(context.operationSchemas.setFunctionExecution.anyOf[1].required).toEqual([
    'kind', 'modelPresetId', 'systemPrompt', 'userPrompt', 'allowedTools', 'outputRoutes',
  ])
  expect(context.operationSchemas.setFunctionPresentation.properties).toHaveProperty('showInChat')
  expect(context.operationSchemas.functionRegex.properties.type.enum).toEqual([
    'arguments', 'agentOutput', 'modelResult', 'visibleCall', 'pendingCard', 'successCard', 'errorCard',
  ])
  expect(context.operationSchemas.functionRegex.properties.flag.description).toContain('<order N>')
  expect(context.draftOperationSchemas.upsertFunctionRegex.anyOf[0].required).toEqual(['kind', 'value', 'functionId'])
  expect(context.draftOperationSchemas.upsertFunctionRegex.anyOf[1].properties.value.required).toContain('functionId')
  expect(context.draftOperationSchemas.deleteFunctionRegex.required).toEqual(['kind', 'targetId'])
  expect(context.authoringExamples.setFunctionExecutionAgent).toMatchObject({
    kind: 'agent', modelPresetId: 'model-1', systemPrompt: expect.any(String), userPrompt: '{{tool_args}}', allowedTools: [],
  })
  expect(context.authoringExamples.setFunctionExecutionAgent.outputRoutes[0]).toMatchObject({
    pattern: '^(?<result>[\\s\\S]+)$', outcome: 'success', modelTemplate: '{{tool_capture::result}}', actions: [],
  })
  expect(context.authoringNotes.join('\n')).toContain('no separate agent model registry')
})

test('publishes discriminated schemas directly on the draft editing tool', () => {
  const editTool = new ToolPackageHandler().getTools().find((tool) => tool.name === 'risu-edit-tool-draft')
  const variants = (editTool?.inputSchema as any).properties.operations.items.anyOf
  expect(variants).toHaveLength(20)
  const kindOf = (schema: any) => (schema.properties ?? schema.anyOf[0].properties).kind.enum[0]
  expect(variants.find((schema: any) => kindOf(schema) === 'setFunctionPresentation').properties.value.properties)
    .toHaveProperty('showInChat')
  expect(variants.find((schema: any) => kindOf(schema) === 'upsertFunctionRegex').anyOf[0].required)
    .toEqual(['kind', 'value', 'functionId'])
})

test('normalizes reported agent authoring aliases into the canonical saved shape', async () => {
  mockDb.modelPresets = [{ id: 'model-1', name: 'Model 1', toolUse: true }]
  const handler = new ToolPackageHandler()
  const started = payload(await handler.handle('risu-start-tool-draft', { mode: 'create' }))
  const withFunction = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{ kind: 'upsertFunction', value: { id: 'fn-agent', name: 'analyze', description: 'Analyze' } }],
  }))
  expect(withFunction.tool.functions[0].id).toBe('fn-agent')

  const edited = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{
      kind: 'setFunctionExecution',
      functionId: 'fn-agent',
      value: {
        kind: 'agent',
        modelPreset: 'model-1',
        prompts: [
          { role: 'system', content: 'Analyze carefully.' },
          { role: 'user', content: '{{tool_args}}' },
        ],
        allowedTools: [],
        outputRoutes: [{
          name: 'Success', pattern: '^(?<result>[\\s\\S]+)$', outcome: 'success',
          modelResultTemplate: '{{tool_capture::result}}', actions: [],
        }],
      },
    }],
  }))

  expect(edited.tool.functions[0].execution).toMatchObject({
    kind: 'agent', modelPresetId: 'model-1', systemPrompt: 'Analyze carefully.', userPrompt: '{{tool_args}}', allowedTools: [],
  })
  expect(edited.tool.functions[0].execution).not.toHaveProperty('modelPreset')
  expect(edited.tool.functions[0].execution).not.toHaveProperty('prompts')
  expect(edited.tool.functions[0].execution.outputRoutes[0]).toMatchObject({
    modelTemplate: '{{tool_capture::result}}', actions: [],
  })
  expect(edited.tool.functions[0].execution.outputRoutes[0]).not.toHaveProperty('modelResultTemplate')
  expect(edited.warnings.join('\n')).toContain('execution.modelPreset was normalized')
  expect(edited.warnings.join('\n')).toContain('execution.prompts was normalized')
  expect(edited.warnings.join('\n')).toContain('modelResultTemplate was normalized')
})

test('normalizes string agentPrompt and resultTemplate aliases', async () => {
  mockDb.modelPresets = [{ id: 'model-1', name: 'Model 1', toolUse: false }]
  const handler = new ToolPackageHandler()
  const started = payload(await handler.handle('risu-start-tool-draft', { mode: 'create' }))
  await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{ kind: 'upsertFunction', value: { id: 'fn-agent', name: 'analyze' } }],
  })
  const edited = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{
      kind: 'setFunctionExecution', functionId: 'fn-agent', value: {
        kind: 'agent', modelPresetId: 'model-1', agentPrompt: 'Do the work.',
        outputRoutes: [{ name: 'Success', pattern: '^(?<result>.+)$', outcome: 'success', resultTemplate: '{{tool_capture::result}}' }],
      },
    }],
  }))

  expect(edited.tool.functions[0].execution).toMatchObject({ systemPrompt: '', userPrompt: 'Do the work.', allowedTools: [] })
  expect(edited.tool.functions[0].execution.outputRoutes[0]).toMatchObject({ modelTemplate: '{{tool_capture::result}}', actions: [] })

  const promptsEdited = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{
      kind: 'setFunctionExecution', functionId: 'fn-agent', value: {
        kind: 'agent', modelPresetId: 'model-1', prompts: 'Do the work again.',
        outputRoutes: [{ name: 'Success', pattern: '^(?<result>.+)$', outcome: 'success', modelTemplate: '{{tool_capture::result}}' }],
      },
    }],
  }))
  expect(promptsEdited.tool.functions[0].execution).toMatchObject({ systemPrompt: '', userPrompt: 'Do the work again.' })
  expect(promptsEdited.warnings.join('\n')).toContain('execution.prompts was normalized')
})

test('rejects conflicting canonical agent fields and malformed prompt arrays', async () => {
  const handler = new ToolPackageHandler()
  const started = payload(await handler.handle('risu-start-tool-draft', { mode: 'create' }))
  await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{ kind: 'upsertFunction', value: { id: 'fn-agent', name: 'analyze' } }],
  })

  await expect(handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{
      kind: 'setFunctionExecution', functionId: 'fn-agent', value: {
        kind: 'agent', modelPresetId: 'canonical', modelPreset: 'alias', outputRoutes: [],
      },
    }],
  })).rejects.toThrow('conflicts with canonical field execution.modelPresetId')

  await expect(handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{
      kind: 'setFunctionExecution', functionId: 'fn-agent', value: {
        kind: 'agent', modelPresetId: 'model-1', prompts: [{ role: 'assistant', content: 'bad' }], outputRoutes: [],
      },
    }],
  })).rejects.toThrow('role must be system or user')
})

test('sanitizes asset paths when reading a tool', async () => {
  mockDb.tools = [sampleTool()]
  const result = payload(await new ToolPackageHandler().handle('risu-get-tool', { id: 'tool-1' }))
  expect(result.tool.assets).toEqual([{ name: 'badge.svg', extension: 'svg' }])
  expect(result.promptPolicy).toEqual({
    tool: 'inherit',
    functions: [{ id: 'fn-1', name: 'run', wireName: 'sample__run', policy: 'inherit' }],
  })
  expect(JSON.stringify(result)).not.toContain('assets/private.svg')
})

test('edits presentation and every function regex stage through canonical operations', async () => {
  const handler = new ToolPackageHandler()
  const started = payload(await handler.handle('risu-start-tool-draft', { mode: 'create' }))
  await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [
      { kind: 'upsertFunction', value: { id: 'fn-agent', name: 'analyze' } },
      {
        kind: 'setFunctionExecution', functionId: 'fn-agent', value: {
          kind: 'agent', modelPresetId: 'model-1', systemPrompt: '', userPrompt: '{{tool_args}}', allowedTools: [], outputRoutes: [],
        },
      },
      {
        kind: 'setFunctionPresentation', functionId: 'fn-agent', value: {
          showInChat: false, pendingTemplate: 'pending', successTemplate: 'success', errorTemplate: 'error',
        },
      },
    ],
  })
  const stages = ['arguments', 'agentOutput', 'modelResult', 'visibleCall', 'pendingCard', 'successCard', 'errorCard']
  const edited = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: stages.map((type, index) => ({
      kind: 'upsertFunctionRegex', functionId: 'fn-agent',
      value: { comment: type, in: 'x', out: 'y', type, flag: `gi<order ${index}>`, ableFlag: true, enabled: index !== 0 },
    })),
  }))

  expect(edited.tool.functions[0].presentation).toEqual({
    showInChat: false, pendingTemplate: 'pending', successTemplate: 'success', errorTemplate: 'error',
  })
  expect(edited.tool.functionRegex.map((script: any) => script.type)).toEqual(stages)
  expect(edited.tool.functionRegex[6]).toMatchObject({ functionId: 'fn-agent', flag: 'gi<order 6>', enabled: true })
  expect(new Set(edited.tool.functionRegex.map((script: any) => script.id)).size).toBe(7)

  const switched = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{ kind: 'setFunctionExecution', functionId: 'fn-agent', value: { kind: 'script' } }],
  }))
  expect(switched.tool.functionRegex.map((script: any) => script.type)).not.toContain('agentOutput')
  expect(switched.tool.functionRegex.map((script: any) => script.type)).not.toContain('visibleCall')
  expect(switched.tool.functionRegex).toHaveLength(5)
})

test('normalizes legacy function regex IDs and rejects conflicting envelopes', async () => {
  const handler = new ToolPackageHandler()
  const started = payload(await handler.handle('risu-start-tool-draft', { mode: 'create' }))
  await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{ kind: 'upsertFunction', value: { id: 'fn-1', name: 'run' } }],
  })
  const edited = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{
      kind: 'upsertFunctionRegex',
      value: { id: 'regex-1', functionId: 'fn-1', comment: 'legacy', in: 'x', out: 'y', type: 'arguments' },
    }],
  }))
  expect(edited.tool.functionRegex[0]).toMatchObject({ id: 'regex-1', functionId: 'fn-1' })
  expect(edited.warnings.join('\n')).toContain('value.id was normalized')
  expect(edited.warnings.join('\n')).toContain('value.functionId was normalized')

  await expect(handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [{
      kind: 'upsertFunctionRegex', targetId: 'canonical', functionId: 'fn-1',
      value: { id: 'alias', comment: 'conflict', in: 'x', out: 'y', type: 'arguments' },
    }],
  })).rejects.toThrow('conflicts with operation.targetId')
})

test('keeps draft edits in memory and commits once after approval', async () => {
  const handler = new ToolPackageHandler()
  const started = payload(await handler.handle('risu-start-tool-draft', { mode: 'create' }))
  const edited = payload(await handler.handle('risu-edit-tool-draft', {
    draftId: started.draftId,
    operations: [
      { kind: 'setMetadata', value: { name: 'Created', description: 'Made by MCP', namespace: 'created' } },
      { kind: 'upsertFunction', value: { name: 'run', description: 'Run it' } },
      { kind: 'setPlugin', value: { source: "await risuai.registerFunction('run', async () => true)" } },
      { kind: 'setModuleFeatures', value: { lowLevelAccess: true, customToggle: 'enabled=Enabled' } },
    ],
  }))
  expect(mockDb.tools).toEqual([])
  expect(edited.tool.lowLevelAccess).toBe(true)

  mocks.alertConfirm.mockResolvedValueOnce(false)
  expect(payload(await handler.handle('risu-commit-tool-draft', { draftId: started.draftId }))).toMatchObject({ committed: false })
  expect(mockDb.tools).toEqual([])

  mocks.alertConfirm.mockResolvedValueOnce(true)
  const committed = payload(await handler.handle('risu-commit-tool-draft', { draftId: started.draftId }))
  expect(committed.committed).toBe(true)
  expect(mockDb.tools[0]).toMatchObject({ name: 'Created', namespace: 'created', lowLevelAccess: true })
  expect(mockDb.enabledTools).toEqual([])
  expect(mocks.alertConfirm).toHaveBeenCalledTimes(2)
})

test('protects built-ins from edit and delete while allowing clone', async () => {
  mockDb.tools = [sampleTool({ id: 'builtin', builtinId: 'question', readonly: true })]
  const handler = new ToolPackageHandler()
  await expect(handler.handle('risu-start-tool-draft', { mode: 'edit', toolId: 'builtin' })).rejects.toThrow('clone')
  await expect(handler.handle('risu-delete-tool', { id: 'builtin' })).rejects.toThrow('Built-in')
  const clone = payload(await handler.handle('risu-start-tool-draft', { mode: 'clone', toolId: 'builtin' }))
  expect(clone.tool).toMatchObject({ readonly: false })
  expect(clone.tool.builtinId).toBeUndefined()
  expect(clone.tool.id).not.toBe('builtin')
})

test('rejects an edit draft when the saved tool changed concurrently', async () => {
  mockDb.tools = [sampleTool()]
  const handler = new ToolPackageHandler()
  const draft = payload(await handler.handle('risu-start-tool-draft', { mode: 'edit', toolId: 'tool-1' }))
  mockDb.tools[0].description = 'Changed elsewhere'
  await expect(handler.handle('risu-commit-tool-draft', { draftId: draft.draftId })).rejects.toThrow('changed while the draft was open')
  expect(mocks.alertConfirm).not.toHaveBeenCalled()
})

test('migrates policy and clears cached plugin permissions when an edit is committed', async () => {
  mockDb.tools = [sampleTool()]
  mockDb.toolPolicy.tools.sample = 'on'
  mockDb.toolPolicy.functions.sample__run = 'off'
  mockDb.toolPermissions['tool-1'] = { cached: true }
  const handler = new ToolPackageHandler()
  const draft = payload(await handler.handle('risu-start-tool-draft', { mode: 'edit', toolId: 'tool-1' }))
  await handler.handle('risu-edit-tool-draft', {
    draftId: draft.draftId,
    operations: [
      { kind: 'setMetadata', value: { namespace: 'renamed' } },
      { kind: 'upsertFunction', targetId: 'fn-1', value: { name: 'execute' } },
      { kind: 'setPlugin', value: { source: "await risuai.registerFunction('execute', async () => true)" } },
    ],
  })
  mocks.alertConfirm.mockResolvedValueOnce(true)
  expect(payload(await handler.handle('risu-commit-tool-draft', { draftId: draft.draftId })).committed).toBe(true)
  expect(mockDb.toolPolicy).toEqual({ tools: { renamed: 'on' }, functions: { renamed__execute: 'off' } })
  expect(mockDb.toolPermissions['tool-1']).toBeUndefined()
  expect(mocks.unloadToolRuntime).toHaveBeenCalledWith('tool-1')
})

test('changes activation only after confirmation', async () => {
  mockDb.tools = [sampleTool()]
  const handler = new ToolPackageHandler()
  mocks.alertConfirm.mockResolvedValueOnce(false)
  expect(payload(await handler.handle('risu-set-tool-activation', { id: 'tool-1', scope: 'chat', enabled: true })).updated).toBe(false)
  expect(currentChat.tools).toEqual([])
  mocks.alertConfirm.mockResolvedValueOnce(true)
  expect(payload(await handler.handle('risu-set-tool-activation', { id: 'tool-1', scope: 'chat', enabled: true })).updated).toBe(true)
  expect(currentChat.tools).toEqual(['tool-1'])
})

test('reads and changes tool and function prompt policy only after confirmation', async () => {
  mockDb.tools = [sampleTool({ readonly: true, builtinId: 'question' })]
  const handler = new ToolPackageHandler()

  mocks.alertConfirm.mockResolvedValueOnce(false)
  expect(payload(await handler.handle('risu-set-tool-policy', {
    id: 'tool-1', level: 'tool', policy: 'on',
  })).updated).toBe(false)
  expect(mockDb.toolPolicy).toEqual({ tools: {}, functions: {} })

  mocks.alertConfirm.mockResolvedValueOnce(true)
  const toolUpdated = payload(await handler.handle('risu-set-tool-policy', {
    id: 'tool-1', level: 'tool', policy: 'on',
  }))
  expect(toolUpdated.promptPolicy.tool).toBe('on')
  expect(mockDb.toolPolicy.tools.sample).toBe('on')

  mocks.alertConfirm.mockResolvedValueOnce(true)
  const functionUpdated = payload(await handler.handle('risu-set-tool-policy', {
    id: 'tool-1', level: 'function', functionId: 'fn-1', policy: 'off',
  }))
  expect(functionUpdated.promptPolicy.functions[0].policy).toBe('off')
  expect(mockDb.toolPolicy.functions.sample__run).toBe('off')

  mocks.alertConfirm.mockResolvedValueOnce(true)
  await handler.handle('risu-set-tool-policy', { id: 'tool-1', level: 'function', functionId: 'fn-1', policy: 'inherit' })
  expect(mockDb.toolPolicy.functions).toEqual({})
  expect(payload(await handler.handle('risu-list-tools', {}))[0].promptPolicy.tool).toBe('on')

  await expect(handler.handle('risu-set-tool-policy', {
    id: 'tool-1', level: 'function', functionId: 'missing', policy: 'on',
  })).rejects.toThrow('Function missing not found')
  await expect(handler.handle('risu-set-tool-policy', {
    id: 'tool-1', level: 'tool', functionId: 'fn-1', policy: 'on',
  })).rejects.toThrow('functionId is only valid')
})

test('deletes user tools and cleans activation, state, permission, policy, and chat references', async () => {
  mockDb.tools = [sampleTool()]
  mockDb.enabledTools = ['tool-1']
  mockDb.toolStates['tool-1'] = { global: {} }
  mockDb.toolPermissions['tool-1'] = { permission: true }
  mockDb.toolPolicy.tools.sample = 'on'
  mockDb.toolPolicy.functions.sample__run = 'on'
  currentCharacter.tools = ['tool-1']
  currentChat.tools = ['tool-1']
  mocks.alertConfirm.mockResolvedValueOnce(true)

  const result = payload(await new ToolPackageHandler().handle('risu-delete-tool', { id: 'tool-1' }))
  expect(result.deleted).toBe(true)
  expect(mockDb.tools).toEqual([])
  expect(mockDb.enabledTools).toEqual([])
  expect(currentCharacter.tools).toEqual([])
  expect(currentChat.tools).toEqual([])
  expect(mockDb.toolStates['tool-1']).toBeUndefined()
  expect(mockDb.toolPermissions['tool-1']).toBeUndefined()
  expect(mockDb.toolPolicy).toEqual({ tools: {}, functions: {} })
  expect(mocks.unloadToolRuntime).toHaveBeenCalledWith('tool-1')
})
