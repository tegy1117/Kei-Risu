<script lang="ts">
    // One request-status card per generation. Its body collapses independently;
    // the separate navigation button opens the originating conversation. See
    // .agent/notes/request-status-toast-infra.md and the workspace mockup.
    //
    // Layout (left color bar = phase):
    //   row1: ●dot  phase(bold)  [kind chip]  elapsed ........ output N (right)
    //   row2: model · think N · tok/s   (dim detail; 0/empty hidden)
    //   row3+: cache/search/tool badges (future)
    import { onMount } from 'svelte'
    import { requestStatuses, isTerminalPhase, type RequestPhase, type RequestKind } from 'src/ts/status/requestStatus'
    import { language } from 'src/lang'
    import { RotateCwIcon, ArrowUpRightIcon } from '@lucide/svelte'

    let { id }: { id: string } = $props()

    let collapsed = $state(false)
    const entry = $derived($requestStatuses.get(id))
    const rs = language.requestStatus

    // Live elapsed clock: tick while the entry is non-terminal.
    let now = $state(Date.now())
    onMount(() => {
        const t = setInterval(() => { now = Date.now() }, 200)
        return () => clearInterval(t)
    })

    const PHASE_LABEL: Record<RequestPhase, string> = {
        queued: rs?.queued ?? 'Queued…',
        connecting: rs?.connecting ?? 'Connecting…',
        thinking:   rs?.thinking ?? 'Thinking…',
        responding: rs?.responding ?? 'Responding…',
        using_tool: rs?.usingTool ?? 'Using tool…',
        retrying:   rs?.retrying ?? 'Retrying…',
        stalled:    rs?.stalled ?? 'Stalled…',
        background: rs?.background ?? 'In background…',
        postprocessing: rs?.postprocessing ?? 'Post-processing…',
        done:       rs?.done ?? 'Done',
        partial:    rs?.partial ?? 'Partially completed',
        failed:     rs?.failed ?? 'Failed',
        aborted:    rs?.aborted ?? 'Cancelled',
    }
    const KIND_LABEL: Record<RequestKind, string> = {
        main:      rs?.kindMain ?? 'Main',
        translate: rs?.kindTranslate ?? 'Translate',
        memory:    rs?.kindMemory ?? 'Memory',
        emotion:   rs?.kindEmotion ?? 'Emotion',
        sub:       rs?.kindSub ?? 'Sub',
        agent:     rs?.kindAgent ?? 'Agent',
        'tool-agent': rs?.kindToolAgent ?? 'Tool agent',
    }

    // Accent bar / phase text color by phase.
    function accentClass(phase: RequestPhase): string {
        if (phase === 'done') return 'rs-accent-success'
        if (phase === 'partial') return 'rs-accent-warning'
        if (phase === 'failed') return 'rs-accent-danger'
        if (phase === 'stalled' || phase === 'aborted') return 'rs-accent-muted'
        return 'rs-accent-primary'
    }
    function phaseColor(phase: RequestPhase): string {
        if (phase === 'done') return 'text-success'
        if (phase === 'partial') return 'text-yellow-400'
        if (phase === 'failed') return 'text-draculared'
        if (phase === 'stalled' || phase === 'aborted') return 'text-textcolor2'
        return 'text-primary'
    }

    function fmt(n: number): string {
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
        return String(n)
    }
    function elapsedStr(e: NonNullable<typeof entry>): string {
        // Once terminal, freeze at the recorded end time (endStatus sets endedAt);
        // otherwise tick live. lastChunkAt is NOT used — non-streaming paths never
        // update it, which made completed elapsed read 0.
        const end = isTerminalPhase(e.phase) ? (e.endedAt ?? now) : now
        return ((Math.max(0, end - e.startedAt)) / 1000).toFixed(1) + 's'
    }

    // Right-side single number: output tokens once any arrive, else thinking.
    const right = $derived.by(() => {
        const e = entry
        if (!e) return null
        if (e.responseTokens > 0) return { label: rs?.outputTokens ?? 'out', value: fmt(e.responseTokens) }
        if (e.thinkingTokens > 0) return { label: rs?.thinkingTokensLabel ?? 'think', value: fmt(e.thinkingTokens) }
        return null
    })

    // Second-row detail: model · think (when both present) · tok/s. Empty parts dropped.
    const detail = $derived.by(() => {
        const e = entry
        if (!e) return ''
        const parts: string[] = [e.label]
        if (e.responseTokens > 0 && e.thinkingTokens > 0) parts.push(`${rs?.thinkingTokensLabel ?? 'think'} ${fmt(e.thinkingTokens)}`)
        if (e.tokPerSec > 0) parts.push(`${Math.round(e.tokPerSec)} ${rs?.tokensPerSec ?? 'tok/s'}`)
        return parts.join(' · ')
    })

    const spinning = $derived(entry ? !isTerminalPhase(entry.phase) && entry.phase !== 'stalled' : false)

    const compactLabel = $derived(entry
        ? (isTerminalPhase(entry.phase) ? PHASE_LABEL[entry.phase] : (rs?.generating ?? 'Generating'))
        : '')
    const origin = $derived(entry?.chatId ? { chatId: entry.chatId } : null)
    async function openOrigin(): Promise<void> {
        const target = origin
        if (!target) return
        const { changeChar } = await import('src/ts/characters')
        const { changeChatTo } = await import('src/ts/globalApi.svelte')
        const { DBState, MobileGUIStack } = await import('src/ts/stores.svelte')
        const index = DBState.db.characters.findIndex(c => c.chats.some(chat => chat.id === target.chatId))
        if (index < 0) return
        changeChar(index)
        changeChatTo(target.chatId)
        MobileGUIStack.set(1)
    }
