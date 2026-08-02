<script lang="ts">
    import { PlusIcon, TrashIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import RegexList from 'src/lib/SideBars/Scripts/RegexList.svelte'
    import TriggerList from 'src/lib/SideBars/Scripts/TriggerList.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import type { RisuToolPackage } from 'src/ts/process/tools/types'
    import { saveAsset } from 'src/ts/globalApi.svelte'
    import { selectMultipleFile } from 'src/ts/util'

    interface Props { currentTool: RisuToolPackage }
    let { currentTool = $bindable() }: Props = $props()

    $effect.pre(() => {
        currentTool.regex ??= []
        currentTool.trigger ??= []
        currentTool.assets ??= []
        currentTool.customToggle ??= ''
        currentTool.backgroundEmbedding ??= ''
        currentTool.lowLevelAccess ??= false
    })

    async function addAssets() {
        const files = await selectMultipleFile(['png', 'webp', 'gif', 'jpeg', 'jpg', 'svg', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'css', 'ttf', 'otf', 'woff', 'woff2', 'json'])
        for (const file of files ?? []) {
            const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'bin'
            const path = await saveAsset(file.data, '', extension)
            currentTool.assets!.push([file.name, path, extension])
        }
        currentTool.assets = currentTool.assets
    }
</script>

<div class="flex flex-col gap-3">
    <strong>{language.toolCustomToggle}</strong>
    <p class="text-xs text-textcolor2">{language.toolCustomToggleHint}</p>
    <TextAreaInput bind:value={currentTool.customToggle} className="font-mono min-h-32" />

    <strong>{language.toolBackgroundEmbedding}</strong>
    <p class="text-xs text-textcolor2">{language.toolBackgroundEmbeddingHint}</p>
    <TextAreaInput bind:value={currentTool.backgroundEmbedding} className="font-mono min-h-40" popupLanguage="html" />

    <strong>{language.toolAssets}</strong>
    <p class="text-xs text-textcolor2">{language.toolAssetsHint}</p>
    <div class="border border-darkborderc rounded-md overflow-hidden">
        {#each currentTool.assets ?? [] as asset, index}
            <div class="flex items-center gap-2 p-2 border-b border-darkborderc last:border-b-0"><code class="grow break-all">{asset[0]}</code><span class="text-xs text-textcolor2">{asset[2]}</span><button class="text-textcolor2 hover:text-red-400" onclick={() => { currentTool.assets!.splice(index, 1); currentTool.assets = currentTool.assets }}><TrashIcon size={18}/></button></div>
        {/each}
        <button class="p-3 w-full flex justify-center hover:text-primary" onclick={addAssets}><PlusIcon size={20}/></button>
    </div>

    <strong>{language.toolRegex}</strong>
    <RegexList bind:value={currentTool.regex} buttons={true} />

    <strong>{language.toolTriggers}</strong>
    <div class="flex items-center gap-2">
        <CheckInput bind:check={currentTool.lowLevelAccess} name={language.lowLevelAccess} margin={false} />
    </div>
    <TriggerList bind:value={currentTool.trigger} lowLevelAble={currentTool.lowLevelAccess} />
</div>
