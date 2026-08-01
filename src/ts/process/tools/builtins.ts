import type { RisuToolPackage } from './types'

const questionSource = `
await risuai.registerFunction('ask', async (args) => {
    return await risuai.askUser(args.question, args.options || [], args.allowFreeText !== false)
})
`.trim()

const localtimeSource = `
await risuai.registerFunction('now', async (args) => {
    const now = new Date()
    const timeZone = args.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
    const locale = args.locale || undefined
    try {
        const formatter = new Intl.DateTimeFormat(locale, {
            dateStyle: 'full', timeStyle: 'long', timeZone
        })
        const offset = new Intl.DateTimeFormat('en-US', {
            timeZone, timeZoneName: 'longOffset'
        }).formatToParts(now).find((part) => part.type === 'timeZoneName')?.value || ''
        return { iso: now.toISOString(), unixMs: now.getTime(), timeZone, utcOffset: offset, formatted: formatter.format(now) }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
})
`.trim()

const memorySource = `
await risuai.registerFunction('list', async (args) => risuai.memoryList(args || {}))
await risuai.registerFunction('search', async (args) => risuai.memorySearch(args || {}))
await risuai.registerFunction('read', async (args) => risuai.memoryRead(args || {}))
await risuai.registerFunction('upsert', async (args) => risuai.memoryUpsert(args || {}))
await risuai.registerFunction('delete', async (args) => risuai.memoryDelete(args || {}))
`.trim()

export const BUILTIN_TOOL_IDS = {
    question: 'builtin-tool-question',
    localtime: 'builtin-tool-localtime',
    memory: 'builtin-tool-memory',
} as const

export function createBuiltinTools(): RisuToolPackage[] {
    return [
        {
            id: BUILTIN_TOOL_IDS.question,
            builtinId: 'question',
            readonly: true,
            name: 'Question',
            description: 'Ask the user a question before continuing the roleplay response.',
            namespace: 'question',
            version: '1.0.0',
            functions: [{
                id: 'question-ask', name: 'ask', enabled: true,
                description: 'Pause generation and ask the user one question. Options are optional and free text can be allowed.',
                parameters: [
                    { id: 'question-text', name: 'question', description: 'Question shown to the user.', type: 'string', required: true },
                    { id: 'question-options', name: 'options', description: 'Optional answer choices.', type: 'string[]' },
                    { id: 'question-free', name: 'allowFreeText', description: 'Allow a custom text answer. Defaults to true.', type: 'boolean' },
                ],
            }],
            variables: [], lists: [],
            plugin: { language: 'javascript', source: questionSource, permissions: ['askUser'] },
        },
        {
            id: BUILTIN_TOOL_IDS.localtime,
            builtinId: 'localtime',
            readonly: true,
            name: 'Localtime',
            description: 'Read the actual time from the user device.',
            namespace: 'localtime',
            version: '1.0.0',
            functions: [{
                id: 'localtime-now', name: 'now', enabled: true,
                description: 'Return the current instant and a localized time for an optional IANA time zone.',
                parameters: [
                    { id: 'localtime-zone', name: 'timeZone', description: 'Optional IANA time zone such as Asia/Seoul.', type: 'string' },
                    { id: 'localtime-locale', name: 'locale', description: 'Optional BCP 47 locale such as ko-KR.', type: 'string' },
                ],
            }],
            variables: [], lists: [],
            plugin: { language: 'javascript', source: localtimeSource, permissions: [] },
        },
        {
            id: BUILTIN_TOOL_IDS.memory,
            builtinId: 'memory',
            readonly: true,
            name: 'Memory',
            description: 'Read and update structured roleplay memories by chat, character, or global scope.',
            namespace: 'memory',
            version: '1.0.0',
            functions: [
                { id: 'memory-list', name: 'list', enabled: true, description: 'List memories in one scope or all scopes.', parameters: [
                    { id: 'memory-list-scope', name: 'scope', description: 'chat, character, global, or all. Defaults to chat.', type: 'string' },
                    { id: 'memory-list-limit', name: 'limit', description: 'Maximum results, 1 to 100.', type: 'integer' },
                ] },
                { id: 'memory-search', name: 'search', enabled: true, description: 'Search memory titles, contents, and tags.', parameters: [
                    { id: 'memory-search-query', name: 'query', description: 'Case-insensitive text query.', type: 'string', required: true },
                    { id: 'memory-search-scope', name: 'scope', description: 'chat, character, global, or all. Defaults to chat.', type: 'string' },
                    { id: 'memory-search-limit', name: 'limit', description: 'Maximum results, 1 to 100.', type: 'integer' },
                ] },
                { id: 'memory-read', name: 'read', enabled: true, description: 'Read one memory by id.', parameters: [
                    { id: 'memory-read-id', name: 'id', description: 'Memory id.', type: 'string', required: true },
                    { id: 'memory-read-scope', name: 'scope', description: 'chat, character, global, or all. Defaults to chat.', type: 'string' },
                ] },
                { id: 'memory-upsert', name: 'upsert', enabled: true, description: 'Create a memory or update an existing memory id.', parameters: [
                    { id: 'memory-upsert-id', name: 'id', description: 'Existing id to update; omit to create.', type: 'string' },
                    { id: 'memory-upsert-title', name: 'title', description: 'Memory title.', type: 'string', required: true },
                    { id: 'memory-upsert-content', name: 'content', description: 'Memory content.', type: 'string', required: true },
                    { id: 'memory-upsert-tags', name: 'tags', description: 'Searchable tags.', type: 'string[]' },
                    { id: 'memory-upsert-importance', name: 'importance', description: 'Importance from 1 to 5. Defaults to 3.', type: 'integer' },
                    { id: 'memory-upsert-scope', name: 'scope', description: 'chat, character, or global. Defaults to chat.', type: 'string' },
                ] },
                { id: 'memory-delete', name: 'delete', enabled: true, description: 'Delete one memory by id.', parameters: [
                    { id: 'memory-delete-id', name: 'id', description: 'Memory id.', type: 'string', required: true },
                    { id: 'memory-delete-scope', name: 'scope', description: 'chat, character, or global. Defaults to chat.', type: 'string' },
                ] },
            ],
            variables: [], lists: [],
            plugin: { language: 'javascript', source: memorySource, permissions: [] },
        },
    ]
}

export function reconcileBuiltinTools(tools: RisuToolPackage[] | undefined): RisuToolPackage[] {
    const current = Array.isArray(tools) ? tools : []
    const builtins = createBuiltinTools()
    const byBuiltin = new Map(current.filter((tool) => tool?.builtinId).map((tool) => [tool.builtinId, tool]))
    const userTools = current.filter((tool) => !tool?.builtinId)
    return [
        ...builtins.map((builtin) => {
            const old = byBuiltin.get(builtin.builtinId)
            if (!old) return builtin
            const enabledByName = new Map((old.functions ?? []).map((fn) => [fn.name, fn.enabled]))
            return {
                ...builtin,
                functions: builtin.functions.map((fn) => ({ ...fn, enabled: enabledByName.get(fn.name) ?? fn.enabled })),
            }
        }),
        ...userTools,
    ]
}
