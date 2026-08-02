<script lang="ts">
    import { v4 } from 'uuid'
    import { ArrowDownIcon, ArrowUpIcon, CopyIcon, PlusIcon, Trash2Icon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { DBState } from 'src/ts/stores.svelte'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShSelect from 'src/lib/UI/GUI/ShSelect.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import type { AgentPipelineNode, AgentPostPlacement, AgentPreset, AgentWorkerNode } from 'src/ts/agent/types'
    import { createAgentPreset, validateAgentPreset } from 'src/ts/agent/pipeline'

    let editingId = $state(DBState.db.agentPresets?.[0]?.id ?? '')
    let mappingPromptId = $state(DBState.db.botPresets?.[DBState.db.botPresetsId]?.id ?? '')
    let draggedNodeId = $state('')

    let preset = $derived(DBState.db.agentPresets.find((entry) => entry.id === editingId) ?? null)
    let validation = $derived(preset ? validateAgentPreset(preset, {
        promptPresetIds: new Set(DBState.db.botPresets.map((entry) => entry.id).filter(Boolean)),
        modelPresetIds: new Set(DBState.db.modelPresets.map((entry) => entry.id)),
    }) : null)

    function addPreset(){
        const created = createAgentPreset(language.agent.newPreset)
        DBState.db.agentPresets.push(created)
        editingId = created.id
    }

    function duplicatePreset(source: AgentPreset){
        const idMap = new Map<string, string>()
        for(const stage of source.stages){
            for(const node of stage.nodes) idMap.set(node.id, v4())
        }
        const copy: AgentPreset = {
            ...structuredClone($state.snapshot(source)),
            id: v4(),
            name: `${source.name} Copy`,
            stages: source.stages.map((stage) => ({
                id: v4(),
                nodes: stage.nodes.map((node) => ({
                    ...structuredClone($state.snapshot(node)),
                    id: idMap.get(node.id)!,
                    agentInfoBindings: Object.fromEntries(Object.entries(node.agentInfoBindings ?? {}).map(([promptId, cards]) => [
                        promptId,
                        Object.fromEntries(Object.entries(cards).map(([cardId, sources]) => [cardId, sources.map((id) => idMap.get(id) ?? id)])),
                    ])),
                })),
            })),
        }
        DBState.db.agentPresets.push(copy)
        editingId = copy.id
    }

    function removePreset(id: string){
        const index = DBState.db.agentPresets.findIndex((entry) => entry.id === id)
        if(index < 0) return
        DBState.db.agentPresets.splice(index, 1)
        editingId = DBState.db.agentPresets[Math.max(0, index - 1)]?.id ?? ''
    }

    function addStage(){
        if(!preset) return
        preset.stages.push({ id: v4(), nodes: [] })
    }

    function addAgent(stageIndex: number){
        if(!preset || preset.stages[stageIndex].nodes.some((node) => node.kind === 'main')) return
        const node: AgentWorkerNode = {
            kind: 'agent',
            id: v4(),
            name: `Agent ${preset.stages.flatMap((stage) => stage.nodes).filter((entry) => entry.kind === 'agent').length + 1}`,
            promptPresetId: DBState.db.botPresets[0]?.id ?? '',
            modelPresetId: DBState.db.modelPresets[0]?.id ?? '',
            usePromptPresetParams: false,
            agentInfoBindings: {},
            post: { placement: 'append', includeInHistory: true },
        }
        preset.stages[stageIndex].nodes.push(node)
    }

    function removeNode(stageIndex: number, nodeIndex: number){
        if(!preset || preset.stages[stageIndex].nodes[nodeIndex]?.kind === 'main') return
        preset.stages[stageIndex].nodes.splice(nodeIndex, 1)
    }

    function moveNode(stageIndex: number, nodeIndex: number, direction: -1|1){
        if(!preset) return
        const nodes = preset.stages[stageIndex].nodes
        const target = nodeIndex + direction
        if(target < 0 || target >= nodes.length || nodes[nodeIndex]?.kind === 'main') return
        const [node] = nodes.splice(nodeIndex, 1)
        nodes.splice(target, 0, node)
    }

    function moveStage(index: number, direction: -1|1){
        if(!preset) return
        const target = index + direction
        if(target < 0 || target >= preset.stages.length) return
        const [stage] = preset.stages.splice(index, 1)
        preset.stages.splice(target, 0, stage)
    }

    function deleteStage(index: number){
        if(!preset || preset.stages[index].nodes.some((node) => node.kind === 'main')) return
        preset.stages.splice(index, 1)
    }

    function findNode(nodeId: string): { stageIndex: number, nodeIndex: number } | null {
        if(!preset) return null
        for(let stageIndex = 0; stageIndex < preset.stages.length; stageIndex++){
            const nodeIndex = preset.stages[stageIndex].nodes.findIndex((node) => node.id === nodeId)
            if(nodeIndex >= 0) return { stageIndex, nodeIndex }
        }
        return null
    }

    function dropNode(targetStageIndex: number){
        if(!preset || !draggedNodeId) return
        const found = findNode(draggedNodeId)
        const targetStage = preset.stages[targetStageIndex]
        if(!found || targetStage.nodes.some((node) => node.kind === 'main')) return
        const node = preset.stages[found.stageIndex].nodes[found.nodeIndex]
        if(node.kind === 'main') return
        preset.stages[found.stageIndex].nodes.splice(found.nodeIndex, 1)
        targetStage.nodes.push(node)
        draggedNodeId = ''
    }

    function earlierNodes(node: AgentPipelineNode): AgentPipelineNode[] {
        if(!preset) return []
        const found = findNode(node.id)
        if(!found) return []
        return preset.stages.slice(0, found.stageIndex).flatMap((stage) => stage.nodes)
    }

    function promptIdFor(node: AgentPipelineNode): string {
        return node.kind === 'main' ? mappingPromptId : node.promptPresetId
    }

    function infoCards(node: AgentPipelineNode){
        const promptId = promptIdFor(node)
        return DBState.db.botPresets.find((entry) => entry.id === promptId)?.promptTemplate?.filter((item) => item.type === 'agentInfo') ?? []
    }

    function isBound(node: AgentPipelineNode, cardId: string, sourceId: string): boolean {
        return node.agentInfoBindings?.[promptIdFor(node)]?.[cardId]?.includes(sourceId) ?? false
    }

    function toggleBinding(node: AgentPipelineNode, cardId: string, sourceId: string, checked: boolean){
        const promptId = promptIdFor(node)
        node.agentInfoBindings ??= {}
        node.agentInfoBindings[promptId] ??= {}
        const current = node.agentInfoBindings[promptId][cardId] ?? []
        node.agentInfoBindings[promptId][cardId] = checked
            ? [...new Set([...current, sourceId])]
            : current.filter((id) => id !== sourceId)
    }

    function setPostPlacement(node: AgentWorkerNode, placement: AgentPostPlacement){
        node.post.placement = placement
        if(placement === 'none') node.post.includeInHistory = false
    }
</script>

<SettingPage title={language.agent.menu}>
    <div class="flex gap-2 items-center mt-2">
        <ShSelect className="flex-1" bind:value={editingId}>
            <OptionInput value="">{language.none}</OptionInput>
            {#each DBState.db.agentPresets as entry (entry.id)}
                <OptionInput value={entry.id}>{entry.name}</OptionInput>
            {/each}
        </ShSelect>
        <ShButton size="icon" onclick={addPreset} title={language.agent.newPreset}><PlusIcon size={18}/></ShButton>
        {#if preset}
            <ShButton size="icon" onclick={() => duplicatePreset(preset!)} title={language.agent.duplicate}><CopyIcon size={18}/></ShButton>
            <ShButton size="icon" variant="destructive" onclick={() => removePreset(preset!.id)} title={language.agent.delete}><Trash2Icon size={18}/></ShButton>
        {/if}
    </div>

    {#if preset}
        <div class="mt-5 text-sm text-textcolor2">{language.name}</div>
        <ShInput bind:value={preset.name}/>
        <div class="mt-4 text-sm text-textcolor2">{language.agent.maxParallel}</div>
        <input class="bg-darkbg border border-darkborderc rounded-md p-2" type="number" min="1" max="16" bind:value={preset.maxParallel}/>

        {#if validation?.errors.length}
            <div class="mt-4 border border-draculared text-draculared rounded-md p-3 text-sm">
                {#each validation.errors as error}<div>{error}</div>{/each}
            </div>
        {/if}

        <div class="mt-5 flex flex-col gap-3">
            {#each preset.stages as stage, stageIndex (stage.id)}
                <section
                    role="group"
                    class="border border-darkborderc rounded-lg p-3 bg-darkbg"
                    ondragover={(event) => event.preventDefault()}
                    ondrop={() => dropNode(stageIndex)}
                >
                    <header class="flex items-center gap-2 mb-3">
                        <strong class="flex-1">{language.agent.stage} {stageIndex + 1}</strong>
                        <button onclick={() => moveStage(stageIndex, -1)} disabled={stageIndex === 0}><ArrowUpIcon size={17}/></button>
                        <button onclick={() => moveStage(stageIndex, 1)} disabled={stageIndex === preset!.stages.length - 1}><ArrowDownIcon size={17}/></button>
                        {#if !stage.nodes.some((node) => node.kind === 'main')}
                            <button class="text-draculared" onclick={() => deleteStage(stageIndex)}><Trash2Icon size={17}/></button>
                        {/if}
                    </header>

                    {#each stage.nodes as node, nodeIndex (node.id)}
                        <div
                            role="listitem"
                            class="border border-selected rounded-md p-3 mb-2 flex flex-col gap-2"
                            draggable={node.kind === 'agent'}
                            ondragstart={() => { draggedNodeId = node.id }}
                        >
                            <div class="flex gap-2 items-center">
                                <span class="text-xs rounded bg-selected px-2 py-1">{node.kind === 'main' ? language.agent.mainOutput : 'Agent'}</span>
                                <ShInput className="flex-1" bind:value={node.name}/>
                                {#if node.kind === 'agent'}
                                    <button onclick={() => moveNode(stageIndex, nodeIndex, -1)} disabled={nodeIndex === 0}><ArrowUpIcon size={17}/></button>
                                    <button onclick={() => moveNode(stageIndex, nodeIndex, 1)} disabled={nodeIndex === stage.nodes.length - 1}><ArrowDownIcon size={17}/></button>
                                    <button class="text-draculared" onclick={() => removeNode(stageIndex, nodeIndex)}><Trash2Icon size={17}/></button>
                                {/if}
                            </div>

                            {#if node.kind === 'agent'}
                                <div class="text-xs text-textcolor2">{language.agent.promptPreset}</div>
                                <ShSelect bind:value={node.promptPresetId}>
                                    <OptionInput value="">{language.none}</OptionInput>
                                    {#each DBState.db.botPresets as prompt (prompt.id)}<OptionInput value={prompt.id}>{prompt.name}</OptionInput>{/each}
                                </ShSelect>
                                <div class="text-xs text-textcolor2">{language.agent.modelPreset}</div>
                                <ShSelect bind:value={node.modelPresetId}>
                                    <OptionInput value="">{language.none}</OptionInput>
                                    {#each DBState.db.modelPresets as model (model.id)}<OptionInput value={model.id}>{model.name}</OptionInput>{/each}
                                </ShSelect>
                                <label class="flex gap-2 items-center text-sm"><input type="checkbox" bind:checked={node.usePromptPresetParams}/>{language.agent.promptParams}</label>
                                {#if validation && stageIndex > validation.mainStageIndex}
                                    <div class="text-xs text-textcolor2">{language.agent.postPlacement}</div>
                                    <ShSelect value={node.post.placement} onchange={(event) => setPostPlacement(node, event.currentTarget.value as AgentPostPlacement)}>
                                        <OptionInput value="prepend">{language.agent.prepend}</OptionInput>
                                        <OptionInput value="append">{language.agent.append}</OptionInput>
                                        <OptionInput value="replace">{language.agent.replace}</OptionInput>
                                        <OptionInput value="none">{language.agent.noEffect}</OptionInput>
                                    </ShSelect>
                                    {#if node.post.placement !== 'none'}
                                        <label class="flex gap-2 items-center text-sm"><input type="checkbox" bind:checked={node.post.includeInHistory}/>{language.agent.includeHistory}</label>
                                    {/if}
                                {/if}
                            {:else}
                                <div class="text-xs text-textcolor2">{language.agent.mappingPrompt}</div>
                                <ShSelect bind:value={mappingPromptId}>
                                    {#each DBState.db.botPresets as prompt (prompt.id)}<OptionInput value={prompt.id}>{prompt.name}</OptionInput>{/each}
                                </ShSelect>
                            {/if}

                            <div class="mt-2 border-t border-darkborderc pt-2">
                                <div class="text-xs text-textcolor2 mb-2">{language.agent.sourceOutputs}</div>
                                {#if infoCards(node).length === 0}
                                    <div class="text-xs text-textcolor2">{language.agent.noInfoCards}</div>
                                {/if}
                                {#each infoCards(node) as card (card.id)}
                                    {@const sources = earlierNodes(node)}
                                    <div class="rounded border border-darkborderc p-2 mb-2">
                                        <div class="text-sm mb-1">{language.agent.insertionPoint}: {card.name || language.agentInfo}</div>
                                        {#if sources.length === 0}
                                            <div class="text-xs text-textcolor2">{language.agent.noEarlierOutputs}</div>
                                        {:else}
                                            {#each sources as source (source.id)}
                                                <label class="flex gap-2 items-center text-xs py-1">
                                                    <input type="checkbox" checked={isBound(node, card.id, source.id)} onchange={(event) => toggleBinding(node, card.id, source.id, event.currentTarget.checked)}/>
                                                    {source.name}
                                                </label>
                                            {/each}
                                        {/if}
                                    </div>
                                {/each}
                            </div>
                        </div>
                    {/each}

                    {#if !stage.nodes.some((node) => node.kind === 'main')}
                        <ShButton size="sm" onclick={() => addAgent(stageIndex)}><PlusIcon size={16}/>{language.agent.addAgent}</ShButton>
                    {/if}
                </section>
            {/each}
        </div>
        <ShButton className="mt-3" onclick={addStage}><PlusIcon size={16}/>{language.agent.addStage}</ShButton>
    {:else}
        <ShButton className="mt-5" onclick={addPreset}><PlusIcon size={16}/>{language.agent.newPreset}</ShButton>
    {/if}
</SettingPage>
