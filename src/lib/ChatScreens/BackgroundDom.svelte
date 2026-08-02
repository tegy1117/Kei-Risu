<script lang="ts">
    import { ParseMarkdown, risuChatParser } from "src/ts/parser/parser.svelte";
    import { type character } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { moduleBackgroundEmbedding, ReloadGUIPointer, selIdState } from "src/ts/stores.svelte";
    import { getToolBackgroundEmbedding } from 'src/ts/process/tools/features';

    let backgroundHTML = $derived(DBState.db?.characters?.[selIdState.selId]?.backgroundHTML)
    let currentChar:character = $derived(DBState.db?.characters?.[selIdState.selId])
    let toolBackgroundEmbedding = $derived.by(() => {
        void DBState.db.enabledTools
        void DBState.db.toolPolicy
        void currentChar?.tools
        void currentChar?.chats?.[currentChar.chatPage]?.tools
        return getToolBackgroundEmbedding()
    })

</script>


{#if backgroundHTML || $moduleBackgroundEmbedding || toolBackgroundEmbedding}
    {#if selIdState.selId > -1}
        {#key $ReloadGUIPointer}
            <div class="absolute top-0 left-0 w-full h-full">
                {#await ParseMarkdown(risuChatParser((backgroundHTML || '') + '\n' + ($moduleBackgroundEmbedding || '') + '\n' + toolBackgroundEmbedding, {chara:currentChar}), currentChar, 'back') then md}
                    {@html md}
                {/await}
            </div>
        {/key}
    {/if}
{/if}
