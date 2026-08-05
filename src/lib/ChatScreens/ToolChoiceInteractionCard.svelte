<script lang="ts">
    import { ListChecksIcon, XIcon } from '@lucide/svelte'
    import { answerChoice, cancelChoice, choiceInteractionStore } from 'src/ts/process/tools/choice'
    import { get } from 'svelte/store'
    import { onDestroy } from 'svelte'

    onDestroy(() => {
        const interaction = get(choiceInteractionStore)
        if (interaction) cancelChoice(interaction.id)
    })
</script>

{#if $choiceInteractionStore}
    {@const interaction = $choiceInteractionStore}
    <section class="x-risu-tool-call x-risu-choice-interaction" aria-live="polite">
        <div class="flex items-center gap-2">
            <ListChecksIcon size={20}/>
            <strong>{interaction.request.question}</strong>
            <button class="ml-auto text-textcolor2 hover:text-red-400" aria-label="Cancel" onclick={() => cancelChoice(interaction.id)}><XIcon size={18}/></button>
        </div>
        {#if interaction.request.reason}<p class="text-sm text-textcolor2 my-2">{interaction.request.reason}</p>{/if}
        <div class="flex flex-col gap-2 mt-3">
            {#each interaction.request.options as option, index}
                <button class="border border-darkborderc rounded-md px-3 py-2 text-left hover:border-primary hover:text-primary" onclick={() => answerChoice(interaction.id, index)}>
                    <span class="font-semibold">{option.label}</span>
                    {#if option.description}<span class="block text-sm text-textcolor2 mt-1">{option.description}</span>{/if}
                </button>
            {/each}
        </div>
    </section>
{/if}
