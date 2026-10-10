<script lang="ts">
    import { get } from 'svelte/store'
    import { X, Plus, GitBranch, Trash2, Send, Square, MessageSquare } from '@lucide/svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { language } from 'src/lang'
    import { v4 } from 'uuid'
    import { flushSaves, withServerDatabaseMutation, changeChatTo } from 'src/ts/globalApi.svelte'
    import { changeChar } from 'src/ts/characters'
    import { ensureCurrentChatReady } from 'src/ts/storage/chatStorage'
    import { selectedSideOrigin, snapshotSideOrigin, prepareSideProgram } from 'src/ts/sideChat/prepare.svelte'
    import { sideChatPanel, sideChatSessions, sideChatDetails, sideChatLimit, sideChatConnectionError, sideApi, acceptSideSession, refreshSideChats, openSideSession, isSideRunning, setSideChatLimit } from 'src/ts/sideChat/client'
    import type { SideChatSelection } from 'src/ts/sideChat/core'
    import { groupByFolder } from 'src/ts/folders'

    const t = language.sideChat
    const agentGroups = $derived(groupByFolder(DBState.db.agentPresets.map(p => p.folderId), DBState.db.agentPresetFolders ?? []))
    let text = $state(''), error = $state(''), busy = $state(false), limitInput = $state(3)
    let modelId = $state(''), promptId = $state(''), agentId = $state('')
    let formKey = ''
    let pendingSend: any = null
    let branchRequestId = ''
    let scrollElement: HTMLDivElement = $state()
    const session = $derived($sideChatPanel.sessionId ? $sideChatDetails.get($sideChatPanel.sessionId) : undefined)
    const generating = $derived(!!session && isSideRunning(session))
    $effect(() => {
        const key = $sideChatPanel.sessionId || `${$sideChatPanel.origin?.characterId}:${$sideChatPanel.origin?.chatId}`
        if (key !== formKey) {
            formKey = key; text = ''; error = ''; pendingSend = null; branchRequestId = ''
            const selection = session?.selection
            const origin = $sideChatPanel.origin
            const char = DBState.db.characters.find(c => c.chaId === origin?.characterId)
            const chat = char?.chats.find(c => c.id === origin?.chatId)
            const inheritedModel = chat?.modelBinding?.main
            modelId = selection?.modelPresetId || (DBState.db.modelPresets.some(p => p.id === inheritedModel) ? inheritedModel : DBState.db.modelPresets[0]?.id) || ''
            promptId = selection?.promptPresetId || chat?.bindedBotPreset || DBState.db.botPresets[DBState.db.botPresetsId]?.id || ''
            agentId = selection?.agentPresetId || chat?.boundAgentPresetId || ''
        }
    })
    $effect(() => { limitInput = $sideChatLimit })
    $effect(() => { session?.messages; session?.updatedAt; if (scrollElement) scrollElement.scrollTop = scrollElement.scrollHeight })

    function newSession() {
        sideChatPanel.set({ open: true, sessionId: null, origin: selectedSideOrigin() || undefined })
        formKey = ''; pendingSend = null
    }
    async function perform(task: () => Promise<void>) {
        if (busy) return
        busy = true; error = ''
        try { await task() } catch (e) { error = e.message; if (e.status >= 400 && e.status < 500) pendingSend = null } finally { busy = false }
    }
    async function send() {
        await perform(async () => {
            if (!pendingSend) {
                const selection: SideChatSelection = { modelPresetId: modelId, promptPresetId: promptId, agentPresetId: agentId }
                let source = session?.source
                if (!source) {
                    const origin = get(sideChatPanel).origin || selectedSideOrigin()
                    const char = DBState.db.characters.find(c => c.chaId === origin?.characterId)
                    const index = char?.chats.findIndex(c => c.id === origin?.chatId)
                    if (!char || index == null || index < 0) throw new Error(t.missingOrigin)
                    await ensureCurrentChatReady(char.chats, index, char.chaId)
                    source = snapshotSideOrigin(char.chaId, origin.chatId)
                }
                const program = await prepareSideProgram(source, selection)
                pendingSend = { requestId: v4(), text, selection, program, source: session ? undefined : source, revision: session?.revision }
            }
            await flushSaves()
            const result = await sideApi(session ? `/${session.id}/turns` : '', 'POST', pendingSend)
            acceptSideSession(result)
            pendingSend = null; text = ''
            sideChatPanel.set({ open: true, sessionId: result.id })
            await refreshSideChats()
        })
    }
    async function saveSelection() {
        pendingSend = null
        if (!session) return
        await perform(async () => {
            await flushSaves()
            acceptSideSession(await sideApi(`/${session.id}`, 'PATCH', { revision: session.revision, selection: { modelPresetId: modelId, promptPresetId: promptId, agentPresetId: agentId } }))
        })
    }
    async function promote() {
        await perform(async () => {
            const selected = session
            branchRequestId ||= v4()
            const result = await withServerDatabaseMutation(() => sideApi(`/${selected.id}/branch`, 'POST', { requestId: branchRequestId }))
            const index = DBState.db.characters.findIndex(c => c.chaId === result.characterId)
            if (index < 0) throw new Error(t.missingOrigin)
            const char = DBState.db.characters[index]
            const chatIndex = char.chats.findIndex(c => c.id === result.chatId)
            if (chatIndex < 0) throw new Error('The server branch could not be synchronized.')
            char.chats[chatIndex] = result.chat
            changeChar(index); changeChatTo(result.chatId)
            sideChatPanel.update(state => ({ ...state, open: false }))
        })
    }
