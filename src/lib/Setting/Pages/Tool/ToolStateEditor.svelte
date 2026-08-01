<script lang="ts">
    import { PlusIcon, RotateCcwIcon, SaveIcon, Trash2Icon } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { safeStructuredClone } from 'src/ts/polyfill'
    import {
        createToolScopeStateSnapshot,
        deleteToolScopeState,
        readToolScopeState,
        validateToolScopeState,
        writeToolScopeState,
    } from 'src/ts/process/tools/tools'
    import type { RisuToolList, RisuToolPackage, RisuToolVariable, ToolMemoryEntry, ToolScope, ToolScopeState } from 'src/ts/process/tools/types'
    import { getCurrentCharacter, getCurrentChat, getDatabase } from 'src/ts/storage/database.svelte'
    import { v4 } from 'uuid'

    interface Props {
        tool: RisuToolPackage
        onclose: () => void
    }

    type Section = 'variables' | 'lists' | 'memories' | 'raw'
    type ContextOption = { id: string; label: string }

    let { tool, onclose }: Props = $props()
    let scope = $state<ToolScope>('global')
    let contextId = $state('')
    let contexts = $state<ContextOption[]>([])
    let section = $state<Section>('variables')
    let draft = $state<ToolScopeState>({ variables: {}, lists: {}, memories: [] })
    let variableText = $state<Record<string, string>>({})
    let listText = $state<Record<string, string>>({})
    let rawText = $state('')
    let memorySearch = $state('')
    let originalRaw = ''
    let originalTyped = ''

    const scopedVariables = $derived((tool.variables ?? []).filter((item) => item.scope === scope))
    const scopedLists = $derived((tool.lists ?? []).filter((item) => item.scope === scope))
    const filteredMemories = $derived.by(() => {
        const query = memorySearch.trim().toLowerCase()
        const memories = draft.memories ?? []
        if (!query) return memories
        return memories.filter((entry) => `${entry.title}\n${entry.content}\n${entry.tags.join(' ')}`.toLowerCase().includes(query))
    })

    function variableToText(definition: RisuToolVariable, value: unknown) {
        if (definition.type === 'string') return typeof value === 'string' ? value : String(value ?? '')
        if (definition.type === 'boolean') return value === true ? 'true' : 'false'
        if (definition.type === 'number') return typeof value === 'number' ? String(value) : String(definition.defaultValue ?? 0)
        return JSON.stringify(value ?? definition.defaultValue ?? {}, null, 2)
    }

    function typedSignature() {
        return JSON.stringify({ draft, variableText, listText })
    }

    function hasChanges() {
        return section === 'raw' ? rawText !== originalRaw : typedSignature() !== originalTyped
    }

    function buildEditors() {
        const nextVariables: Record<string, string> = {}
        for (const definition of scopedVariables) {
            const value = definition.name in draft.variables ? draft.variables[definition.name] : definition.defaultValue
            nextVariables[definition.name] = variableToText(definition, value)
        }
        const nextLists: Record<string, string> = {}
        for (const definition of scopedLists) {
            const value = definition.name in draft.lists ? draft.lists[definition.name] : definition.defaultItems
            nextLists[definition.name] = JSON.stringify(value ?? [], null, 2)
        }
        variableText = nextVariables
        listText = nextLists
    }

    function materializeTypedState() {
        const next = createToolScopeStateSnapshot(draft)
        for (const definition of scopedVariables) {
            const text = variableText[definition.name] ?? ''
            if (definition.type === 'string') next.variables[definition.name] = text
            else if (definition.type === 'boolean') next.variables[definition.name] = text === 'true'
            else if (definition.type === 'number') {
                const value = Number(text)
                if (!Number.isFinite(value)) throw new Error(language.toolStateInvalidNumber.replace('{name}', definition.name))
                next.variables[definition.name] = value
            } else {
                next.variables[definition.name] = JSON.parse(text)
            }
        }
        for (const definition of scopedLists) {
            const value = JSON.parse(listText[definition.name] ?? '[]')
            if (!Array.isArray(value)) throw new Error(language.toolStateListArray.replace('{name}', definition.name))
            next.lists[definition.name] = value
        }
        return next
    }

    function parseRawState() {
        const value = JSON.parse(rawText) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(language.toolStateInvalidRoot)
        const record = value as Record<string, unknown>
        if (!record.variables || typeof record.variables !== 'object' || Array.isArray(record.variables)) throw new Error(language.toolStateInvalidRoot)
        if (!record.lists || typeof record.lists !== 'object' || Array.isArray(record.lists)) throw new Error(language.toolStateInvalidRoot)
        if (record.memories !== undefined && !Array.isArray(record.memories)) throw new Error(language.toolStateInvalidRoot)
        return createToolScopeStateSnapshot(record as unknown as ToolScopeState)
    }

    function loadState() {
        draft = readToolScopeState(tool.id, scope, contextId)
        buildEditors()
        rawText = JSON.stringify(draft, null, 2)
        originalRaw = rawText
        originalTyped = typedSignature()
        memorySearch = ''
    }

    function characterLabel(id: string) {
        const character = getDatabase().characters.find((item) => item.chaId === id)
        return character ? character.name : `${language.toolStateUnknownCharacter} (${id})`
    }

    function chatLabel(id: string) {
        for (const character of getDatabase().characters) {
            const index = character.chats.findIndex((chat) => chat.id === id)
            if (index >= 0) return `${character.name} · ${character.chats[index].name || `${language.toolStateChat} ${index + 1}`}`
        }
        return `${language.toolStateUnknownChat} (${id})`
    }

    function getContexts(nextScope: ToolScope): ContextOption[] {
        if (nextScope === 'global') return [{ id: '', label: language.toolStateGlobal }]
        const state = getDatabase().toolStates?.[tool.id]
        const ids = new Set(Object.keys(nextScope === 'character' ? state?.characters ?? {} : state?.chats ?? {}))
        if (nextScope === 'character') {
            const current = getCurrentCharacter()
            if (current?.chaId) ids.add(current.chaId)
            const ordered = current?.chaId ? [current.chaId, ...[...ids].filter((id) => id !== current.chaId)] : [...ids]
            return ordered.map((id) => ({ id, label: characterLabel(id) }))
        }
        const current = getCurrentChat()
        if (current && !current.id) current.id = v4()
        if (current?.id) ids.add(current.id)
        const ordered = current?.id ? [current.id, ...[...ids].filter((id) => id !== current.id)] : [...ids]
        return ordered.map((id) => ({ id, label: chatLabel(id) }))
    }

    async function confirmDiscard() {
        return !hasChanges() || await alertConfirm(language.toolStateDiscardConfirm)
    }

    async function selectScope(nextScope: ToolScope) {
        if (scope === nextScope || !await confirmDiscard()) return
        scope = nextScope
        contexts = getContexts(scope)
        contextId = contexts[0]?.id ?? ''
        loadState()
    }

    async function selectContext(nextId: string) {
        if (contextId === nextId || !await confirmDiscard()) return
        contextId = nextId
        loadState()
    }

    function selectSection(next: Section) {
        if (section === next) return
        try {
            if (section === 'raw') {
                draft = parseRawState()
                buildEditors()
            } else if (next === 'raw') {
                draft = materializeTypedState()
                rawText = JSON.stringify(draft, null, 2)
            }
            section = next
        } catch (error) {
            notifyError(error instanceof Error ? error.message : String(error))
        }
    }

    function resetVariable(definition: RisuToolVariable) {
        delete draft.variables[definition.name]
        draft.variables = { ...draft.variables }
        variableText[definition.name] = variableToText(definition, definition.defaultValue)
        variableText = { ...variableText }
    }

    function resetList(definition: RisuToolList) {
        delete draft.lists[definition.name]
        draft.lists = { ...draft.lists }
        listText[definition.name] = JSON.stringify(definition.defaultItems ?? [], null, 2)
        listText = { ...listText }
    }

    function addMemory() {
        const now = Date.now()
        const memory: ToolMemoryEntry = {
            id: v4(), title: '', content: '', tags: [], importance: 3, createdAt: now, updatedAt: now,
        }
        draft.memories = [memory, ...(draft.memories ?? [])]
    }

    function updateMemory(entry: ToolMemoryEntry) {
        entry.updatedAt = Date.now()
        draft.memories = [...(draft.memories ?? [])]
    }

    function removeMemory(id: string) {
        draft.memories = (draft.memories ?? []).filter((entry) => entry.id !== id)
    }

    function save() {
        try {
            const next = section === 'raw'
                ? parseRawState()
                : materializeTypedState()
            const errors = validateToolScopeState(tool, scope, next)
            if (errors.length) throw new Error(errors.join('\n'))
            writeToolScopeState(tool.id, scope, contextId, next)
            loadState()
            notifySuccess(language.toolStateSaved)
        } catch (error) {
            notifyError(error instanceof Error ? error.message : String(error))
        }
    }

    async function resetScope() {
        if (!await alertConfirm(language.toolStateResetConfirm)) return
        deleteToolScopeState(tool.id, scope, contextId)
        loadState()
        notifySuccess(language.toolStateResetDone)
    }

    async function close() {
        if (await confirmDiscard()) onclose()
    }

    onMount(() => {
        const currentChat = getCurrentChat()
        const currentCharacter = getCurrentCharacter()
        scope = currentChat ? 'chat' : currentCharacter?.chaId ? 'character' : 'global'
        contexts = getContexts(scope)
        contextId = contexts[0]?.id ?? ''
        loadState()
    })
