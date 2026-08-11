<script lang="ts">
    import { ExpandIcon, Minimize2Icon, XIcon } from '@lucide/svelte'
    import { onDestroy, onMount } from 'svelte'
    import { cancelActiveToolApp, cancelToolAppSession, registerToolAppRuntimeMount, setToolAppViewMode, toolAppSessionStore } from 'src/ts/process/tools/toolApp'
    import { toolInteractionStore } from 'src/ts/process/tools/interaction'

    let mountPoint = $state<HTMLDivElement>()
    let unregisterMount = () => {}
    let session = $derived($toolAppSessionStore)
    let isVisible = $derived(!!session && $toolInteractionStore?.kind === 'tool-app' && $toolInteractionStore.id === session.id)

    onMount(() => {
        if (mountPoint) unregisterMount = registerToolAppRuntimeMount(mountPoint)
    })

    onDestroy(() => {
        cancelActiveToolApp('view_unmounted')
        unregisterMount()
    })
</script>

<div
    class:tool-app-hidden={!isVisible}
    class:tool-app-overlay={!!session && session.mode !== 'inline'}
    class:tool-app-fullscreen={session?.mode === 'fullscreen'}
>
    <section
        class="x-risu-tool-call x-risu-tool-app flex flex-col overflow-hidden"
        class:tool-app-modal={session?.mode === 'modal'}
        class:tool-app-screen={session?.mode === 'fullscreen'}
        aria-live="polite"
    >
        {#if isVisible && session}
            <header class="flex items-center gap-2 border-b border-darkborderc px-3 py-2 shrink-0">
                <strong class="truncate">{session.title}</strong>
                <span class="text-xs text-textcolor2">Tool App</span>
                <div class="ml-auto flex items-center gap-2">
                    {#if session.allowExpand}
                        {#if session.mode === 'inline'}
                            <button class="text-textcolor2 hover:text-primary" aria-label="Expand Tool App" onclick={() => setToolAppViewMode(session.id, 'modal')}><ExpandIcon size={18}/></button>
                        {:else}
                            <button class="text-textcolor2 hover:text-primary" aria-label="Return Tool App inline" onclick={() => setToolAppViewMode(session.id, 'inline')}><Minimize2Icon size={18}/></button>
                            {#if session.mode === 'modal'}<button class="text-textcolor2 hover:text-primary" aria-label="Open Tool App fullscreen" onclick={() => setToolAppViewMode(session.id, 'fullscreen')}><ExpandIcon size={18}/></button>{/if}
                        {/if}
                    {/if}
                    <button class="text-textcolor2 hover:text-red-400" aria-label="Cancel Tool App" onclick={() => cancelToolAppSession(session.id)}><XIcon size={18}/></button>
                </div>
            </header>
        {/if}
        <div class="tool-app-frame" style:min-height={`${isVisible && session ? session.minHeight : 0}px`} bind:this={mountPoint}></div>
    </section>
</div>

<style>
    .tool-app-hidden { display: none; }
    .x-risu-tool-app { padding: 0; width: 100%; }
    .tool-app-frame { width: 100%; overflow: hidden; background: transparent; }
    .tool-app-frame :global(iframe) { display: block; min-height: inherit; }
    .tool-app-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgb(0 0 0 / 55%); }
    .tool-app-modal { width: min(56rem, 100%); max-height: min(52rem, calc(100vh - 2rem)); }
    .tool-app-modal .tool-app-frame { height: min(42rem, calc(100vh - 8rem)); }
    .tool-app-fullscreen { padding: 0; }
    .tool-app-screen { width: 100%; height: 100%; border-radius: 0; }
    .tool-app-screen .tool-app-frame { flex: 1; min-height: 0 !important; }
    @media (max-width: 640px) {
        .tool-app-overlay { padding: 0; align-items: stretch; }
        .tool-app-modal { width: 100%; max-height: 100%; border-radius: 0; }
        .tool-app-modal .tool-app-frame { height: calc(100vh - 3rem); }
    }
</style>
