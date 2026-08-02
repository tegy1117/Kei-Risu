<script lang="ts">
    import { orderedRequestStatusIds, requestStatuses } from 'src/ts/status/requestStatus'
    import RequestStatusToast from './RequestStatusToast.svelte'

    const ids = $derived(orderedRequestStatusIds($requestStatuses))
</script>

<div class="rs-stack" aria-live="polite" aria-label="AI request status">
    {#each ids as id (id)}
        <RequestStatusToast {id} />
    {/each}
</div>

<style>
    .rs-stack {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(420px, calc(100vw - 32px));
        pointer-events: auto;
    }
</style>
