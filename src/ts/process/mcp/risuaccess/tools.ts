import { language } from 'src/lang'
import { alertConfirm } from 'src/ts/alert'
import { safeStructuredClone } from 'src/ts/polyfill'
import { getCurrentCharacter, getCurrentChat, getDatabase } from 'src/ts/storage/database.svelte'
import {
  createManagedToolPackage,
  deleteManagedToolPackage,
  getToolActivation,
  replaceManagedToolPackage,
  setToolActivation,
  type ToolActivationScope,
} from 'src/ts/process/tools/management'
import { validateToolPackage, validateToolPluginSource } from 'src/ts/process/tools/tools'
import type {
  RisuToolFunction,
  RisuToolList,
  RisuToolPackage,
  RisuToolParameter,
  RisuToolVariable,
  ToolFunctionExecution,
  ToolFunctionPresentation,
  ToolPermission,
} from 'src/ts/process/tools/types'
import { v4 } from 'uuid'
import { type MCPTool, MCPToolHandler, type RPCToolCallContent } from '../mcplib'

type DraftMode = 'create' | 'edit' | 'clone'
type DraftActivation = 'unchanged' | 'disabled' | ToolActivationScope

interface ToolDraft {
  id: string
  mode: DraftMode
  tool: RisuToolPackage
  sourceToolId?: string
  baseFingerprint?: string
  activation: DraftActivation
}

interface DraftOperation {
  kind: string
  targetId?: string
  functionId?: string
  index?: number
  scope?: DraftActivation
  value?: unknown
}

const operationKinds = [
  'setMetadata',
  'upsertFunction',
  'deleteFunction',
  'upsertParameter',
  'deleteParameter',
  'setFunctionExecution',
  'setFunctionPresentation',
  'upsertVariable',
  'deleteVariable',
  'upsertList',
  'deleteList',
  'setModuleFeatures',
  'upsertRegex',
  'deleteRegex',
  'upsertTrigger',
  'deleteTrigger',
  'setPlugin',
  'setActivation',
] as const

const toolIdSchema = {
  id: { type: 'string', description: 'Stable tool ID returned by risu-list-tools.' },
}

const draftIdSchema = {
  draftId: { type: 'string', description: 'Draft ID returned by risu-start-tool-draft.' },
}

const callableToolSchema = {
  anyOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['managed'] },
        toolId: { type: 'string' },
        functionId: { type: 'string' },
      },
      required: ['kind', 'toolId', 'functionId'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['external'] },
        name: { type: 'string' },
      },
      required: ['kind', 'name'],
    },
  ],
}

const agentStateActionSchema = {
  anyOf: [
    ...['setVariable', 'appendList', 'replaceList'].map((kind) => ({
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: [kind] },
        name: { type: 'string' },
        valueTemplate: { type: 'string' },
      },
      required: ['id', 'kind', 'name', 'valueTemplate'],
    })),
    {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['upsertMemory'] },
        scope: { type: 'string', enum: ['global', 'character', 'chat'] },
        memoryIdTemplate: { type: 'string' },
        titleTemplate: { type: 'string' },
        contentTemplate: { type: 'string' },
        tagsTemplate: { type: 'string' },
        importanceTemplate: { type: 'string' },
      },
      required: ['id', 'kind', 'scope', 'titleTemplate', 'contentTemplate'],
    },
  ],
}

const agentOutputRouteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    pattern: { type: 'string', description: 'Regular expression matched against the raw agent response.' },
    flags: { type: 'string' },
    outcome: { type: 'string', enum: ['success', 'error'] },
    modelTemplate: { type: 'string', description: 'Text returned to the model. This canonical field is required.' },
    cardTemplate: { type: 'string' },
    actions: { type: 'array', items: agentStateActionSchema },
  },
  required: ['id', 'name', 'pattern', 'outcome', 'modelTemplate', 'actions'],
}

const agentExecutionSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['agent'] },
    modelPresetId: { type: 'string', description: 'Use an exact id from modelPresets returned in this context.' },
    systemPrompt: { type: 'string' },
    userPrompt: { type: 'string' },
    allowedTools: { type: 'array', items: callableToolSchema },
    outputRoutes: { type: 'array', items: agentOutputRouteSchema },
  },
  required: ['kind', 'modelPresetId', 'systemPrompt', 'userPrompt', 'allowedTools', 'outputRoutes'],
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assignAlias(
  target: Record<string, any>,
  canonical: string,
  alias: string,
  value: unknown,
  warnings: string[],
  path = 'execution',
) {
  if (target[canonical] !== undefined && !sameValue(target[canonical], value)) {
    throw new Error(`${path}.${alias} conflicts with canonical field ${path}.${canonical}.`)
  }
  target[canonical] = value
  delete target[alias]
  warnings.push(`${path}.${alias} was normalized to ${path}.${canonical}.`)
}

