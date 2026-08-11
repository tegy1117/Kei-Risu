import { language } from 'src/lang'
import { alertConfirm } from 'src/ts/alert'
import { requestImmediateSave } from 'src/ts/globalApi.svelte'
import { chatGenKey, isChatGenerating } from 'src/ts/process/generationState'
import { safeStructuredClone } from 'src/ts/polyfill'
import { ensureChatHydrated } from 'src/ts/storage/chatStorage'
import { getDatabase, type Chat, type character } from 'src/ts/storage/database.svelte'
import { type MCPTool, MCPToolHandler, type RPCToolCallContent } from '../mcplib'
import { getCharacter } from './utils'

type ChatVariablePatch = { set?: Record<string, string>, delete?: string[] }

function json(value: unknown): RPCToolCallContent[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function plainText(value: string): RPCToolCallContent[] {
  return [{ type: 'text', text: value }]
}

function boundedPage(count: unknown, offset: unknown, fallback: number) {
  const safeCount = Math.max(1, Math.min(100, Math.floor(Number(count ?? fallback)) || fallback))
  const safeOffset = Math.max(0, Math.floor(Number(offset ?? 0)) || 0)
  return { count: safeCount, offset: safeOffset }
}

function parseDefaults(raw: string | undefined) {
  const values: Record<string, string> = {}
  for (const line of String(raw ?? '').split('\n')) {
    const [key, value] = line.split('=')
    if (key && value && !(key in values)) values[key] = value
  }
  return values
}

function explicitChatVariables(chat: Chat) {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(chat.scriptstate ?? {})) {
    if (key.startsWith('$')) values[key.slice(1)] = String(value)
  }
  return values
}

function validateVariablePatch(patch: ChatVariablePatch | undefined) {
  if (!patch) return
  const set = patch.set ?? {}
  const remove = patch.delete ?? []
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Error('variables.set must be an object of string values.')
  if (!Array.isArray(remove) || !remove.every((key) => typeof key === 'string')) throw new Error('variables.delete must be an array of names.')
  for (const [key, value] of Object.entries(set)) {
    if (!key || key.trim() !== key || /[\r\n]/.test(key)) throw new Error(`Invalid chat variable name: ${key || '(empty)'}`)
    if (typeof value !== 'string') throw new Error(`Chat variable ${key} must be text.`)
    if (remove.includes(key)) throw new Error(`Chat variable ${key} cannot be set and deleted in one patch.`)
  }
  for (const key of remove) if (!key || key.trim() !== key || /[\r\n]/.test(key)) throw new Error(`Invalid chat variable name: ${key || '(empty)'}`)
}

export class ChatHandler extends MCPToolHandler {
  private promptAccess(tool: string, action: string) {
    return alertConfirm(language.mcpAccessPrompt.replace('{{tool}}', tool).replace('{{action}}', action))
  }

