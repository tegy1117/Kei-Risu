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
    'risu-discard-tool-draft', 'risu-set-tool-activation', 'risu-delete-tool',
  ])
})

test('sanitizes asset paths when reading a tool', async () => {
  mockDb.tools = [sampleTool()]
  const result = payload(await new ToolPackageHandler().handle('risu-get-tool', { id: 'tool-1' }))
  expect(result.tool.assets).toEqual([{ name: 'badge.svg', extension: 'svg' }])
  expect(JSON.stringify(result)).not.toContain('assets/private.svg')
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
