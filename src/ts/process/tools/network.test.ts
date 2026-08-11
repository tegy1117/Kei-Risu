import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    fetch: vi.fn(),
    db: { toolNetworkSettings: { profiles: [] as any[], approvedOrigins: {} as Record<string, boolean> } },
}))

vi.mock(import('src/ts/alert'), () => ({ alertConfirm: mocks.confirm }))
vi.mock(import('src/ts/globalApi.svelte'), () => ({ fetchNative: mocks.fetch }))
vi.mock(import('src/ts/storage/database.svelte'), () => ({ getDatabase: () => mocks.db } as unknown as typeof import('src/ts/storage/database.svelte')))

import { executeHttpTool, executeSearchTool, listNetworkProfiles } from './network'

function response(body: string, options: { status?: number, url?: string, contentType?: string } = {}) {
    const bytes = new TextEncoder().encode(body)
    return {
        ok: (options.status ?? 200) < 400,
        status: options.status ?? 200,
        statusText: 'OK',
        url: options.url ?? 'https://api.example.com/data',
        headers: new Headers({ 'content-type': options.contentType ?? 'application/json' }),
        arrayBuffer: async () => bytes.buffer,
    } as Response
}

beforeEach(() => {
    mocks.confirm.mockReset().mockResolvedValue(true)
    mocks.fetch.mockReset()
    mocks.db.toolNetworkSettings = { profiles: [], approvedOrigins: {} }
})

describe('managed network tools', () => {
    test('requires origin approval once and blocks private URLs and raw credentials', async () => {
        mocks.fetch.mockResolvedValue(response('{"ok":true}'))
        await executeHttpTool({ url: 'https://api.example.com/data', method: 'GET' })
        await executeHttpTool({ url: 'https://api.example.com/other', method: 'GET' })
        expect(mocks.confirm).toHaveBeenCalledTimes(1)
        await expect(executeHttpTool({ url: 'http://127.0.0.1/admin' })).rejects.toThrow('not allowed')
        await expect(executeHttpTool({ url: 'https://example.org', headers: { Authorization: 'secret' } })).rejects.toThrow('saved profile')
    })

    test('injects and redacts profile secrets without listing them', async () => {
        mocks.db.toolNetworkSettings.profiles.push({
            id: 'p1', kind: 'http', name: 'Example', description: 'demo', baseUrl: 'https://api.example.com/',
            method: 'GET', headers: { Authorization: 'Bearer {{secret:key}}' }, secrets: { key: 'top-secret' },
            timeoutMs: 30000, maxResponseBytes: 10000,
        })
        mocks.fetch.mockResolvedValue(response('echo top-secret'))
        const result = await executeHttpTool({ profile: 'Example', path: '/data' })
        expect(mocks.fetch).toHaveBeenCalledWith('https://api.example.com/data', expect.objectContaining({ headers: { Authorization: 'Bearer top-secret' } }))
        expect(result.text).toBe('echo [REDACTED]')
        expect(listNetworkProfiles('http')).toEqual([{ id: 'p1', name: 'Example', description: 'demo' }])
    })

    test('maps configured search result paths and falls back to raw data', async () => {
        mocks.db.toolNetworkSettings.profiles.push({
            id: 's1', kind: 'search', name: 'Search', description: '',
            urlTemplate: 'https://search.example.com/?q={{query}}&n={{count}}&o={{offset}}', method: 'GET',
            headers: {}, secrets: {}, timeoutMs: 30000, maxResponseBytes: 10000,
            mapping: { itemsPath: 'data.results', titlePath: 'title', urlPath: 'link', snippetPath: 'description' },
        })
        mocks.fetch.mockResolvedValue(response(JSON.stringify({ data: { results: [{ title: 'A', link: 'https://a.example', description: 'B' }] } }), { url: 'https://search.example.com/?q=hello' }))
        await expect(executeSearchTool({ profile: 'Search', query: 'hello', count: 5 })).resolves.toEqual({
            query: 'hello', results: [{ title: 'A', url: 'https://a.example', snippet: 'B' }], truncated: false, status: 200,
        })
    })
})