function normalizeAgentExecutionInput(value: Record<string, any>) {
  const execution = safeStructuredClone(value) as Record<string, any>
  const warnings: string[] = []

  if (execution.modelPreset !== undefined) {
    if (typeof execution.modelPreset !== 'string') throw new Error('execution.modelPreset must be a model preset ID string.')
    assignAlias(execution, 'modelPresetId', 'modelPreset', execution.modelPreset, warnings)
  }
  if (execution.agentPrompt !== undefined) {
    if (typeof execution.agentPrompt !== 'string') throw new Error('execution.agentPrompt must be text.')
    assignAlias(execution, 'userPrompt', 'agentPrompt', execution.agentPrompt, warnings)
  }
  if (execution.prompts !== undefined) {
    if (typeof execution.prompts === 'string') {
      assignAlias(execution, 'userPrompt', 'prompts', execution.prompts, warnings)
    } else if (Array.isArray(execution.prompts)) {
      const promptText: Record<'system' | 'user', string[]> = { system: [], user: [] }
      for (const [index, prompt] of execution.prompts.entries()) {
        if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) throw new Error(`execution.prompts[${index}] must be an object.`)
        if (prompt.role !== 'system' && prompt.role !== 'user') throw new Error(`execution.prompts[${index}].role must be system or user.`)
        if (typeof prompt.content !== 'string') throw new Error(`execution.prompts[${index}].content must be text.`)
        promptText[prompt.role].push(prompt.content)
      }
      for (const role of ['system', 'user'] as const) {
        if (promptText[role].length > 0) assignAlias(execution, `${role}Prompt`, 'prompts', promptText[role].join('\n\n'), warnings)
      }
      delete execution.prompts
    } else {
      throw new Error('execution.prompts must be text or an array of system/user prompt objects.')
    }
  }

  execution.systemPrompt ??= ''
  execution.userPrompt ??= ''
  execution.allowedTools ??= []
  execution.outputRoutes ??= []
  if (!Array.isArray(execution.outputRoutes)) throw new Error('outputRoutes must be an array.')
  for (const [routeIndex, route] of execution.outputRoutes.entries()) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Each output route must be an object.')
    const routePath = `execution.outputRoutes[${routeIndex}]`
    for (const alias of ['resultTemplate', 'modelResultTemplate']) {
      if (route[alias] !== undefined) {
        if (typeof route[alias] !== 'string') throw new Error(`${routePath}.${alias} must be text.`)
        assignAlias(route, 'modelTemplate', alias, route[alias], warnings, routePath)
      }
    }
  }

  return { execution, warnings: [...new Set(warnings)] }
}

