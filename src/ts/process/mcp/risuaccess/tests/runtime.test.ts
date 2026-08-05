import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  save: vi.fn(),
  hydrate: vi.fn(),
  db: { characters: [] as any[], templateDefaultVariables: '', globalChatVariables: {} },
}))

vi.mock(import('katex'), () => ({}))
vi.mock(import('src/ts/lite'), () => ({}))
vi.mock(import('src/ts/alert'), () => ({ alertConfirm: mocks.confirm }))
vi.mock(import('src/ts/globalApi.svelte'), () => ({ requestImmediateSave: mocks.save }))
vi.mock(import('src/ts/process/generationState'), () => ({ chatGenKey: (id: string) => id, isChatGenerating: () => false }))
vi.mock(import('src/ts/storage/chatStorage'), () => ({ ensureChatHydrated: mocks.hydrate }))
vi.mock(import('src/ts/storage/database.svelte'), () => ({
  getDatabase: () => mocks.db,
  getCurrentCharacter: () => mocks.db.characters[0],
} as unknown as typeof import('src/ts/storage/database.svelte')))
vi.mock(import('src/ts/stores.svelte'), () => ({ DBState: { db: mocks.db }, selIdState: { selId: 0 } } as unknown as typeof import('src/ts/stores.svelte')))

import { CharacterRuntimeHandler } from '../characterRuntime'
import { ChatHandler } from '../chats'

function chat(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, note: '', message: [], localLore: [], scriptstate: {}, ...extra }
}

function character() {
  return {
    chaId: 'char-1', name: 'Risu', chatPage: 0, defaultVariables: 'mood=calm', customModuleToggle: 'mode=Mode=select=A,B',
    chats: [chat('chat-1', 'First'), chat('chat-2', 'Second', { _placeholder: true })],
  } as any
}

function parsed(result: any) {
  return JSON.parse(result[0].text)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.confirm.mockResolvedValue(true)
  mocks.save.mockResolvedValue(undefined)
  mocks.db.characters = [character()]
  mocks.db.templateDefaultVariables = 'mood=template\nweather=sunny'
  mocks.hydrate.mockImplementation(async (chats: any[], index: number) => {
    const current = chats[index]
    if (current._placeholder) {
      chats[index] = chat(current.id, current.name, { note: 'hydrated', message: [{ role: 'user', data: 'hello' }] })
    }
    return chats[index]
  })
})

describe('RisuAccess chat targeting', () => {
  test('lists stable chat ids without hydration and reads an unopened chat by id', async () => {
    const handler = new ChatHandler()
    expect(parsed(await handler.handle('risu-list-chats', { id: 'char-1' }))).toMatchObject({
      total: 2,
      chats: [{ chatId: 'chat-1', isActive: true, isHydrated: true }, { chatId: 'chat-2', isActive: false, isHydrated: false }],
    })
    expect(mocks.hydrate).not.toHaveBeenCalled()
    const history = parsed(await handler.handle('risu-get-chat-history', { id: 'char-1', chatId: 'chat-2' }))
    expect(history).toEqual([{ type: 'text', text: 'User: hello' }])
    expect(mocks.hydrate).toHaveBeenCalledWith(mocks.db.characters[0].chats, 1, 'char-1')
  })

  test('reports explicit and effective variable precedence', async () => {
    const handler = new ChatHandler()
    mocks.db.characters[0].chats[0].scriptstate = { '$mood': 'excited', '$score': 3, internal: true }
    const result = parsed(await handler.handle('risu-get-chat-variables', { id: 'char-1', chatId: 'chat-1' }))
    expect(result.explicit).toEqual({ mood: 'excited', score: '3' })
    expect(result.effective).toEqual({ mood: 'excited', weather: 'sunny', score: '3' })
    expect(result.sources).toEqual({ mood: 'chat', weather: 'template', score: 'chat' })
  })

  test('patches metadata and variables after one approval and requests targeted persistence', async () => {
    const handler = new ChatHandler()
    await handler.handle('risu-patch-chat', {
      id: 'char-1', chatId: 'chat-1', metadata: { name: 'Renamed', note: 'Note' },
      variables: { set: { mood: 'happy' }, delete: ['old'] },
    })
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.db.characters[0].chats[0]).toMatchObject({ name: 'Renamed', note: 'Note', scriptstate: { '$mood': 'happy' } })
    expect(mocks.save).toHaveBeenCalledWith({ changes: { character: ['char-1'], chat: [['char-1', 'chat-1']] }, throwOnError: true })
  })
})

describe('RisuAccess character runtime data', () => {
  test('patches default variables structurally and preserves unrelated lines', async () => {
    const handler = new CharacterRuntimeHandler()
    mocks.db.characters[0].defaultVariables = 'mood=calm\n# note\nmood=duplicate\nweather=rain'
    const result = parsed(await handler.handle('risu-patch-character-variables', {
      id: 'char-1', set: { mood: 'happy', score: '2' }, delete: ['weather'],
    }))
    expect(mocks.db.characters[0].defaultVariables).toBe('mood=happy\n# note\nscore=2')
    expect(result.values).toEqual({ mood: 'happy', score: '2' })
    expect(mocks.save).toHaveBeenCalledWith({ changes: { character: ['char-1'] }, throwOnError: true })
  })

  test('reads and validates custom toggle definitions without exposing values', async () => {
    const handler = new CharacterRuntimeHandler()
    const current = parsed(await handler.handle('risu-get-character-custom-toggles', { id: 'char-1' }))
    expect(current.definition).toBe('mode=Mode=select=A,B')
    expect(current).not.toHaveProperty('values')
    await expect(handler.handle('risu-set-character-custom-toggles', { id: 'char-1', definition: 'x=X=unknown' })).rejects.toThrow('unsupported toggle type')
  })
})
