<script lang="ts">
    import { DicesIcon, XIcon } from '@lucide/svelte'
    import { activateDiceRoll, cancelDiceRoll, diceInteractionStore } from 'src/ts/process/tools/dice'
    import { language } from 'src/lang'
    import { get } from 'svelte/store'
    import { onDestroy } from 'svelte'

    let reducedMotion = $state(false)
    $effect(() => {
        reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    })

    function label(kind: string) {
        return kind === 'coin' ? language.toolDiceCoin : kind === 'range' ? language.toolDiceRoulette : kind.toUpperCase()
    }

    onDestroy(() => {
        const interaction = get(diceInteractionStore)
        if (interaction) cancelDiceRoll(interaction.id)
    })
</script>

{#if $diceInteractionStore}
    {@const interaction = $diceInteractionStore}
    <section class="x-risu-tool-call x-risu-dice-interaction" aria-live="polite">
        <div class="flex items-center gap-2">
            <DicesIcon size={20}/>
            <strong>{label(interaction.request.kind)}</strong>
            <span class="text-sm text-textcolor2">× {interaction.request.count}</span>
            {#if interaction.request.modifier}<span class="text-sm">{interaction.request.modifier > 0 ? '+' : ''}{interaction.request.modifier}</span>{/if}
            <button class="ml-auto text-textcolor2 hover:text-red-400" aria-label={language.toolDiceCancel} onclick={() => cancelDiceRoll(interaction.id)} disabled={interaction.status === 'rolling'}><XIcon size={18}/></button>
        </div>
        {#if interaction.request.reason}<p class="text-sm text-textcolor2 my-2">{interaction.request.reason}</p>{/if}
        {#if interaction.status === 'waiting'}
            <button class="x-risu-dice-roll-button" onclick={() => activateDiceRoll(interaction.id, reducedMotion ? 0 : 800)}>{language.toolDiceRoll}</button>
        {:else}
            <div class="x-risu-dice-rolling" class:motion-reduce={reducedMotion}>
                {#each interaction.result?.rolls ?? [] as roll}
                    <span>{roll.dice ? roll.dice.join(' · ') : roll.label ?? roll.value}</span>
                {/each}
            </div>
        {/if}
    </section>
{/if}
