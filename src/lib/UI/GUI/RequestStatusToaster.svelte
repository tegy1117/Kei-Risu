<script lang="ts">
    // Keep one sonner surface and render independent status cards inside it.
    // Sonner prepends separate toasts; a stable stack keeps spawned agents
    // below their parent request while preserving the app's top-right placement.
    import { onDestroy } from 'svelte'
    import { toast } from 'svelte-sonner'
    import { requestStatuses, isTerminalPhase, clearStatus } from 'src/ts/status/requestStatus'
    import RequestStatusStack from './RequestStatusStack.svelte'

    const RETENTION_MS = 4000
    const STACK_ID = 'req:stack'
    let shown = false
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

    function scheduleDismiss(id: string): void {
        if (dismissTimers.has(id)) return
        const timer = setTimeout(() => {
            dismissTimers.delete(id)
            clearStatus(id)
        }, RETENTION_MS)
        dismissTimers.set(id, timer)
    }

    const unsub = requestStatuses.subscribe((map) => {
        if(map.size > 0 && !shown){
            shown = true
            toast.custom(RequestStatusStack, {
                id: STACK_ID,
                duration: Number.POSITIVE_INFINITY,
                dismissible: false,
                unstyled: true,
            })
        } else if(map.size === 0 && shown){
            shown = false
            toast.dismiss(STACK_ID)
        }

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
        toast.dismiss(STACK_ID)
    })
</script>
