import { language } from 'src/lang'
import { alertConfirm } from 'src/ts/alert'
import { requestImmediateSave } from 'src/ts/globalApi.svelte'
import { parseToggleSyntax } from 'src/ts/util'
import { getDatabase, type character } from 'src/ts/storage/database.svelte'
import { type MCPTool, MCPToolHandler, type RPCToolCallContent } from '../mcplib'
import { getCharacter } from './utils'

type VariablePatch = { set?: Record<string, string>, delete?: string[] }

function text(value: unknown): RPCToolCallContent[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function plainText(value: string): RPCToolCallContent[] {
  return [{ type: 'text', text: value }]
}

function parseDefaultVariables(raw: string | undefined) {
  const values: Record<string, string> = {}
  const warnings: string[] = []
  for (const [index, line] of String(raw ?? '').split('\n').entries()) {
    if (!line) continue
    const parts = line.split('=')
    const [key, value] = parts
    if (!key || !value) {
      warnings.push(`Line ${index + 1} is not an active key=value variable.`)
      continue
    }
    if (key in values) {
      warnings.push(`Duplicate variable ${key} on line ${index + 1}; the first value wins.`)
      continue
    }
    values[key] = value
    if (parts.length > 2) warnings.push(`Variable ${key} contains extra '=' characters ignored by the current runtime.`)
  }
  return { values, warnings }
}

function validateVariablePatch(patch: VariablePatch) {
  const set = patch?.set ?? {}
  const remove = patch?.delete ?? []
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Error('set must be an object of string values.')
  if (!Array.isArray(remove) || !remove.every((key) => typeof key === 'string')) throw new Error('delete must be an array of variable names.')
  for (const [key, value] of Object.entries(set)) {
    if (!key || key.trim() !== key || /[=\r\n]/.test(key)) throw new Error(`Invalid variable name: ${key || '(empty)'}`)
    if (typeof value !== 'string' || !value || /[=\r\n]/.test(value)) throw new Error(`Invalid value for variable ${key}.`)
    if (remove.includes(key)) throw new Error(`Variable ${key} cannot be set and deleted in one patch.`)
  }
  for (const key of remove) if (!key || key.trim() !== key || /[=\r\n]/.test(key)) throw new Error(`Invalid variable name: ${key || '(empty)'}`)
}

function applyDefaultVariablePatch(raw: string | undefined, patch: VariablePatch) {
  validateVariablePatch(patch)
  const set = patch.set ?? {}
  const remove = new Set(patch.delete ?? [])
  const written = new Set<string>()
  const lines: string[] = []
  for (const line of String(raw ?? '').split('\n')) {
    const key = line.split('=')[0]
    if (remove.has(key)) continue
    if (key in set) {
      if (!written.has(key)) lines.push(`${key}=${set[key]}`)
      written.add(key)
      continue
    }
    lines.push(line)
  }
  for (const [key, value] of Object.entries(set)) if (!written.has(key)) lines.push(`${key}=${value}`)
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

function validateToggleDefinition(definition: string) {
  const errors: string[] = []
  const keys = new Set<string>()
  const supported = new Set(['', 'select', 'text', 'textarea', 'group', 'groupEnd', 'divider', 'caption'])
  for (const [index, rawLine] of definition.split('\n').entries()) {
    if (!rawLine.trim()) continue
    const [key = '', label = '', type = '', options = ''] = rawLine.split('=')
    if (!supported.has(type)) errors.push(`Line ${index + 1}: unsupported toggle type ${type}.`)
    if (['group', 'groupEnd', 'divider'].includes(type)) continue
    if (type === 'caption') {
      if (!label) errors.push(`Line ${index + 1}: caption label is required.`)
      continue
    }
    if (!key || !label) errors.push(`Line ${index + 1}: toggle key and label are required.`)
    if (key && keys.has(key)) errors.push(`Line ${index + 1}: duplicate toggle key ${key}.`)
    if (key) keys.add(key)
    if (type === 'select' && !options) errors.push(`Line ${index + 1}: select options are required.`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return parseToggleSyntax(definition)
}

export class CharacterRuntimeHandler extends MCPToolHandler {
  private promptAccess(tool: string, action: string) {
    return alertConfirm(language.mcpAccessPrompt.replace('{{tool}}', tool).replace('{{action}}', action))
  }

  getTools(): MCPTool[] {
    const id = { type: 'string', description: 'Character ID or name. Use an empty string for the currently selected character.' }
    return [
      {
        name: 'risu-get-character-variables',
        description: 'Read structured character default variables and inherited template defaults.',
        inputSchema: { type: 'object', properties: { id }, required: ['id'] },
      },
      {
        name: 'risu-patch-character-variables',
        description: 'Set or delete character default variables while preserving unrelated source lines.',
        inputSchema: { type: 'object', properties: {
          id,
          set: { type: 'object', additionalProperties: { type: 'string' } },
          delete: { type: 'array', items: { type: 'string' } },
        }, required: ['id'] },
      },
      {
        name: 'risu-get-character-custom-toggles',
        description: 'Read the character custom toggle definition and parsed controls. This does not expose current toggle values.',
        inputSchema: { type: 'object', properties: { id }, required: ['id'] },
      },
      {
        name: 'risu-set-character-custom-toggles',
        description: 'Validate and replace the character custom toggle definition. This does not change current toggle values.',
        inputSchema: { type: 'object', properties: { id, definition: { type: 'string' } }, required: ['id', 'definition'] },
      },
    ]
  }

  async handle(toolName: string, args: any): Promise<RPCToolCallContent[] | null> {
    if (toolName === 'risu-get-character-variables') return this.getVariables(args.id)
    if (toolName === 'risu-patch-character-variables') return this.patchVariables(args.id, { set: args.set, delete: args.delete })
    if (toolName === 'risu-get-character-custom-toggles') return this.getToggles(args.id)
    if (toolName === 'risu-set-character-custom-toggles') return this.setToggles(args.id, args.definition)
    return null
  }

  private requireCharacter(id: string): character {
    const char = getCharacter(id)
    if (!char) throw new Error(`Character with ID ${id} not found.`)
    return char
  }

  async getVariables(id: string) {
    const char = this.requireCharacter(id)
    const characterDefaults = parseDefaultVariables(char.defaultVariables)
    const templateDefaults = parseDefaultVariables(getDatabase().templateDefaultVariables)
    return text({
      characterId: char.chaId,
      raw: char.defaultVariables ?? '',
      values: characterDefaults.values,
      warnings: characterDefaults.warnings,
      inheritedTemplateValues: templateDefaults.values,
      inheritedTemplateWarnings: templateDefaults.warnings,
    })
  }

  async patchVariables(id: string, patch: VariablePatch) {
    const char = this.requireCharacter(id)
    const next = applyDefaultVariablePatch(char.defaultVariables, patch)
    if (!(await this.promptAccess('risu-patch-character-variables', `modify default variables for character (${char.name})`))) {
      return plainText('Access denied by user.')
    }
    const previous = char.defaultVariables ?? ''
    char.defaultVariables = next
    try {
      await requestImmediateSave({ changes: { character: [char.chaId] }, throwOnError: true })
      return this.getVariables(id)
    } catch (error) {
      char.defaultVariables = previous
      throw error
    }
  }

  async getToggles(id: string) {
    const char = this.requireCharacter(id)
    const definition = char.customModuleToggle ?? ''
    return text({ characterId: char.chaId, definition, toggles: validateToggleDefinition(definition) })
  }

  async setToggles(id: string, definition: unknown) {
    const char = this.requireCharacter(id)
    if (typeof definition !== 'string') throw new Error('Toggle definition must be text.')
    const toggles = validateToggleDefinition(definition)
    if (!(await this.promptAccess('risu-set-character-custom-toggles', `replace custom toggle definitions for character (${char.name})`))) {
      return plainText('Access denied by user.')
    }
    const previous = char.customModuleToggle ?? ''
    char.customModuleToggle = definition
    try {
      await requestImmediateSave({ changes: { character: [char.chaId] }, throwOnError: true })
      return text({ characterId: char.chaId, definition, toggles })
    } catch (error) {
      char.customModuleToggle = previous
      throw error
    }
  }
}
