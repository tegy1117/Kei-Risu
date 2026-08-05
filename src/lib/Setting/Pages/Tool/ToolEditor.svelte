<script lang="ts">
    import { PlusIcon, TrashIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type { RisuToolPackage, ToolPermission, ToolScope, ToolValueType } from 'src/ts/process/tools/types'
    import { v4 } from 'uuid'
    import ToolFunctionExecutionEditor from './ToolFunctionExecutionEditor.svelte'
    import ToolModuleEditor from './ToolModuleEditor.svelte'

    interface Props {
        currentTool: RisuToolPackage
        readonly?: boolean
    }

    let { currentTool = $bindable(), readonly = false }: Props = $props()
    let tab = $state(0)

    const valueTypes: ToolValueType[] = ['string', 'number', 'boolean', 'json']
    const parameterTypes = ['string', 'number', 'integer', 'boolean', 'json', 'string[]', 'number[]'] as const
    const scopes: ToolScope[] = ['global', 'character', 'chat']
    const permissions: Array<{ value: ToolPermission, label: string }> = [
        { value: 'askUser', label: language.toolPermissionAskUser },
        { value: 'network', label: language.toolPermissionNetwork },
        { value: 'database', label: language.toolPermissionDatabase },
        { value: 'interactiveUi', label: language.toolPermissionInteractiveUi },
        { value: 'invokeTools', label: language.toolPermissionInvokeTools },
        { value: 'character.read', label: language.toolPermissionCharacterRead },
        { value: 'character.write', label: language.toolPermissionCharacterWrite },
        { value: 'chat.read', label: language.toolPermissionChatRead },
        { value: 'chat.write', label: language.toolPermissionChatWrite },
        { value: 'lorebook.read', label: language.toolPermissionLorebookRead },
        { value: 'lorebook.write', label: language.toolPermissionLorebookWrite },
    ]

    function togglePermission(permission: ToolPermission) {
        currentTool.plugin.permissions = currentTool.plugin.permissions.includes(permission)
            ? currentTool.plugin.permissions.filter((item) => item !== permission)
            : [...currentTool.plugin.permissions, permission]
    }

    function addFunction() {
        currentTool.functions.push({ id: v4(), name: 'function_name', description: '', enabled: true, parameters: [], execution: { kind: 'script', allowedTools: [] }, presentation: { showInChat: true } })
        currentTool.functions = currentTool.functions
    }

    function removeFunction(functionIndex: number) {
        const functionId = currentTool.functions[functionIndex]?.id
        currentTool.functions.splice(functionIndex, 1)
        if (functionId) currentTool.functionRegex = (currentTool.functionRegex ?? []).filter((script) => script.functionId !== functionId)
        currentTool.functions = currentTool.functions
    }

    function addParameter(functionIndex: number) {
        currentTool.functions[functionIndex].parameters.push({ id: v4(), name: 'argument', description: '', type: 'string' })
        currentTool.functions = currentTool.functions
    }

    function addVariable() {
        currentTool.variables.push({ id: v4(), name: 'variable', description: '', type: 'string', scope: 'global', defaultValue: '' })
        currentTool.variables = currentTool.variables
    }

    function addList() {
        currentTool.lists.push({ id: v4(), name: 'list', description: '', itemType: 'string', scope: 'global', defaultItems: [] })
        currentTool.lists = currentTool.lists
    }

    function parseJson(value: string, fallback: unknown) {
        try { return JSON.parse(value) } catch { return fallback }
    }
</script>

<div class="flex border border-darkborderc rounded-md overflow-x-auto mb-4 shrink-0">
    {#each [language.basicInfo, language.toolFunctions, language.toolVariables, language.toolLists, language.toolModules, language.toolPlugin] as label, index}
        <button class="p-2 min-w-24 flex-1 border-r border-darkborderc last:border-r-0" class:bg-darkbutton={tab === index} onclick={() => { tab = index }}>
            {label}
        </button>
    {/each}
</div>

{#if tab === 0}
    <div class="flex flex-col gap-2">
        <span>{language.name}</span>
        {#if readonly}<div class="rounded-md border border-darkborderc p-2">{currentTool.name}</div>{:else}<TextInput bind:value={currentTool.name} />{/if}
        <span class="mt-2">{language.description}</span>
        {#if readonly}<div class="rounded-md border border-darkborderc p-2 min-h-12">{currentTool.description}</div>{:else}<TextAreaInput bind:value={currentTool.description} />{/if}
        <span class="mt-2">{language.toolNamespace}</span>
        {#if readonly}<div class="rounded-md border border-darkborderc p-2">{currentTool.namespace}</div>{:else}<TextInput bind:value={currentTool.namespace} />{/if}
        <span class="mt-2">{language.toolVersion}</span>
        {#if readonly}<div class="rounded-md border border-darkborderc p-2">{currentTool.version}</div>{:else}<TextInput bind:value={currentTool.version} />{/if}
        {#if readonly}<p class="text-sm text-textcolor2 mt-2">{language.toolReadonly}</p>{/if}
    </div>
{:else if tab === 1}
    <div class="flex flex-col gap-3">
        {#each currentTool.functions as fn, functionIndex}
            <div class="border border-darkborderc rounded-md p-3 flex flex-col gap-2">
                <div class="flex items-center gap-2">
                    <CheckInput bind:check={fn.enabled} name={language.toolEnabled} margin={false} />
                    {#if !readonly}
                        <button class="ml-auto text-textcolor2 hover:text-red-400" onclick={() => removeFunction(functionIndex)}><TrashIcon size={18}/></button>
                    {/if}
                </div>
                {#if readonly}
                    <strong>{currentTool.namespace}__{fn.name}</strong>
                    <span class="text-sm text-textcolor2">{fn.description}</span>
                {:else}
                    <TextInput bind:value={fn.name} placeholder="function_name" />
                    <TextAreaInput bind:value={fn.description} placeholder={language.description} />
                    <div class="flex items-center mt-1"><strong>{language.toolParameters}</strong><button class="ml-auto hover:text-primary" onclick={() => addParameter(functionIndex)}><PlusIcon size={18}/></button></div>
                    {#each fn.parameters as parameter, parameterIndex}
                        <div class="grid grid-cols-1 sm:grid-cols-[1fr_8rem_auto_auto] gap-2 items-center border-t border-darkborderc pt-2">
                            <TextInput bind:value={parameter.name} placeholder="argument" />
                            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={parameter.type}>
                                {#each parameterTypes as type}<option value={type}>{type}</option>{/each}
                            </select>
                            <CheckInput bind:check={parameter.required} name={language.toolRequired} margin={false} />
                            <button class="text-textcolor2 hover:text-red-400" onclick={() => { fn.parameters.splice(parameterIndex, 1); currentTool.functions = currentTool.functions }}><TrashIcon size={18}/></button>
                        </div>
                        <TextInput bind:value={parameter.description} placeholder={language.description} />
                    {/each}
                    <ToolFunctionExecutionEditor bind:currentTool fn={currentTool.functions[functionIndex]} />
                {/if}
            </div>
        {/each}
        {#if !readonly}<button class="border border-dashed border-darkborderc rounded-md p-3 hover:text-primary flex justify-center" onclick={addFunction}><PlusIcon size={20}/></button>{/if}
    </div>
{:else if tab === 2}
    <div class="flex flex-col gap-3">
        {#each currentTool.variables as variable, index}
            <div class="border border-darkborderc rounded-md p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {#if readonly}
                    <strong>{variable.name}</strong><span>{variable.description}</span><span>{variable.type}</span><span>{variable.scope}</span><code>{JSON.stringify(variable.defaultValue)}</code>
                {:else}
                    <TextInput bind:value={variable.name} placeholder="variable" />
                    <TextInput bind:value={variable.description} placeholder={language.description} />
                    <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={variable.type}>{#each valueTypes as type}<option value={type}>{type}</option>{/each}</select>
                    <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={variable.scope}>{#each scopes as scope}<option value={scope}>{scope}</option>{/each}</select>
                    <TextInput value={typeof variable.defaultValue === 'string' ? variable.defaultValue : JSON.stringify(variable.defaultValue)} oninput={(e) => { const value = e.currentTarget.value; variable.defaultValue = variable.type === 'number' ? Number(value) : variable.type === 'boolean' ? value === 'true' : variable.type === 'json' ? parseJson(value, variable.defaultValue) : value }} placeholder={language.toolDefaultValue} />
                    <button class="justify-self-end text-textcolor2 hover:text-red-400" onclick={() => { currentTool.variables.splice(index, 1); currentTool.variables = currentTool.variables }}><TrashIcon size={18}/></button>
                {/if}
            </div>
        {/each}
        {#if !readonly}<button class="border border-dashed border-darkborderc rounded-md p-3 hover:text-primary flex justify-center" onclick={addVariable}><PlusIcon size={20}/></button>{/if}
    </div>
{:else if tab === 3}
    <div class="flex flex-col gap-3">
        {#each currentTool.lists as list, index}
            <div class="border border-darkborderc rounded-md p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {#if readonly}
                    <strong>{list.name}</strong><span>{list.description}</span><span>{list.itemType}</span><span>{list.scope}</span><code>{JSON.stringify(list.defaultItems)}</code>
                {:else}
                    <TextInput bind:value={list.name} placeholder="list" />
                    <TextInput bind:value={list.description} placeholder={language.description} />
                    <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={list.itemType}>{#each valueTypes as type}<option value={type}>{type}</option>{/each}</select>
                    <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={list.scope}>{#each scopes as scope}<option value={scope}>{scope}</option>{/each}</select>
                    <textarea class="bg-transparent border border-darkborderc rounded-md p-2 min-h-24" value={JSON.stringify(list.defaultItems ?? [], null, 2)} oninput={(e) => { list.defaultItems = parseJson(e.currentTarget.value, list.defaultItems) as unknown[] }} placeholder={language.toolDefaultItems}></textarea>
                    <button class="justify-self-end text-textcolor2 hover:text-red-400" onclick={() => { currentTool.lists.splice(index, 1); currentTool.lists = currentTool.lists }}><TrashIcon size={18}/></button>
                {/if}
            </div>
        {/each}
        {#if !readonly}<button class="border border-dashed border-darkborderc rounded-md p-3 hover:text-primary flex justify-center" onclick={addList}><PlusIcon size={20}/></button>{/if}
    </div>
{:else if tab === 4}
    {#if readonly}
        <div class="flex flex-col gap-3"><strong>{language.toolCustomToggle}</strong><pre class="bg-darkbg border border-darkborderc rounded-md p-3 whitespace-pre-wrap">{currentTool.customToggle ?? ''}</pre><strong>{language.toolBackgroundEmbedding}</strong><pre class="bg-darkbg border border-darkborderc rounded-md p-3 whitespace-pre-wrap">{currentTool.backgroundEmbedding ?? ''}</pre><strong>{language.toolAssets}</strong>{#each currentTool.assets ?? [] as asset}<code>{asset[0]}</code>{/each}</div>
    {:else}
        <ToolModuleEditor bind:currentTool />
    {/if}
{:else}
    <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={currentTool.plugin.apiVersion} disabled={readonly}>
                <option value={1}>API v1</option><option value={2}>API v2 Tool App</option>
            </select>
            <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={currentTool.plugin.language} disabled={readonly}>
                <option value="javascript">JavaScript</option><option value="typescript">TypeScript</option>
            </select>
            <span class="text-sm text-textcolor2">risuai.registerFunction(name, handler)</span>
        </div>
        <strong class="mt-2">{language.toolPermissions}</strong>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {#each permissions as permission}
                {#if readonly}
                    <span class:text-textcolor2={!currentTool.plugin.permissions.includes(permission.value)}>{currentTool.plugin.permissions.includes(permission.value) ? '✓' : '–'} {permission.label}</span>
                {:else}
                    <CheckInput
                        check={currentTool.plugin.permissions.includes(permission.value)}
                        name={permission.label}
                        margin={false}
                        onChange={() => togglePermission(permission.value)}
                    />
                {/if}
            {/each}
        </div>
        <p class="text-sm text-textcolor2">{language.toolPermissionHint}</p>
        <p class="text-xs text-textcolor2 break-words">{language.toolPluginApi}</p>
        {#if readonly}<pre class="bg-darkbg border border-darkborderc rounded-md p-3 overflow-auto whitespace-pre-wrap text-sm">{currentTool.plugin.source}</pre>{:else}<TextAreaInput bind:value={currentTool.plugin.source} className="font-mono min-h-96" />{/if}
    </div>
{/if}
