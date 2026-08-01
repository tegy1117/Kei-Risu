<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { toolWireName } from "src/ts/process/tools/tools";
    import type { ToolPolicyValue } from "src/ts/process/tools/types";

    const policies: ToolPolicyValue[] = ['inherit', 'on', 'off']
    const policyLabel = (policy: ToolPolicyValue) => policy === 'on'
        ? language.toolPolicyOn
        : policy === 'off' ? language.toolPolicyOff : language.toolPolicyInherit
</script>

<div class="flex items-center">
    <Check name={language.search} check={DBState.db.modelTools.includes('search')} onChange={() => {
        if (DBState.db.modelTools.includes('search')) {
            DBState.db.modelTools = DBState.db.modelTools.filter((tool) => tool !== 'search');
        } else {
            DBState.db.modelTools.push('search');
        }
    }} />
    <Help key="searchTool"/>
</div>

<div class="mt-4 flex flex-col gap-3">
    <strong>{language.toolPromptPolicy}</strong>
    {#each DBState.db.tools ?? [] as tool}
        <div class="border border-darkborderc rounded-md p-3 flex flex-col gap-2">
            <div class="flex items-center gap-2">
                <span class="font-medium grow">{tool.name}</span>
                <select class="bg-darkbg border border-darkborderc rounded-md px-2 py-1 text-sm" value={DBState.db.toolPolicy?.tools?.[tool.namespace] ?? 'inherit'} onchange={(e) => {
                    DBState.db.toolPolicy ??= { tools: {}, functions: {} }
                    DBState.db.toolPolicy.tools[tool.namespace] = e.currentTarget.value as ToolPolicyValue
                    DBState.db.toolPolicy = DBState.db.toolPolicy
                }}>
                    {#each policies as policy}<option value={policy}>{policyLabel(policy)}</option>{/each}
                </select>
            </div>
            <span class="text-xs text-textcolor2">{tool.namespace}</span>
            {#each tool.functions as fn}
                {@const wireName = toolWireName(tool.namespace, fn.name)}
                <div class="flex items-center gap-2 pl-3 border-l border-darkborderc">
                    <span class="grow text-sm">{fn.name}</span>
                    <select class="bg-darkbg border border-darkborderc rounded-md px-2 py-1 text-sm" value={DBState.db.toolPolicy?.functions?.[wireName] ?? 'inherit'} onchange={(e) => {
                        DBState.db.toolPolicy ??= { tools: {}, functions: {} }
                        DBState.db.toolPolicy.functions[wireName] = e.currentTarget.value as ToolPolicyValue
                        DBState.db.toolPolicy = DBState.db.toolPolicy
                    }}>
                        {#each policies as policy}<option value={policy}>{policyLabel(policy)}</option>{/each}
                    </select>
                </div>
            {/each}
        </div>
    {/each}
</div>