</script>

{#if $sideChatPanel.open}
<aside class="side-panel" aria-label={t.title}>
    <header>
        <div class="title"><MessageSquare size={20}/><strong>{t.title}</strong></div>
        <button aria-label={t.newSession} onclick={newSession} disabled={busy}><Plus size={20}/></button>
        <button aria-label={t.close} onclick={() => sideChatPanel.update(s => ({ ...s, open: false }))}><X size={20}/></button>
    </header>
    <div class="session-list">
        <select aria-label={t.sessions} value={$sideChatPanel.sessionId || ''} onchange={e => { if (e.currentTarget.value) void perform(() => openSideSession(e.currentTarget.value)); else newSession() }}>
            <option value="">{t.newSession}</option>
            {#each $sideChatSessions as s}<option value={s.id}>{s.name} · {t.status[s.status]}</option>{/each}
        </select>
        <label class="limit">{t.limit}<input type="number" min="1" step="1" bind:value={limitInput} aria-label={t.limit}/></label>
        <button class="small" disabled={busy} onclick={() => perform(() => setSideChatLimit(limitInput))}>{t.apply}</button>
    </div>
    <div class="configuration">
        <label>{t.model}<select bind:value={modelId} disabled={busy || generating} onchange={saveSelection}><option value="">{t.choose}</option>{#each DBState.db.modelPresets as preset}<option value={preset.id}>{preset.name}</option>{/each}</select></label>
        <label>{t.prompt}<select bind:value={promptId} disabled={busy || generating} onchange={saveSelection}><option value="">{t.choose}</option>{#each DBState.db.botPresets as preset}<option value={preset.id}>{preset.name}</option>{/each}</select></label>
        <label>{t.agent}<select bind:value={agentId} disabled={busy || generating} onchange={saveSelection}>
            <option value="">{t.noAgent}</option>
            {#each agentGroups as group (group.folder?.id ?? '')}
                {#if group.indexes.length}
                    <optgroup label={group.folder?.name ?? language.folderUncategorized}>
                        {#each group.indexes as index (DBState.db.agentPresets[index].id)}
                            {@const preset = DBState.db.agentPresets[index]}
                            <option value={preset.id}>{preset.name}</option>
                        {/each}
                    </optgroup>
                {/if}
            {/each}
        </select></label>
        <p class="hint">{t.scope}</p>
    </div>
    <div class="messages" bind:this={scrollElement} aria-live="polite">
        {#if !session}<p class="empty">{t.explanation}</p>{/if}
        {#if session}
            <p class="hint">{session.name} · {t.status[session.status]}</p>
            {#each session.messages as message (message.chatId)}
                <article class:user={message.role === 'user'}><strong>{message.role === 'user' ? language.user : t.answer}</strong><div>{message.displayData || message.data}</div></article>
            {/each}
            {#if session.run?.nodes?.length > 1}<details><summary>{t.agentProgress}</summary>{#each session.run.nodes as node}<p>{node.nodeName} · {node.status}{#if node.error}: {node.error}{/if}</p>{/each}</details>{/if}
            {#if session.error}<p class="error">{session.error}</p>{/if}
        {/if}
        {#if error || $sideChatConnectionError}<p class="error" role="alert">{error || $sideChatConnectionError}</p>{/if}
    </div>
    <footer>
        {#if session}<div class="actions">
            <button disabled={busy || generating || !session.messages.some(m => m.role === 'char' && m.data)} onclick={promote}><GitBranch size={16}/>{t.branch}</button>
            <button disabled={busy || generating} onclick={() => perform(async () => { await sideApi(`/${session.id}`, 'DELETE'); newSession(); await refreshSideChats() })}><Trash2 size={16}/>{t.delete}</button>
        </div>{/if}
        <textarea bind:value={text} aria-label={t.input} placeholder={t.input} disabled={busy || generating} onkeydown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!generating) void send() } }}></textarea>
        {#if generating}<button class="send" onclick={() => perform(async () => { await sideApi(`/${session.id}/stop`, 'POST'); await refreshSideChats() })} disabled={busy}><Square size={16}/>{t.stop}</button>
        {:else}<button class="send" onclick={send} disabled={busy || !modelId || !promptId}><Send size={16}/>{busy ? t.preparing : t.send}</button>{/if}
    </footer>
</aside>
{/if}

<style>
    .side-panel { position: fixed; right: 0; top: 0; bottom: 0; width: min(440px, 100vw); z-index: 10000; display: flex; flex-direction: column; background: var(--bgcolor, #171923); color: var(--textcolor, #eee); border-left: 1px solid #ffffff25; box-shadow: -10px 0 40px #0005; }
    header, .session-list, .actions, .title { display: flex; align-items: center; gap: 8px; }
    header { padding: 12px; border-bottom: 1px solid #ffffff20; } .title { flex: 1; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 10px; border-radius: 8px; background: #ffffff0c; cursor: pointer; }
    header button { width: 44px; height: 44px; } button:disabled { opacity: .45; cursor: default; }
    .session-list { padding: 10px 12px; flex-wrap: wrap; } .session-list > select { width: 100%; }
    select, input, textarea { color: inherit; background: #171923; border: 1px solid #ffffff30; border-radius: 7px; padding: 7px; min-width: 0; } option { background: #171923; }
    .limit { flex: 1; display: flex; align-items: center; gap: 8px; font-size: 12px; } .limit input { width: 65px; }
    .configuration { padding: 0 12px 10px; display: grid; gap: 8px; border-bottom: 1px solid #ffffff20; }
    .configuration label { display: grid; grid-template-columns: 68px 1fr; gap: 8px; align-items: center; font-size: 13px; }
    .hint { font-size: 12px; opacity: .65; line-height: 1.5; } .messages { flex: 1; overflow: auto; min-height: 0; padding: 12px; }
    article { margin: 10px 0; padding: 12px; border-radius: 10px; background: #ffffff08; overflow-wrap: anywhere; } article.user { background: #6480e01c; } article strong { font-size: 12px; opacity: .7; } article div { white-space: pre-wrap; line-height: 1.65; margin-top: 4px; }
    .empty { line-height: 1.8; opacity: .7; font-size: 14px; } .error { color: #fca5a5; font-size: 13px; overflow-wrap: anywhere; }
    footer { padding: 12px; border-top: 1px solid #ffffff20; display: grid; gap: 8px; padding-bottom: max(12px, env(safe-area-inset-bottom)); }
    textarea { width: 100%; min-height: 72px; max-height: 150px; resize: vertical; } .send { background: #6480e03b; } .actions { justify-content: space-between; }
    @media (max-width: 600px) { .side-panel { width: 100%; } .configuration { gap: 5px; } }
</style>
