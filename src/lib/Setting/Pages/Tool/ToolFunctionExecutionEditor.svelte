<script lang="ts">
    import { PlusIcon, TrashIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type { RisuToolFunction, RisuToolPackage, ToolAgentExecution, ToolAgentStateAction } from 'src/ts/process/tools/types'
    import { DBState } from 'src/ts/stores.svelte'
    import { v4 } from 'uuid'

    interface Props { currentTool: RisuToolPackage, fn: RisuToolFunction }
    let { currentTool = $bindable(), fn = $bindable() }: Props = $props()

    $effect.pre(() => {
        fn.execution ??= { kind: 'script' }
        fn.presentation ??= {}
        fn.presentation.showInChat ??= true
        fn.presentation.manualLaunch ??= { enabled: false, includeInModelHistory: true }
    })

    function refresh() { currentTool.functions = currentTool.functions }
    function setKind(kind: 'script' | 'agent') {
        if (kind === 'script') {
            currentTool.functionRegex = (currentTool.functionRegex ?? []).filter((script) =>
                script.functionId !== fn.id || (script.type !== 'agentOutput' && script.type !== 'visibleCall'))
        }
        fn.execution = kind === 'script' ? { kind: 'script', allowedTools: [] } : {
            kind: 'agent', modelPresetId: '', systemPrompt: '', userPrompt: '{{tool_args}}', allowedTools: [], outputRoutes: [],
        }
        refresh()
    }
    function agent(): ToolAgentExecution | null { return fn.execution?.kind === 'agent' ? fn.execution : null }
    function callableExecution() { return fn.execution?.kind === 'agent' || fn.execution?.kind === 'script' ? fn.execution : null }
    function addRoute() {
        agent()?.outputRoutes.push({ id: v4(), name: 'Success', pattern: '^(?<result>[\\s\\S]+)$', flags: '', outcome: 'success', modelTemplate: '{{tool_capture::result}}', cardTemplate: '{{tool_capture::result}}', actions: [] })
        refresh()
    }
    function addManagedTool(toolId: string, functionId: string, enabled: boolean) {
        const execution = callableExecution(); if (!execution) return
        execution.allowedTools ??= []
        execution.allowedTools = enabled
            ? [...execution.allowedTools, { kind: 'managed', toolId, functionId }]
            : execution.allowedTools.filter((ref) => ref.kind !== 'managed' || ref.toolId !== toolId || ref.functionId !== functionId)
        refresh()
    }
    function addExternalTool() {
        const execution = callableExecution(); if (!execution) return
        execution.allowedTools ??= []
        execution.allowedTools.push({ kind: 'external', name: '' }); refresh()
    }
    function addAction(routeIndex: number) {
        agent()?.outputRoutes[routeIndex].actions.push({ id: v4(), kind: 'setVariable', name: '', valueTemplate: '{{tool_capture::result}}' }); refresh()
    }
    function setActionKind(action: ToolAgentStateAction, kind: ToolAgentStateAction['kind']) {
        const id = action.id
        const next: ToolAgentStateAction = kind === 'upsertMemory'
            ? { id, kind, scope: 'chat', titleTemplate: '', contentTemplate: '{{tool_capture::result}}' }
            : { id, kind, name: '', valueTemplate: '{{tool_capture::result}}' }
        Object.keys(action).forEach((key) => delete (action as unknown as Record<string, unknown>)[key])
        Object.assign(action, next); refresh()
    }
</script>

<div class="border-t border-darkborderc pt-3 mt-2 flex flex-col gap-2">
    <strong>{language.toolExecution}</strong>
    <select class="bg-darkbg border border-darkborderc rounded-md p-2" value={fn.execution?.kind ?? 'script'} onchange={(event) => setKind(event.currentTarget.value as 'script' | 'agent')}>
        <option value="script">{language.toolExecutionScript}</option><option value="agent">{language.toolExecutionAgent}</option>
    </select>
    {#if fn.execution?.kind === 'agent'}
        {@const execution = fn.execution}
        <span>{language.toolAgentModel}</span>
        <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={execution.modelPresetId}>
            <option value="">{language.modelPresetUnset}</option>
            {#each DBState.db.modelPresets ?? [] as preset}<option value={preset.id}>{preset.name}</option>{/each}
        </select>
        <span>{language.toolAgentSystemPrompt}</span>
        <TextAreaInput bind:value={execution.systemPrompt} className="font-mono min-h-32" />
        <span>{language.toolAgentUserPrompt}</span>
        <TextAreaInput bind:value={execution.userPrompt} className="font-mono min-h-32" />
        <p class="text-xs text-textcolor2">{'{{tool_args}} · {{tool_arg::name}} · {{tool_last_user}} · {{tool_chat_history}} · {{tool_character}} · {{tool_state::chat}}'}</p>

        <div class="flex items-center"><strong>{language.toolAgentAllowedTools}</strong><button class="ml-auto hover:text-primary" onclick={addExternalTool} title={language.toolAgentAddExternal}><PlusIcon size={18}/></button></div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {#each DBState.db.tools ?? [] as tool}
                {#each tool.functions ?? [] as candidate}
                    {#if tool.id !== currentTool.id || candidate.id !== fn.id}
                        <CheckInput check={execution.allowedTools.some((ref) => ref.kind === 'managed' && ref.toolId === tool.id && ref.functionId === candidate.id)} name={`${tool.namespace}__${candidate.name}`} margin={false} onChange={(value) => addManagedTool(tool.id, candidate.id, value)} />
                    {/if}
                {/each}
            {/each}
        </div>
        {#each execution.allowedTools as ref, index}
            {#if ref.kind === 'external'}
                <div class="flex gap-2"><TextInput bind:value={ref.name} placeholder="external_tool_name"/><button class="text-textcolor2 hover:text-red-400" onclick={() => { execution.allowedTools.splice(index, 1); refresh() }}><TrashIcon size={18}/></button></div>
            {/if}
        {/each}

        <div class="flex items-center mt-2"><strong>{language.toolAgentOutputRoutes}</strong><button class="ml-auto hover:text-primary" onclick={addRoute}><PlusIcon size={18}/></button></div>
        <p class="text-xs text-textcolor2">{language.toolAgentRouteHint}</p>
        {#each execution.outputRoutes as route, routeIndex}
            <div class="border border-darkborderc rounded-md p-3 flex flex-col gap-2">
                <div class="flex gap-2"><TextInput bind:value={route.name} placeholder={language.name}/><select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={route.outcome}><option value="success">success</option><option value="error">error</option></select><button class="text-textcolor2 hover:text-red-400" onclick={() => { execution.outputRoutes.splice(routeIndex, 1); refresh() }}><TrashIcon size={18}/></button></div>
                <div class="grid grid-cols-[1fr_6rem] gap-2"><TextInput bind:value={route.pattern} placeholder="^(?<result>.*)$"/><TextInput bind:value={route.flags} placeholder="imsu"/></div>
                <span>{language.toolAgentModelResult}</span><TextAreaInput bind:value={route.modelTemplate} className="font-mono min-h-20" />
                <span>{language.toolAgentCardTemplate}</span><TextAreaInput bind:value={route.cardTemplate} className="font-mono min-h-20" />
                <p class="text-xs text-textcolor2">{'{{tool_capture::name}} · {{tool_result}} · {{tool_updates}} · {{tool_asset::filename}}'}</p>
                <div class="flex items-center"><strong>{language.toolAgentStateActions}</strong><button class="ml-auto hover:text-primary" onclick={() => addAction(routeIndex)}><PlusIcon size={18}/></button></div>
                {#each route.actions as action, actionIndex}
                    <div class="border-t border-darkborderc pt-2 flex flex-col gap-2">
                        <div class="flex gap-2"><select class="bg-darkbg border border-darkborderc rounded-md p-2 grow" value={action.kind} onchange={(event) => setActionKind(action, event.currentTarget.value as ToolAgentStateAction['kind'])}><option value="setVariable">setVariable</option><option value="appendList">appendList</option><option value="replaceList">replaceList</option><option value="upsertMemory">upsertMemory</option></select><button class="text-textcolor2 hover:text-red-400" onclick={() => { route.actions.splice(actionIndex, 1); refresh() }}><TrashIcon size={18}/></button></div>
                        {#if action.kind === 'upsertMemory'}
                            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={action.scope}><option value="global">global</option><option value="character">character</option><option value="chat">chat</option></select>
                            <TextInput bind:value={action.memoryIdTemplate} placeholder="memory id (optional)"/><TextInput bind:value={action.titleTemplate} placeholder="title template"/><TextAreaInput bind:value={action.contentTemplate} placeholder="content template"/><TextInput bind:value={action.tagsTemplate} placeholder='tags JSON, e.g. ["tag"]'/><TextInput bind:value={action.importanceTemplate} placeholder="importance 1-5"/>
                        {:else}
                            <TextInput bind:value={action.name} placeholder={action.kind === 'setVariable' ? 'variable name' : 'list name'}/><TextAreaInput bind:value={action.valueTemplate} placeholder="value template"/>
                        {/if}
                    </div>
                {/each}
            </div>
        {/each}
    {:else if fn.execution?.kind === 'script'}
        {@const execution = fn.execution}
        <div class="flex items-center"><strong>{language.toolAgentAllowedTools}</strong><button class="ml-auto hover:text-primary" onclick={addExternalTool} title={language.toolAgentAddExternal}><PlusIcon size={18}/></button></div>
        <p class="text-xs text-textcolor2">{language.toolAppAllowedToolsHint}</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {#each DBState.db.tools ?? [] as tool}
                {#each tool.functions ?? [] as candidate}
                    {#if tool.id !== currentTool.id || candidate.id !== fn.id}
                        <CheckInput check={(execution.allowedTools ?? []).some((ref) => ref.kind === 'managed' && ref.toolId === tool.id && ref.functionId === candidate.id)} name={`${tool.namespace}__${candidate.name}`} margin={false} onChange={(value) => addManagedTool(tool.id, candidate.id, value)} />
                    {/if}
                {/each}
            {/each}
        </div>
        {#each execution.allowedTools ?? [] as ref, index}
            {#if ref.kind === 'external'}
                <div class="flex gap-2"><TextInput bind:value={ref.name} placeholder="external_tool_name"/><button class="text-textcolor2 hover:text-red-400" onclick={() => { execution.allowedTools?.splice(index, 1); refresh() }}><TrashIcon size={18}/></button></div>
            {/if}
        {/each}
    {/if}

    <strong class="mt-2">{language.toolPresentation}</strong>
    <CheckInput bind:check={fn.presentation.showInChat} name={language.toolShowInChat} margin={false} />
    <p class="text-xs text-textcolor2">{language.toolShowInChatHint}</p>
    <CheckInput bind:check={fn.presentation.manualLaunch.enabled} name={language.toolManualLaunch} margin={false} />
    {#if fn.presentation.manualLaunch?.enabled}
        <TextInput bind:value={fn.presentation.manualLaunch.label} placeholder={language.toolManualLaunchLabel} />
        <CheckInput bind:check={fn.presentation.manualLaunch.includeInModelHistory} name={language.toolManualIncludeHistory} margin={false} />
    {/if}
    <TextAreaInput bind:value={fn.presentation.pendingTemplate} placeholder={language.toolPendingTemplate} />
    <TextAreaInput bind:value={fn.presentation.successTemplate} placeholder={language.toolSuccessTemplate} />
    <TextAreaInput bind:value={fn.presentation.errorTemplate} placeholder={language.toolErrorTemplate} />
</div>