</script>

<div class="flex flex-col gap-4">
    <div class="flex flex-wrap gap-2 items-center">
        <div class="flex border border-darkborderc rounded-md overflow-hidden">
            {#each ['global', 'character', 'chat'] as value}
                <button
                    class="px-3 py-2 border-r border-darkborderc last:border-r-0"
                    class:bg-darkbutton={scope === value}
                    onclick={() => selectScope(value as ToolScope)}
                >{value === 'global' ? language.toolStateGlobal : value === 'character' ? language.toolStateCharacter : language.toolStateChat}</button>
            {/each}
        </div>
        {#if scope !== 'global'}
            <select
                class="min-w-52 grow bg-darkbg border border-darkborderc rounded-md p-2"
                value={contextId}
                onchange={(event) => selectContext(event.currentTarget.value)}
            >
                {#each contexts as context}<option value={context.id}>{context.label}</option>{/each}
            </select>
        {/if}
    </div>

    {#if scope !== 'global' && contexts.length === 0}
        <div class="border border-darkborderc rounded-md p-4 text-textcolor2">{language.toolStateNoContext}</div>
        <button class="self-start border border-darkborderc rounded-md px-4 py-2 hover:text-primary" onclick={close}>{language.cancel}</button>
    {:else}
        <div class="flex border border-darkborderc rounded-md overflow-x-auto">
            {#each [
                ['variables', language.toolVariables],
                ['lists', language.toolLists],
                ['memories', language.toolStateMemories],
                ['raw', language.toolStateRaw],
            ] as item}
                <button
                    class="p-2 min-w-24 flex-1 border-r border-darkborderc last:border-r-0"
                    class:bg-darkbutton={section === item[0]}
                    onclick={() => selectSection(item[0] as Section)}
                >{item[1]}</button>
            {/each}
        </div>

        {#if section === 'variables'}
            <div class="flex flex-col gap-3">
                {#if scopedVariables.length === 0}<p class="text-textcolor2">{language.toolStateNoVariables}</p>{/if}
                {#each scopedVariables as variable}
                    <div class="border border-darkborderc rounded-md p-3 flex flex-col gap-2">
                        <div class="flex items-start gap-2">
                            <div class="grow"><strong>{variable.name}</strong><div class="text-sm text-textcolor2">{variable.description}</div></div>
                            <span class="text-xs text-textcolor2 border border-darkborderc rounded px-2 py-1">{variable.type}</span>
                            <button title={language.toolStateResetValue} aria-label={language.toolStateResetValue} class="text-textcolor2 hover:text-primary" onclick={() => resetVariable(variable)}><RotateCcwIcon size={18}/></button>
                        </div>
                        {#if variable.type === 'boolean'}
                            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={variableText[variable.name]}><option value="true">true</option><option value="false">false</option></select>
                        {:else if variable.type === 'json'}
                            <textarea class="bg-transparent border border-darkborderc rounded-md p-2 min-h-28 font-mono" bind:value={variableText[variable.name]}></textarea>
                        {:else}
                            <input class="bg-transparent border border-darkborderc rounded-md p-2" type={variable.type === 'number' ? 'number' : 'text'} bind:value={variableText[variable.name]} />
                        {/if}
                    </div>
                {/each}
            </div>
        {:else if section === 'lists'}
            <div class="flex flex-col gap-3">
                {#if scopedLists.length === 0}<p class="text-textcolor2">{language.toolStateNoLists}</p>{/if}
                {#each scopedLists as list}
                    <div class="border border-darkborderc rounded-md p-3 flex flex-col gap-2">
                        <div class="flex items-start gap-2">
                            <div class="grow"><strong>{list.name}</strong><div class="text-sm text-textcolor2">{list.description}</div></div>
                            <span class="text-xs text-textcolor2 border border-darkborderc rounded px-2 py-1">{list.itemType}[]</span>
                            <button title={language.toolStateResetValue} aria-label={language.toolStateResetValue} class="text-textcolor2 hover:text-primary" onclick={() => resetList(list)}><RotateCcwIcon size={18}/></button>
                        </div>
                        <textarea class="bg-transparent border border-darkborderc rounded-md p-2 min-h-36 font-mono" bind:value={listText[list.name]}></textarea>
                    </div>
                {/each}
            </div>
        {:else if section === 'memories'}
            <div class="flex flex-col gap-3">
                <div class="flex gap-2">
                    <input class="grow bg-transparent border border-darkborderc rounded-md p-2" placeholder={language.search} bind:value={memorySearch} />
                    <button title={language.toolStateAddMemory} aria-label={language.toolStateAddMemory} class="border border-darkborderc rounded-md px-3 hover:text-primary" onclick={addMemory}><PlusIcon size={20}/></button>
                </div>
                {#if filteredMemories.length === 0}<p class="text-textcolor2">{language.toolStateNoMemories}</p>{/if}
                {#each filteredMemories as memory (memory.id)}
                    <div class="border border-darkborderc rounded-md p-3 flex flex-col gap-2">
                        <div class="flex gap-2 items-center">
                            <input class="grow bg-transparent border border-darkborderc rounded-md p-2 font-semibold" placeholder={language.toolStateMemoryTitle} bind:value={memory.title} oninput={() => updateMemory(memory)} />
                            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={memory.importance} onchange={() => updateMemory(memory)}>
                                {#each [1, 2, 3, 4, 5] as importance}<option value={importance}>{importance}</option>{/each}
                            </select>
                            <button title={language.remove} aria-label={language.remove} class="text-textcolor2 hover:text-red-400" onclick={() => removeMemory(memory.id)}><Trash2Icon size={18}/></button>
                        </div>
                        <textarea class="bg-transparent border border-darkborderc rounded-md p-2 min-h-28" placeholder={language.toolStateMemoryContent} bind:value={memory.content} oninput={() => updateMemory(memory)}></textarea>
                        <input class="bg-transparent border border-darkborderc rounded-md p-2" placeholder={language.toolStateMemoryTags} value={memory.tags.join(', ')} oninput={(event) => { memory.tags = event.currentTarget.value.split(',').map((tag) => tag.trim()).filter(Boolean); updateMemory(memory) }} />
                    </div>
                {/each}
            </div>
        {:else}
            <div class="flex flex-col gap-2">
                <p class="text-sm text-textcolor2">{language.toolStateRawHint}</p>
                <textarea class="bg-transparent border border-darkborderc rounded-md p-3 min-h-96 font-mono" bind:value={rawText}></textarea>
            </div>
        {/if}

        <div class="flex flex-wrap gap-2 pt-2">
            <button class="border border-darkborderc rounded-md px-4 py-2 hover:text-primary flex items-center gap-2" onclick={close}>{language.cancel}</button>
            <button class="border border-darkborderc rounded-md px-4 py-2 hover:text-red-400 flex items-center gap-2" onclick={resetScope}><Trash2Icon size={18}/>{language.toolStateResetScope}</button>
            <button class="ml-auto bg-darkbutton border border-darkborderc rounded-md px-4 py-2 hover:text-primary flex items-center gap-2" onclick={save}><SaveIcon size={18}/>{language.toolStateSave}</button>
        </div>
    {/if}
</div>