</script>

{#if entry}
    {#if collapsed}
        <button type="button" class="rs-compact {accentClass(entry.phase)}" onclick={() => { collapsed = false }} aria-expanded="false">{compactLabel}</button>
    {:else}
    <div class="rs-card {accentClass(entry.phase)}">
        <button type="button" class="rs-body" onclick={() => { collapsed = true }} aria-expanded="true">
            <div class="rs-row1">
                <span class="rs-dot" class:rs-dot-success={entry.phase === 'done'}
                      class:rs-dot-warning={entry.phase === 'partial'}
                      class:rs-dot-danger={entry.phase === 'failed'}
                      class:rs-dot-muted={entry.phase === 'stalled' || entry.phase === 'aborted'}
                      class:rs-breathe={spinning}></span>

                {#if entry.phase === 'retrying'}
                    <RotateCwIcon size={14} class="text-primary rs-spin shrink-0" />
                {/if}

                <span class="rs-phase {phaseColor(entry.phase)}">{PHASE_LABEL[entry.phase]}</span>
                <span class="rs-chip">{KIND_LABEL[entry.kind]}</span>
                <span class="rs-elapsed">{elapsedStr(entry)}</span>

                {#if entry.retryAttempt}
                    <span class="rs-retry">#{entry.retryAttempt}</span>
                {/if}
                <span class="rs-actions">
                    {#if right}<span class="rs-right">{right.label} <b>{right.value}</b></span>{/if}

                </span>
            </div>

            {#if entry.error}
                <div class="rs-detail rs-error truncate">{entry.error} · {entry.label}</div>
            {:else if detail}
                <div class="rs-detail truncate">{detail}</div>
            {/if}

            {#each entry.badges as badge (badge.key)}
                <div class="rs-badge-row truncate"
                     class:rs-badge-success={badge.tone === 'success'}
                     class:rs-badge-warn={badge.tone === 'warn'}>
                    {badge.text}
                </div>
            {/each}
        </button>
        <button type="button" class="rs-open" disabled={!origin} aria-label={rs?.openChat ?? 'Open originating chat'} title={rs?.openChat ?? 'Open originating chat'} onclick={openOrigin}>
            <ArrowUpRightIcon size={20} />
        </button>
    </div>
    {/if}
{/if}

<style>
    .rs-compact { width: fit-content; padding: 6px 12px; background: var(--risu-theme-darkbg); color: var(--risu-theme-textcolor); border: 1px solid var(--risu-theme-darkborderc); border-left-width: 4px; border-radius: 0.5rem; pointer-events: auto; font-size: 0.875rem; }
    .rs-open { display: grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; margin: 6px; border-radius: 6px; background: var(--risu-theme-selected); color: var(--risu-theme-textcolor); }
    .rs-open:disabled { opacity: .35; }
    .rs-open:focus-visible, .rs-body:focus-visible, .rs-compact:focus-visible { outline: 2px solid var(--risu-theme-primary); outline-offset: -2px; }
    .rs-card {
        display: flex;
        pointer-events: auto;
        width: 100%;
        background: var(--risu-theme-darkbg);
        color: var(--risu-theme-textcolor);
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.5rem;
        overflow: hidden;
        font-size: 0.875rem;
    }
    /* left accent bar via left border */
    .rs-card { border-left-width: 4px; }
    .rs-accent-primary { border-left-color: var(--risu-theme-primary); }
    .rs-accent-success { border-left-color: var(--risu-theme-success); }
    .rs-accent-warning { border-left-color: #facc15; }
    .rs-accent-danger  { border-left-color: var(--risu-theme-draculared); }
    .rs-accent-muted   { border-left-color: var(--risu-theme-textcolor2); }

    .rs-body { flex: 1; min-width: 0; padding: 10px 13px; text-align: left; }
    .rs-row1 { display: flex; align-items: center; gap: 8px; }

    .rs-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        background: var(--risu-theme-primary); }
    .rs-dot-success { background: var(--risu-theme-success); }
    .rs-dot-warning { background: #facc15; }
    .rs-dot-danger  { background: var(--risu-theme-draculared); }
    .rs-dot-muted   { background: var(--risu-theme-textcolor2); }
    .rs-breathe { animation: rs-breathe 1.5s ease-in-out infinite; }
    @keyframes rs-breathe {
        0%,100% { transform: scale(.7); opacity: .5; }
        50% { transform: scale(1.15); opacity: 1; }
    }
    :global(.rs-spin) { animation: rs-spin 1s linear infinite; }
    @keyframes rs-spin { to { transform: rotate(360deg); } }

    .rs-phase { font-weight: 600; }
    .rs-chip {
        font-size: 11px; padding: 1px 7px; border-radius: 999px; flex-shrink: 0;
        background: var(--risu-theme-selected); color: var(--risu-theme-textcolor);
    }
    .rs-elapsed { font-size: 12px; color: var(--risu-theme-textcolor2); font-variant-numeric: tabular-nums; }
    .rs-retry { font-size: 12px; color: var(--risu-theme-textcolor2); }
    .rs-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
    .rs-right { font-size: 12px; color: var(--risu-theme-textcolor2); white-space: nowrap; }
    .rs-right b { color: var(--risu-theme-textcolor); font-weight: 600; font-variant-numeric: tabular-nums; }

    .rs-detail { font-size: 12px; color: var(--risu-theme-textcolor2); margin-top: 3px; }
    .rs-error { color: var(--risu-theme-draculared); }
    .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .rs-badge-row { font-size: 12px; color: var(--risu-theme-textcolor2); margin-top: 5px; }
    .rs-badge-success { color: #4ade80; }
    .rs-badge-warn { color: #facc15; }
</style>
