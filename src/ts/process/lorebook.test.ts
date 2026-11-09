import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

// A circular import can evaluate lorebook before stores initializes DBState.
// Keep the export live so initialization finishes before any UI action runs.
const mocks = vi.hoisted(() => ({
    state: undefined as { db: any } | undefined,
    selectSingleFile: vi.fn(),
    downloadFile: vi.fn(),
    alertError: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({
    get DBState() { return mocks.state },
    selectedCharID: writable(0),
}))
vi.mock('../storage/database.svelte', () => ({}))
vi.mock('../parser/chatVar.svelte', () => ({ getChatVar: vi.fn(), setChatVar: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: vi.fn() }))
vi.mock('../util', () => ({
    findCharacterbyId: vi.fn(), pickHashRand: vi.fn(), selectSingleFile: mocks.selectSingleFile,
}))
vi.mock('../alert', () => ({ alertError: mocks.alertError, notifySuccess: vi.fn() }))
vi.mock('../../lang', () => ({ language: { successExport: 'Exported' } }))
vi.mock('../globalApi.svelte', () => ({ downloadFile: mocks.downloadFile }))
vi.mock('./modules', () => ({ getModuleLorebooks: vi.fn() }))

import { selectedCharID } from '../stores.svelte'
import { addLorebook, addLorebookFolder, exportLoreBook, importLoreBook } from './lorebook.svelte'

function makeDb() {
    return {
        characters: [{ globalLore: [], chatPage: 1, chats: [{ localLore: [] }, { localLore: [] }] }],
        loreBookPage: 1,
        loreBook: [{ data: [] }, { data: [] }],
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { db: makeDb() }
    selectedCharID.set(0)
})

describe('lorebook UI actions after store initialization', () => {
    const targets = [
        { name: 'character', type: 0, mode: 'global' as const, list: (db: any) => db.characters[0].globalLore },
        { name: 'chat', type: 1, mode: 'local' as const, list: (db: any) => db.characters[0].chats[1].localLore },
        { name: 'settings', type: -1, mode: 'sglobal' as const, list: (db: any) => db.loreBook[1].data },
    ]

    for (const { name, type, mode, list } of targets) {
        it(`adds entries and folders to the selected ${name} lorebook`, () => {
            if (type === -1) selectedCharID.set(-1)
            addLorebook(type)
            addLorebook(type)
            addLorebookFolder(type)
            expect(list(mocks.state!.db)).toMatchObject([
                { comment: 'New Lore 1', mode: 'normal' },
                { comment: 'New Lore 2', mode: 'normal' },
                { comment: 'New Folder', mode: 'folder', key: expect.stringMatching(/^\uf000folder:/) },
            ])
            for (const target of targets.filter(target => target.type !== type)) {
                expect(target.list(mocks.state!.db)).toEqual([])
            }
            expect(mocks.state!.db.characters[0].chats[0].localLore).toEqual([])
            expect(mocks.state!.db.loreBook[0].data).toEqual([])
        })

        it(`imports and exports the selected ${name} lorebook`, async () => {
            if (type === -1) selectedCharID.set(-1)
            const data = [{ key: 'test', comment: 'Imported', content: 'Lore text', mode: 'normal' }]
            mocks.selectSingleFile.mockResolvedValue({ data: Buffer.from(JSON.stringify({ type: 'risu', data })) })
            await importLoreBook(mode)
            expect(list(mocks.state!.db)).toEqual(data)
            await exportLoreBook(mode)
            expect(mocks.downloadFile).toHaveBeenCalledWith('lorebook_export.json', expect.any(Uint8Array))
            expect(JSON.parse(mocks.downloadFile.mock.calls[0][1].toString())).toEqual({ type: 'risu', ver: 1, data })
            expect(mocks.alertError).not.toHaveBeenCalled()
        })
    }

    it('keeps the original import target when the selected chat changes during the file dialog', async () => {
        let finish!: (file: any) => void
        mocks.selectSingleFile.mockReturnValue(new Promise(resolve => { finish = resolve }))
        const pending = importLoreBook('local')
        mocks.state!.db.characters[0].chatPage = 0
        finish({ data: Buffer.from(JSON.stringify({ type: 'risu', data: [{ content: 'Original chat' }] })) })
        await pending
        expect(mocks.state!.db.characters[0].chats[1].localLore).toEqual([{ content: 'Original chat' }])
        expect(mocks.state!.db.characters[0].chats[0].localLore).toEqual([])
    })

    it('rejects an import whose target was removed during the file dialog', async () => {
        let finish!: (file: any) => void
        mocks.selectSingleFile.mockReturnValue(new Promise(resolve => { finish = resolve }))
        const pending = importLoreBook('local')
        mocks.state!.db = makeDb()
        finish({ data: Buffer.from(JSON.stringify({ type: 'risu', data: [{ content: 'Removed chat' }] })) })
        await pending
        expect(mocks.state!.db.characters[0].chats[1].localLore).toEqual([])
        expect(mocks.alertError).toHaveBeenCalledWith(expect.stringContaining('target was removed'))
    })
})
