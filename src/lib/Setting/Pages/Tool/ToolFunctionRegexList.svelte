<script lang="ts">
    import { PlusIcon, TrashIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type { RisuToolFunction, RisuToolPackage, ToolFunctionRegexScript, ToolRegexStage } from 'src/ts/process/tools/types'
    import { v4 } from 'uuid'

    interface Props { currentTool: RisuToolPackage }
    let { currentTool = $bindable() }: Props = $props()

    const commonStages: Array<{ value: ToolRegexStage, label: string }> = [
        { value: 'arguments', label: language.toolRegexArguments },
        { value: 'modelResult', label: language.toolRegexModelResult },
        { value: 'pendingCard', label: language.toolRegexPendingCard },
        { value: 'successCard', label: language.toolRegexSuccessCard },
        { value: 'errorCard', label: language.toolRegexErrorCard },
    ]
    const agentStages: Array<{ value: ToolRegexStage, label: string }> = [
        { value: 'agentOutput', label: language.toolRegexAgentOutput },
        { value: 'visibleCall', label: language.toolRegexVisibleCall },
    ]

    function selectedFunction(script: ToolFunctionRegexScript): RisuToolFunction | undefined {
        return currentTool.functions.find((fn) => fn.id === script.functionId)
    }
    function stagesFor(script: ToolFunctionRegexScript) {
        return selectedFunction(script)?.execution?.kind === 'agent' ? [...commonStages, ...agentStages] : commonStages
    }
    function addScript() {
        const functionId = currentTool.functions[0]?.id
        if (!functionId) return
        currentTool.functionRegex ??= []
        currentTool.functionRegex.push({
            id: v4(), functionId, comment: '', in: '', out: '', type: 'arguments', flag: 'g', ableFlag: true, enabled: true,
        })
        currentTool.functionRegex = currentTool.functionRegex
    }
    function removeScript(index: number) {
        currentTool.functionRegex?.splice(index, 1)
        currentTool.functionRegex = currentTool.functionRegex
    }
    function getOrder(flag = '') { return Number.parseInt(flag.match(/<order (-?\d+)>/)?.[1] ?? '0', 10) }
    function setOrder(script: ToolFunctionRegexScript, order: number) {
        const flag = script.flag ?? 'g'
        script.flag = flag.includes('<order ')
            ? flag.replace(/<order (-?\d+)>/, `<order ${order}>`)
            : `${flag}<order ${order}>`
        currentTool.functionRegex = currentTool.functionRegex
    }
    function normalizeStage(script: ToolFunctionRegexScript) {
        if (!stagesFor(script).some((stage) => stage.value === script.type)) script.type = 'arguments'
        currentTool.functionRegex = currentTool.functionRegex
    }
</script>

<div class="flex flex-col gap-3">
    {#if currentTool.functions.length === 0}
        <p class="text-sm text-textcolor2">{language.toolRegexNeedsFunction}</p>
    {/if}
    {#each currentTool.functionRegex ?? [] as script, index (script.id)}
        <div class="border border-darkborderc rounded-md p-3 flex flex-col gap-2">
            <div class="flex items-center gap-2">
                <CheckInput check={script.enabled !== false} name={language.toolRegexEnabled} margin={false} onChange={(value) => { script.enabled = value; currentTool.functionRegex = currentTool.functionRegex }} />
                <button class="ml-auto text-textcolor2 hover:text-red-400" onclick={() => removeScript(index)}><TrashIcon size={18}/></button>
            </div>
            <TextInput bind:value={script.comment} placeholder={language.name} />
            <span class="text-sm text-textcolor2">{language.toolRegexFunction}</span>
            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={script.functionId} onchange={() => normalizeStage(script)}>
                {#each currentTool.functions as fn}<option value={fn.id}>{currentTool.namespace}__{fn.name}</option>{/each}
            </select>
            <span class="text-sm text-textcolor2">{language.toolRegexStage}</span>
            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={script.type}>
                {#each stagesFor(script) as stage}<option value={stage.value}>{stage.label}</option>{/each}
            </select>
            <span class="text-sm text-textcolor2">IN</span>
            <TextInput bind:value={script.in} placeholder="Regex pattern" />
            <span class="text-sm text-textcolor2">OUT</span>
            <TextAreaInput bind:value={script.out} className="font-mono min-h-20" />
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div class="flex flex-col gap-1"><span class="text-sm text-textcolor2">{language.toolRegexFlags}</span><TextInput bind:value={script.flag} placeholder="gimsu" /></div>
                <div class="flex flex-col gap-1"><span class="text-sm text-textcolor2">{language.toolRegexOrder}</span><NumberInput value={getOrder(script.flag)} onChange={(event) => setOrder(script, Number.parseInt(event.currentTarget.value || '0', 10))} /></div>
            </div>
        </div>
    {/each}
    <button class="border border-dashed border-darkborderc rounded-md p-3 hover:text-primary flex justify-center disabled:opacity-40" disabled={currentTool.functions.length === 0} onclick={addScript}><PlusIcon size={20}/></button>
</div>