  getTools(): MCPTool[] {
    const characterId = {
      type: 'string',
      description: 'Character ID or name. Use an empty string for the currently selected character.',
    }
    const chatId = {
      type: 'string',
      description: 'Chat ID. For risu-get-chat-history only, omit it to use the character active chat for compatibility.',
    }
    return [
      {
        name: 'risu-list-chats',
        description: 'List stable chat IDs and metadata for a character without changing the selected chat.',
        inputSchema: { type: 'object', properties: {
          id: characterId,
          count: { type: 'integer', default: 50, description: 'Maximum entries, 1 to 100.' },
          offset: { type: 'integer', description: 'Pagination offset.' },
        }, required: ['id'] },
      },
      {
        name: 'risu-get-chat-history',
        description: 'Get chat history newest first. A chatId may target an unopened chat; omitted chatId preserves the previous active-chat behavior.',
        inputSchema: { type: 'object', properties: {
          id: characterId, chatId,
          count: { type: 'integer', default: 20, description: 'Maximum entries, 1 to 100.' },
          offset: { type: 'integer', description: 'Pagination offset.' },
        }, required: ['id'] },
      },
      {
        name: 'risu-get-chat-info',
        description: 'Read metadata for a specific chat, hydrating it when necessary.',
        inputSchema: { type: 'object', properties: { id: characterId, chatId }, required: ['id', 'chatId'] },
      },
      {
        name: 'risu-get-chat-variables',
        description: 'Read explicit and effective variables for a specific chat, including each value source.',
        inputSchema: { type: 'object', properties: { id: characterId, chatId }, required: ['id', 'chatId'] },
      },
      {
        name: 'risu-patch-chat',
        description: 'Atomically patch chat name/note and explicit chat variables after one user approval. Message content cannot be changed.',
        inputSchema: { type: 'object', properties: {
          id: characterId,
          chatId,
          metadata: { type: 'object', properties: { name: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
          variables: { type: 'object', properties: {
            set: { type: 'object', additionalProperties: { type: 'string' } },
            delete: { type: 'array', items: { type: 'string' } },
          }, additionalProperties: false },
        }, required: ['id', 'chatId'] },
      },
    ]
  }

  async handle(toolName: string, args: any): Promise<RPCToolCallContent[] | null> {
    if (toolName === 'risu-list-chats') return this.listChats(args.id, args.count, args.offset)
    if (toolName === 'risu-get-chat-history') return this.getChatHistory(args.id, args.chatId, args.count, args.offset)
    if (toolName === 'risu-get-chat-info') return this.getChatInfo(args.id, args.chatId)
    if (toolName === 'risu-get-chat-variables') return this.getChatVariables(args.id, args.chatId)
    if (toolName === 'risu-patch-chat') return this.patchChat(args.id, args.chatId, args.metadata, args.variables)
    return null
  }

  private requireCharacter(id: string): character {
    const char = getCharacter(id)
    if (!char) throw new Error(`Character with ID ${id} not found.`)
    return char
  }

  private async resolveChat(id: string, requestedChatId?: string, allowActiveFallback = false) {
    const char = this.requireCharacter(id)
    const index = requestedChatId
      ? char.chats.findIndex((chat) => chat?.id === requestedChatId)
      : allowActiveFallback ? char.chatPage : -1
    if (index < 0 || !char.chats[index]) throw new Error(`Chat ${requestedChatId || '(active)'} was not found for character ${char.name}.`)
    const chat = await ensureChatHydrated(char.chats, index, char.chaId)
    if (!chat) throw new Error(`Chat ${requestedChatId || char.chats[index]?.id || '(active)'} could not be loaded.`)
    return { char, chat, index }
  }

  async listChats(id: string, count: unknown = 50, offset: unknown = 0) {
    const char = this.requireCharacter(id)
    const page = boundedPage(count, offset, 50)
    const entries = char.chats.slice(page.offset, page.offset + page.count).map((chat, relativeIndex) => ({
      chatId: chat?.id ?? '',
      name: chat?.name ?? '',
      lastDate: chat?.lastDate,
      folderId: chat?.folderId,
      isActive: page.offset + relativeIndex === char.chatPage,
      isHydrated: chat?._placeholder !== true,
    }))
    return json({ characterId: char.chaId, total: char.chats.length, offset: page.offset, chats: entries })
  }

  async getChatHistory(id: string, chatId?: string, count: unknown = 20, offset: unknown = 0): Promise<RPCToolCallContent[]> {
    const { char, chat } = await this.resolveChat(id, chatId, true)
    const page = boundedPage(count, offset, 20)
    const history = [...chat.message].reverse().slice(page.offset, page.offset + page.count)
    const ordered = history.map((entry) => ({ type: 'text', text: `${entry.role === 'char' ? char.name : 'User'}: ${entry.data}` }))
    return [{ type: 'text', text: JSON.stringify(ordered) }]
  }

  async getChatInfo(id: string, chatId: string) {
    const { char, chat, index } = await this.resolveChat(id, chatId)
    return json({
      characterId: char.chaId, chatId: chat.id, name: chat.name, note: chat.note,
      lastDate: chat.lastDate, folderId: chat.folderId, isActive: index === char.chatPage,
      messageCount: chat.message.length,
    })
  }

  async getChatVariables(id: string, chatId: string) {
    const { char, chat } = await this.resolveChat(id, chatId)
    const template = parseDefaults(getDatabase().templateDefaultVariables)
    const character = parseDefaults(char.defaultVariables)
    const explicit = explicitChatVariables(chat)
    const effective = { ...template, ...character, ...explicit }
    const sources: Record<string, 'template' | 'character' | 'chat'> = {}
    for (const key of Object.keys(template)) sources[key] = 'template'
    for (const key of Object.keys(character)) sources[key] = 'character'
    for (const key of Object.keys(explicit)) sources[key] = 'chat'
    return json({ characterId: char.chaId, chatId: chat.id, explicit, characterDefaults: character, templateDefaults: template, effective, sources })
  }

  async patchChat(id: string, chatId: string, metadata: unknown, variables: ChatVariablePatch | undefined) {
    const { char, chat, index } = await this.resolveChat(id, chatId)
    if (chat.isStreaming || isChatGenerating(chatGenKey(chat.id))) throw new Error('The target chat is currently generating or streaming.')
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error('metadata must be an object.')
    const meta = metadata as { name?: unknown, note?: unknown } | undefined
    if (meta?.name !== undefined && typeof meta.name !== 'string') throw new Error('metadata.name must be text.')
    if (meta?.note !== undefined && typeof meta.note !== 'string') throw new Error('metadata.note must be text.')
    validateVariablePatch(variables)
    const setKeys = Object.keys(variables?.set ?? {})
    const deleteKeys = variables?.delete ?? []
    if (meta?.name === undefined && meta?.note === undefined && setKeys.length === 0 && deleteKeys.length === 0) throw new Error('The patch contains no changes.')

    const watched = {
      name: chat.name,
      note: chat.note,
      variables: Object.fromEntries([...new Set([...setKeys, ...deleteKeys])].map((key) => [key, chat.scriptstate?.[`$${key}`]])),
    }
    const summary = [
      meta?.name !== undefined ? 'name' : '', meta?.note !== undefined ? 'note' : '',
      setKeys.length ? `set variables: ${setKeys.join(', ')}` : '',
      deleteKeys.length ? `delete variables: ${deleteKeys.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    if (!(await this.promptAccess('risu-patch-chat', `modify chat (${char.name} / ${chat.name || chat.id}): ${summary}`))) {
      return plainText('Access denied by user.')
    }
    if (chat.name !== watched.name || chat.note !== watched.note || Object.entries(watched.variables).some(([key, value]) => chat.scriptstate?.[`$${key}`] !== value)) {
      throw new Error('The target chat changed while approval was pending. Read it again before retrying.')
    }

    const previous = safeStructuredClone(chat)
    if (meta?.name !== undefined) chat.name = meta.name as string
    if (meta?.note !== undefined) chat.note = meta.note as string
    chat.scriptstate ??= {}
    for (const [key, value] of Object.entries(variables?.set ?? {})) chat.scriptstate[`$${key}`] = value
    for (const key of deleteKeys) delete chat.scriptstate[`$${key}`]

    try {
      await requestImmediateSave({ changes: { character: [char.chaId], chat: [[char.chaId, chat.id!]] }, throwOnError: true })
    } catch (error) {
      char.chats[index] = previous
      try {
        await requestImmediateSave({ changes: { character: [char.chaId], chat: [[char.chaId, previous.id!]] }, throwOnError: true })
      } catch { /* preserve the original persistence error */ }
      throw error
    }
    return json({ ok: true, characterId: char.chaId, chatId: chat.id, updated: summary })
  }
}
