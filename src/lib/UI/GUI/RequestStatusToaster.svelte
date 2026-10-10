<script lang="ts">
    // A stable overlay keeps agents below their parent request. Only the
    // individual buttons capture touches; empty stack space passes through.
    import { onDestroy } from 'svelte'
    import { startSideDiscovery } from 'src/ts/sideChat/client'
    import { loadedStore } from 'src/ts/stores.svelte'
    import { isTouchDevice } from 'src/ts/stores.svelte'
    import { requestStatuses, isTerminalPhase, clearStatus } from 'src/ts/status/requestStatus'
    import RequestStatusStack from './RequestStatusStack.svelte'

    const RETENTION_MS = 4000
    const visible = $derived($requestStatuses.size > 0)
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
    $effect(() => { if ($loadedStore) return startSideDiscovery() })

    function scheduleDismiss(id: string): void {
        if (dismissTimers.has(id)) return
        const timer = setTimeout(() => {
            dismissTimers.delete(id)
            clearStatus(id)
        }, RETENTION_MS)
        dismissTimers.set(id, timer)
    }

    const unsub = requestStatuses.subscribe((map) => {
        for(const [id, entry] of map){
            if(isTerminalPhase(entry.phase)){
                scheduleDismiss(id)
            } else if(dismissTimers.has(id)){
                clearTimeout(dismissTimers.get(id))
                dismissTimers.delete(id)
            }
        }

        for(const [id, timer] of dismissTimers){
            if(!map.has(id)){
                clearTimeout(timer)
                dismissTimers.delete(id)
            }
        }
    })

    onDestroy(() => {
        unsub()
        for(const timer of dismissTimers.values()) clearTimeout(timer)
        dismissTimers.clear()
    })
</script>

{#if visible}
    <div class="rs-overlay" class:rs-mobile={$isTouchDevice}>
        <RequestStatusStack />
    </div>
{/if}
<style>
    .rs-overlay { position: fixed; top: max(16px, env(safe-area-inset-top)); right: 16px; z-index: 9999; pointer-events: none; }
    .rs-mobile { right: auto; left: 50%; transform: translateX(-50%); }
</style>