function response(value: unknown): RPCToolCallContent[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function objectValue(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, any>
}

function fingerprint(tool: RisuToolPackage) {
  return JSON.stringify(safeStructuredClone(tool))
}

function publicTool(tool: RisuToolPackage) {
  const { assets: _assets, ...copy } = safeStructuredClone(tool)
  return { ...copy, assets: (tool.assets ?? []).map((asset) => ({ name: asset[0], extension: asset[2] })) }
}

function blankTool(): RisuToolPackage {
  return {
    id: v4(),
    name: '',
    description: '',
    namespace: '',
    version: '1.0.0',
    functions: [],
    variables: [],
    lists: [],
    customToggle: '',
    backgroundEmbedding: '',
    lowLevelAccess: false,
    regex: [],
    trigger: [],
    assets: [],
    plugin: { language: 'javascript', source: '', permissions: [] },
  }
}

function uniqueNamespace(base: string) {
  const db = getDatabase()
  const stem = base || 'tool'
  let candidate = `${stem}-copy`
  let suffix = 2
  while (db.tools.some((tool) => tool.namespace === candidate)) candidate = `${stem}-copy-${suffix++}`
  return candidate
}

function normalizeFunction(value: Record<string, any>, current?: RisuToolFunction): RisuToolFunction {
  const parameters = value.parameters === undefined
    ? current?.parameters ?? []
    : (Array.isArray(value.parameters) ? value.parameters : []).map((item: any) => ({ ...item, id: item?.id || v4() }))
  return {
    id: current?.id ?? value.id ?? v4(),
    name: value.name ?? current?.name ?? 'function_name',
    description: value.description ?? current?.description ?? '',
    enabled: value.enabled ?? current?.enabled ?? true,
    parameters,
    execution: value.execution ?? current?.execution ?? { kind: 'script' },
    presentation: value.presentation ?? current?.presentation ?? {},
  }
}

function normalizeParameter(value: Record<string, any>, current?: RisuToolParameter): RisuToolParameter {
  return {
    id: current?.id ?? value.id ?? v4(),
    name: value.name ?? current?.name ?? 'argument',
    description: value.description ?? current?.description ?? '',
    type: value.type ?? current?.type ?? 'string',
    required: value.required ?? current?.required,
    enum: value.enum ?? current?.enum,
  }
}

function normalizeVariable(value: Record<string, any>, current?: RisuToolVariable): RisuToolVariable {
  return {
    id: current?.id ?? value.id ?? v4(),
    name: value.name ?? current?.name ?? 'variable',
    description: value.description ?? current?.description ?? '',
    type: value.type ?? current?.type ?? 'string',
    scope: value.scope ?? current?.scope ?? 'global',
    defaultValue: value.defaultValue ?? current?.defaultValue ?? '',
  }
}

function normalizeList(value: Record<string, any>, current?: RisuToolList): RisuToolList {
  return {
    id: current?.id ?? value.id ?? v4(),
    name: value.name ?? current?.name ?? 'list',
    description: value.description ?? current?.description ?? '',
    itemType: value.itemType ?? current?.itemType ?? 'string',
    scope: value.scope ?? current?.scope ?? 'global',
    defaultItems: value.defaultItems ?? current?.defaultItems ?? [],
  }
}

function draftResult(draft: ToolDraft, errors: string[] = [], warnings: string[] = []) {
  return {
    draftId: draft.id,
    mode: draft.mode,
    sourceToolId: draft.sourceToolId,
    activation: draft.activation,
    tool: publicTool(draft.tool),
    errors,
    warnings,
  }
}

export class ToolPackageHandler extends MCPToolHandler {
  private drafts = new Map<string, ToolDraft>()

  private promptAccess(tool: string, action: string) {
    return alertConfirm(language.mcpAccessPrompt.replace('{{tool}}', tool).replace('{{action}}', action))
  }

  getTools(): MCPTool[] {
    return [
      {
        name: 'risu-list-tools',
        description: 'List managed Risuai tool packages, including built-in tools and activation state.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'risu-get-tool',
        description: 'Read a complete managed tool package. Asset paths and data are omitted; only names and extensions are returned.',
        inputSchema: { type: 'object', properties: toolIdSchema, required: ['id'] },
      },
      {
        name: 'risu-get-tool-authoring-context',
        description: 'Get model presets, exact operation schemas, compatibility aliases, template tokens, and authoring examples. Call this before setFunctionExecution.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'risu-start-tool-draft',
        description: 'Start an in-memory tool draft. create starts blank, edit copies a user tool, and clone creates an editable user copy of any tool.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['create', 'edit', 'clone'] },
            toolId: { type: 'string', description: 'Required for edit and clone.' },
          },
          required: ['mode'],
        },
      },
      {
        name: 'risu-get-tool-draft',
        description: 'Read an in-memory tool draft without changing saved data.',
        inputSchema: { type: 'object', properties: draftIdSchema, required: ['draftId'] },
      },
      {
        name: 'risu-edit-tool-draft',
        description: `Apply a batch of in-memory draft operations. Kinds: ${operationKinds.join(', ')}. Before setFunctionExecution, call risu-get-tool-authoring-context. Canonical agent fields are kind, modelPresetId, systemPrompt, userPrompt, allowedTools, and outputRoutes; each route uses modelTemplate. New functions, parameters, variables, and lists receive IDs automatically.`,
        inputSchema: {
          type: 'object',
          properties: {
            draftId: draftIdSchema.draftId,
            operations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: [...operationKinds] },
                  targetId: { type: 'string', description: 'Stable function, parameter, variable, or list ID.' },
                  functionId: { type: 'string', description: 'Parent function ID for parameter/execution/presentation operations.' },
                  index: { type: 'integer', description: 'Regex or trigger index. Omit on upsert to append.' },
                  scope: { type: 'string', enum: ['unchanged', 'disabled', 'global', 'character', 'chat'] },
                  value: { type: 'object', description: 'Operation-specific fields. For setFunctionExecution use the exact operationSchemas.setFunctionExecution schema returned by risu-get-tool-authoring-context.' },
                },
                required: ['kind'],
              },
            },
          },
          required: ['draftId', 'operations'],
        },
      },
      {
        name: 'risu-validate-tool-draft',
        description: 'Validate a tool draft, including plugin syntax, without changing saved data.',
        inputSchema: { type: 'object', properties: draftIdSchema, required: ['draftId'] },
      },
      {
        name: 'risu-commit-tool-draft',
        description: 'Validate and atomically apply a tool draft after showing one user confirmation with a change summary.',
        inputSchema: { type: 'object', properties: draftIdSchema, required: ['draftId'] },
      },
      {
        name: 'risu-discard-tool-draft',
        description: 'Discard an in-memory tool draft without changing saved data.',
        inputSchema: { type: 'object', properties: draftIdSchema, required: ['draftId'] },
      },
      {
        name: 'risu-set-tool-activation',
        description: 'Enable or disable a managed tool globally, for the current character, or for the current chat after user confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            ...toolIdSchema,
            scope: { type: 'string', enum: ['global', 'character', 'chat'] },
            enabled: { type: 'boolean' },
          },
          required: ['id', 'scope', 'enabled'],
        },
      },
      {
        name: 'risu-delete-tool',
        description: 'Delete a user-created managed tool and its saved references after user confirmation. Built-in tools are protected.',
        inputSchema: { type: 'object', properties: toolIdSchema, required: ['id'] },
      },
    ]
  }

  async handle(toolName: string, args: Record<string, any>): Promise<RPCToolCallContent[] | null> {
    switch (toolName) {
      case 'risu-list-tools': return response(this.listTools())
      case 'risu-get-tool': return response(this.getTool(args.id))
      case 'risu-get-tool-authoring-context': return response(await this.getAuthoringContext())
      case 'risu-start-tool-draft': return response(this.startDraft(args.mode, args.toolId))
      case 'risu-get-tool-draft': return response(await this.getDraft(args.draftId))
      case 'risu-edit-tool-draft': return response(await this.editDraft(args.draftId, args.operations))
      case 'risu-validate-tool-draft': return response(await this.validateDraftResult(args.draftId))
      case 'risu-commit-tool-draft': return response(await this.commitDraft(args.draftId))
      case 'risu-discard-tool-draft': return response(this.discardDraft(args.draftId))
      case 'risu-set-tool-activation': return response(await this.changeActivation(args.id, args.scope, args.enabled))
      case 'risu-delete-tool': return response(await this.deleteTool(args.id))
    }
    return null
  }

  private findTool(id: string) {
    return getDatabase().tools.find((tool) => tool.id === id)
  }

  private requireDraft(id: string) {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error(`Tool draft ${id} not found.`)
    return draft
  }

  private listTools() {
    return getDatabase().tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      namespace: tool.namespace,
      version: tool.version,
      builtin: Boolean(tool.builtinId),
      readonly: tool.readonly === true,
      activation: getToolActivation(tool.id),
    }))
  }

  private getTool(id: string) {
    const tool = this.findTool(id)
    if (!tool) throw new Error(`Tool with ID ${id} not found.`)
    return { tool: publicTool(tool), activation: getToolActivation(tool.id) }
  }

  private async getAuthoringContext() {
    const db = getDatabase()
    const { getMCPTools } = await import('../mcp')
    const external = await getMCPTools()
    const modelPresets = (db.modelPresets ?? []).map((preset) => ({ id: preset.id, name: preset.name, toolUse: preset.toolUse === true }))
    const examplePreset = modelPresets[0]
    return {
      schemaVersion: 1,
      modelPresets,
      managedTools: db.tools.flatMap((tool) => tool.functions.map((fn) => ({ kind: 'managed', toolId: tool.id, functionId: fn.id, name: `${tool.namespace}__${fn.name}` }))),
      externalTools: external.map((tool) => ({ kind: 'external', name: tool.name, source: tool.mcpURL, description: tool.description })),
      parameterTypes: ['string', 'number', 'integer', 'boolean', 'json', 'string[]', 'number[]'],
      valueTypes: ['string', 'number', 'boolean', 'json'],
      scopes: ['global', 'character', 'chat'],
      executionKinds: ['script', 'agent'],
      operationSchemas: {
        setFunctionExecution: {
          anyOf: [
            { type: 'object', properties: { kind: { type: 'string', enum: ['script'] } }, required: ['kind'] },
            agentExecutionSchema,
          ],
        },
        agentOutputRoute: agentOutputRouteSchema,
        agentStateAction: agentStateActionSchema,
      },
      authoringExamples: {
        setFunctionExecutionAgent: examplePreset ? {
          kind: 'agent',
          modelPresetId: examplePreset.id,
          systemPrompt: 'Analyze the request carefully and return the result.',
          userPrompt: '{{tool_args}}',
          allowedTools: [],
          outputRoutes: [{
            id: 'success',
            name: 'Success',
            pattern: '^(?<result>[\\s\\S]+)$',
            flags: '',
            outcome: 'success',
            modelTemplate: '{{tool_capture::result}}',
            cardTemplate: '{{tool_capture::result}}',
            actions: [],
          }],
        } : null,
      },
      compatibilityAliases: {
        modelPreset: 'modelPresetId',
        agentPrompt: 'userPrompt',
        prompts: 'systemPrompt/userPrompt',
        resultTemplate: 'modelTemplate',
        modelResultTemplate: 'modelTemplate',
      },
      authoringNotes: [
        'Use an exact modelPresets[].id as modelPresetId; there is no separate agent model registry.',
        'systemPrompt and userPrompt must both be strings, and at least one must contain text.',
        'Compatibility aliases are accepted on input but only canonical fields are stored.',
      ],
      templateTokens: ['{{tool_args}}', '{{tool_arg::name}}', '{{tool_last_user}}', '{{tool_chat_history}}', '{{tool_character}}', '{{tool_state::chat}}', '{{tool_capture::name}}', '{{tool_result}}', '{{tool_updates}}', '{{tool_asset::filename}}'],
      pluginApi: ['registerFunction', 'askUser', 'requestDiceRoll', 'getVariable', 'setVariable', 'resetVariable', 'getList', 'setList', 'memoryList', 'memorySearch', 'memoryRead', 'memoryUpsert', 'memoryDelete', 'nativeFetch', 'databaseGet', 'databaseSet'],
      pluginExample: "await risuai.registerFunction('run', async (args) => ({ ok: true, value: args.value }))",
      customToggleFormat: 'key=label=type=options; type may be omitted, select, text, group, groupEnd, or divider.',
      regexTypes: ['editdisplay', 'editinput', 'editoutput', 'editprocess', 'edittrans'],
      triggerExamples: {
        lua: [{ comment: '', type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: '' }] }],
        v2: [{ comment: '', type: 'manual', conditions: [], effect: [{ type: 'v2Header', code: '', indent: 0 }] }, { comment: 'New Event', type: 'manual', conditions: [], effect: [] }],
      },
    }
  }

  private startDraft(mode: DraftMode, toolId?: string) {
    if (!['create', 'edit', 'clone'].includes(mode)) throw new Error(`Invalid draft mode: ${mode}`)
    let tool: RisuToolPackage
    let source: RisuToolPackage | undefined
    if (mode === 'create') tool = blankTool()
    else {
      source = this.findTool(toolId ?? '')
      if (!source) throw new Error(`Tool with ID ${toolId} not found.`)
      if (mode === 'edit' && (source.readonly || source.builtinId)) throw new Error('Built-in tools cannot be edited directly; clone the tool instead.')
      tool = safeStructuredClone(source)
      if (mode === 'clone') {
        tool.id = v4()
        tool.name = `${tool.name} Copy`
        tool.namespace = uniqueNamespace(tool.namespace)
        tool.builtinId = undefined
        tool.readonly = false
      }
    }
    const draft: ToolDraft = {
      id: v4(),
      mode,
      tool,
      sourceToolId: source?.id,
      baseFingerprint: mode === 'edit' && source ? fingerprint(source) : undefined,
      activation: mode === 'edit' ? 'unchanged' : 'disabled',
    }
    this.drafts.set(draft.id, draft)
    return draftResult(draft)
  }

  private async getDraft(id: string) {
    const draft = this.requireDraft(id)
    return draftResult(draft, await this.validateDraft(draft))
  }

  private applyOperation(draft: ToolDraft, operation: DraftOperation, warnings: string[]) {
    const tool = draft.tool
    const value = operation.value === undefined ? {} : objectValue(operation.value, `${operation.kind} value`)
    const requireFunction = () => {
      const fn = tool.functions.find((item) => item.id === operation.functionId)
      if (!fn) throw new Error(`Function ${operation.functionId} not found.`)
      return fn
    }
    const removeById = <T extends { id: string }>(items: T[], id: string | undefined, label: string) => {
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`${label} ${id} not found.`)
      items.splice(index, 1)
    }
    const upsertById = <T extends { id: string }>(items: T[], id: string | undefined, make: (current?: T) => T) => {
      const index = id ? items.findIndex((item) => item.id === id) : -1
      const item = make(index >= 0 ? items[index] : undefined)
      if (index >= 0) items[index] = item
      else items.push(item)
      return item.id
    }

    switch (operation.kind) {
      case 'setMetadata':
        for (const key of ['name', 'description', 'namespace', 'version'] as const) {
          if (value[key] !== undefined) {
            if (typeof value[key] !== 'string') throw new Error(`${key} must be text.`)
            tool[key] = value[key]
          }
        }
        return
      case 'upsertFunction':
        upsertById(tool.functions, operation.targetId ?? value.id, (current) => normalizeFunction(value, current))
        return
      case 'deleteFunction': removeById(tool.functions, operation.targetId, 'Function'); return
      case 'upsertParameter': {
        const fn = requireFunction()
        upsertById(fn.parameters, operation.targetId ?? value.id, (current) => normalizeParameter(value, current))
        return
      }
      case 'deleteParameter': removeById(requireFunction().parameters, operation.targetId, 'Parameter'); return
      case 'setFunctionExecution': {
        const fn = requireFunction()
        if (value.kind === 'script') fn.execution = { kind: 'script' }
        else if (value.kind === 'agent') {
          const normalized = normalizeAgentExecutionInput(value)
          warnings.push(...normalized.warnings)
          const execution = normalized.execution as ToolFunctionExecution
          if (execution.kind !== 'agent') throw new Error('Invalid agent execution.')
          execution.allowedTools ??= []
          execution.outputRoutes ??= []
          if (!Array.isArray(execution.allowedTools)) throw new Error('allowedTools must be an array.')
          if (!Array.isArray(execution.outputRoutes)) throw new Error('outputRoutes must be an array.')
          for (const route of execution.outputRoutes) {
            if (!route || typeof route !== 'object') throw new Error('Each output route must be an object.')
            route.id ||= v4()
            route.actions ??= []
            if (!Array.isArray(route.actions)) throw new Error('Each output route actions value must be an array.')
            for (const action of route.actions) {
              if (!action || typeof action !== 'object') throw new Error('Each output route action must be an object.')
              action.id ||= v4()
            }
          }
          fn.execution = execution
        } else throw new Error('Execution kind must be script or agent.')
        return
      }
      case 'setFunctionPresentation': requireFunction().presentation = safeStructuredClone(value) as ToolFunctionPresentation; return
      case 'upsertVariable': upsertById(tool.variables, operation.targetId ?? value.id, (current) => normalizeVariable(value, current)); return
      case 'deleteVariable': removeById(tool.variables, operation.targetId, 'Variable'); return
      case 'upsertList': upsertById(tool.lists, operation.targetId ?? value.id, (current) => normalizeList(value, current)); return
      case 'deleteList': removeById(tool.lists, operation.targetId, 'List'); return
      case 'setModuleFeatures':
        if (value.customToggle !== undefined) tool.customToggle = String(value.customToggle)
        if (value.backgroundEmbedding !== undefined) tool.backgroundEmbedding = String(value.backgroundEmbedding)
        if (value.lowLevelAccess !== undefined) {
          if (typeof value.lowLevelAccess !== 'boolean') throw new Error('lowLevelAccess must be a boolean.')
          tool.lowLevelAccess = value.lowLevelAccess
        }
        return
      case 'upsertRegex': {
        tool.regex ??= []
        const script = safeStructuredClone(value) as RisuToolPackage['regex'][number]
        if (operation.index === undefined) tool.regex.push(script)
        else if (operation.index >= 0 && operation.index < tool.regex.length) tool.regex[operation.index] = script
        else throw new Error(`Regex index ${operation.index} not found.`)
        return
      }
      case 'deleteRegex':
        if (operation.index === undefined || !tool.regex?.[operation.index]) throw new Error(`Regex index ${operation.index} not found.`)
        tool.regex.splice(operation.index, 1); return
      case 'upsertTrigger': {
        tool.trigger ??= []
        const trigger = safeStructuredClone(value) as RisuToolPackage['trigger'][number]
        if (operation.index === undefined) tool.trigger.push(trigger)
        else if (operation.index >= 0 && operation.index < tool.trigger.length) tool.trigger[operation.index] = trigger
        else throw new Error(`Trigger index ${operation.index} not found.`)
        return
      }
      case 'deleteTrigger':
        if (operation.index === undefined || !tool.trigger?.[operation.index]) throw new Error(`Trigger index ${operation.index} not found.`)
        tool.trigger.splice(operation.index, 1); return
      case 'setPlugin': {
        const languageValue = value.language ?? tool.plugin.language
        const source = value.source ?? tool.plugin.source
        const permissions = value.permissions ?? tool.plugin.permissions
        if (languageValue !== 'javascript' && languageValue !== 'typescript') throw new Error('Plugin language must be JavaScript or TypeScript.')
        if (typeof source !== 'string') throw new Error('Plugin source must be text.')
        if (!Array.isArray(permissions)) throw new Error('Plugin permissions must be an array.')
        tool.plugin = { language: languageValue, source, permissions: safeStructuredClone(permissions) as ToolPermission[] }
        return
      }
      case 'setActivation':
        if (!operation.scope || !['unchanged', 'disabled', 'global', 'character', 'chat'].includes(operation.scope)) throw new Error('Invalid activation scope.')
        draft.activation = operation.scope
        return
      default: throw new Error(`Unknown draft operation: ${operation.kind}`)
    }
  }

  private async editDraft(id: string, operations: DraftOperation[]) {
    const current = this.requireDraft(id)
    if (!Array.isArray(operations) || operations.length === 0) throw new Error('At least one draft operation is required.')
    const draft = safeStructuredClone(current) as ToolDraft
    const warnings: string[] = []
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object') throw new Error('Draft operations must be objects.')
      this.applyOperation(draft, operation, warnings)
    }
    this.drafts.set(id, draft)
    return draftResult(draft, await this.validateDraft(draft), [...new Set(warnings)])
  }

  private async validateDraft(draft: ToolDraft) {
    const db = getDatabase()
    const errors = validateToolPackage(draft.tool, db.tools)
    errors.push(...await validateToolPluginSource(draft.tool))
    if (draft.tool.functions.some((fn) => fn.execution?.kind !== 'agent') && (typeof draft.tool.plugin.source !== 'string' || !draft.tool.plugin.source.trim())) {
      errors.push('Plugin source is required when the tool has script functions.')
    }
    for (const fn of draft.tool.functions) {
      const execution = fn.execution
      if (execution?.kind !== 'agent') continue
      const hasPresetId = typeof execution.modelPresetId === 'string' && Boolean(execution.modelPresetId.trim())
      const preset = hasPresetId ? (db.modelPresets ?? []).find((item) => item.id === execution.modelPresetId) : undefined
      if (hasPresetId && !preset) errors.push(`Model preset ID "${execution.modelPresetId}" was not found for agent function ${fn.name}; use an exact modelPresets[].id from risu-get-tool-authoring-context.`)
      const allowedTools = Array.isArray(execution.allowedTools) ? execution.allowedTools : []
      if (allowedTools.length > 0 && preset?.toolUse !== true) errors.push(`Tool use is disabled on the model preset for ${fn.name}.`)
      for (const ref of allowedTools) {
        if (!ref || typeof ref !== 'object' || (ref.kind !== 'external' && ref.kind !== 'managed')) continue
        if (ref.kind === 'external') {
          if (!ref.name?.trim()) errors.push(`External tool name is required in ${fn.name}.`)
          continue
        }
        const targetTool = ref.toolId === draft.tool.id ? draft.tool : db.tools.find((item) => item.id === ref.toolId)
        if (!targetTool?.functions.some((item) => item.id === ref.functionId)) errors.push(`Managed tool reference not found in ${fn.name}.`)
      }
    }
    if (draft.activation === 'character' && !getCurrentCharacter()) errors.push('A current character is required for character activation.')
    if (draft.activation === 'chat' && !getCurrentChat()) errors.push('A current chat is required for chat activation.')
    return [...new Set(errors)]
  }

  private async validateDraftResult(id: string) {
    const draft = this.requireDraft(id)
    const errors = await this.validateDraft(draft)
    return { valid: errors.length === 0, errors }
  }

  private changeSummary(draft: ToolDraft, previous?: RisuToolPackage) {
    const count = <T extends { id: string }>(before: T[], after: T[]) => {
      const oldIds = new Set(before.map((item) => item.id))
      const newIds = new Set(after.map((item) => item.id))
      return { added: after.filter((item) => !oldIds.has(item.id)).length, deleted: before.filter((item) => !newIds.has(item.id)).length }
    }
    const functions = count(previous?.functions ?? [], draft.tool.functions)
    const variables = count(previous?.variables ?? [], draft.tool.variables)
    const lists = count(previous?.lists ?? [], draft.tool.lists)
    const sourceChanged = !previous || previous.plugin.source !== draft.tool.plugin.source
    return [
      `${draft.mode === 'edit' ? 'update' : 'create'} tool ${draft.tool.name} (${draft.tool.namespace})`,
      `functions +${functions.added}/-${functions.deleted}, variables +${variables.added}/-${variables.deleted}, lists +${lists.added}/-${lists.deleted}`,
      `regex ${draft.tool.regex?.length ?? 0}, triggers ${draft.tool.trigger?.length ?? 0}, activation ${draft.activation}`,
      `plugin ${draft.tool.plugin.language}, permissions ${Array.isArray(draft.tool.plugin.permissions) ? draft.tool.plugin.permissions.join(', ') || 'none' : 'invalid'}, source changed ${sourceChanged ? 'yes' : 'no'}`,
      `low-level trigger access ${draft.tool.lowLevelAccess ? 'ENABLED' : 'disabled'}`,
    ].join('\n')
  }

  private assertNoConflict(draft: ToolDraft) {
    if (draft.mode !== 'edit') return undefined
    const current = this.findTool(draft.sourceToolId ?? '')
    if (!current) throw new Error('The source tool was deleted while the draft was open.')
    if (fingerprint(current) !== draft.baseFingerprint) throw new Error('The source tool changed while the draft was open. Start a new draft to avoid overwriting it.')
    return current
  }

  private applyDraftActivation(toolId: string, activation: DraftActivation) {
    if (activation === 'unchanged') return
    const current = getToolActivation(toolId)
    if (current.global) setToolActivation(toolId, 'global', false)
    if (current.character && getCurrentCharacter()) setToolActivation(toolId, 'character', false)
    if (current.chat && getCurrentChat()) setToolActivation(toolId, 'chat', false)
    if (activation !== 'disabled') setToolActivation(toolId, activation, true)
  }

  private async commitDraft(id: string) {
    const draft = this.requireDraft(id)
    const previous = this.assertNoConflict(draft)
    const errors = await this.validateDraft(draft)
    if (errors.length) return { committed: false, errors }
    const allowed = await this.promptAccess('risu-commit-tool-draft', this.changeSummary(draft, previous))
    if (!allowed) return { committed: false, error: 'Access denied by user.', draftId: id }
    this.assertNoConflict(draft)

    const saved = safeStructuredClone(draft.tool)
    if (draft.mode === 'edit' && previous) replaceManagedToolPackage(previous, saved)
    else createManagedToolPackage(saved)
    this.applyDraftActivation(saved.id, draft.activation)
    this.drafts.delete(id)
    return { committed: true, toolId: saved.id, activation: getToolActivation(saved.id) }
  }

  private discardDraft(id: string) {
    if (!this.drafts.delete(id)) throw new Error(`Tool draft ${id} not found.`)
    return { discarded: true, draftId: id }
  }

  private async changeActivation(id: string, scope: ToolActivationScope, enabled: boolean) {
    const tool = this.findTool(id)
    if (!tool) throw new Error(`Tool with ID ${id} not found.`)
    if (!['global', 'character', 'chat'].includes(scope)) throw new Error(`Invalid activation scope: ${scope}`)
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean.')
    const allowed = await this.promptAccess('risu-set-tool-activation', `${enabled ? 'enable' : 'disable'} tool (${tool.name}) for ${scope}`)
    if (!allowed) return { updated: false, error: 'Access denied by user.' }
    setToolActivation(id, scope, enabled)
    return { updated: true, activation: getToolActivation(id) }
  }

  private async deleteTool(id: string) {
    const tool = this.findTool(id)
    if (!tool) throw new Error(`Tool with ID ${id} not found.`)
    if (tool.readonly || tool.builtinId) throw new Error('Built-in tools cannot be deleted.')
    const allowed = await this.promptAccess('risu-delete-tool', `delete tool (${tool.name}) and all of its saved state`)
    if (!allowed) return { deleted: false, error: 'Access denied by user.' }
    deleteManagedToolPackage(id)
    for (const [draftId, draft] of this.drafts) if (draft.sourceToolId === id) this.drafts.delete(draftId)
    return { deleted: true, toolId: id }
  }
}
