<script lang="ts">
    import { CopyIcon, DownloadIcon, GlobeIcon, HardDriveUploadIcon, PlusIcon, SquarePenIcon, TrashIcon, WrenchIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertConfirm, alertSelect, notifyError, notifySuccess } from 'src/ts/alert'
    import { safeStructuredClone } from 'src/ts/polyfill'
    import { exportTool, importTool, unloadToolRuntime, validateToolPackage } from 'src/ts/process/tools/tools'
    import type { RisuToolPackage } from 'src/ts/process/tools/types'
    import { DBState } from 'src/ts/stores.svelte'
    import { v4 } from 'uuid'
    import ToolEditor from './ToolEditor.svelte'

    let mode = $state<'list' | 'create' | 'edit'>('list')
    let search = $state('')
    let editIndex = $state(-1)
    let currentTool = $state<RisuToolPackage>(blankTool())

    function blankTool(): RisuToolPackage {
        return { id: v4(), name: '', description: '', namespace: '', version: '1.0.0', functions: [], variables: [], lists: [], plugin: { language: 'javascript', source: '', permissions: [] } }
    }

    function uniqueNamespace(base: string) {
        let value = `${base || 'tool'}-copy`
        let n = 2
        while (DBState.db.tools.some((tool) => tool.namespace === value)) value = `${base || 'tool'}-copy-${n++}`
        return value
    }

    function openEdit(tool: RisuToolPackage) {
        editIndex = DBState.db.tools.findIndex((item) => item.id === tool.id)
        currentTool = safeStructuredClone(tool)
        mode = 'edit'
    }

    function cloneTool(tool: RisuToolPackage) {
        const copy = safeStructuredClone(tool)
        copy.id = v4(); copy.name = `${tool.name} Copy`; copy.namespace = uniqueNamespace(tool.namespace); copy.builtinId = undefined; copy.readonly = false
        DBState.db.tools.push(copy)
        notifySuccess(language.toolCreated)
    }

    function saveTool() {
        const errors = validateToolPackage(currentTool, DBState.db.tools)
        if (errors.length) { notifyError(errors.join('\n')); return }
        if (mode === 'create') DBState.db.tools.push(currentTool)
        else {
            const previous = DBState.db.tools[editIndex]
            unloadToolRuntime(currentTool.id)
            if (previous.plugin.source !== currentTool.plugin.source) delete DBState.db.toolPermissions[currentTool.id]
            const currentFunctionNames = new Set(currentTool.functions.map((fn) => fn.name))
            if (previous.namespace !== currentTool.namespace) {
                const policy = DBState.db.toolPolicy
                if (policy.tools[previous.namespace] !== undefined) {
                    policy.tools[currentTool.namespace] = policy.tools[previous.namespace]
                    delete policy.tools[previous.namespace]
                }
                for (const fn of previous.functions) {
                    const oldName = `${previous.namespace}__${fn.name}`
                    const newName = `${currentTool.namespace}__${fn.name}`
                    if (currentFunctionNames.has(fn.name) && policy.functions[oldName] !== undefined) policy.functions[newName] = policy.functions[oldName]
                    delete policy.functions[oldName]
                }
            } else {
                for (const fn of previous.functions) {
                    if (!currentFunctionNames.has(fn.name)) delete DBState.db.toolPolicy.functions[`${previous.namespace}__${fn.name}`]
                }
            }
            DBState.db.tools[editIndex] = currentTool
            DBState.db.tools = DBState.db.tools
        }
        notifySuccess(mode === 'create' ? language.toolCreated : language.toolUpdated)
        mode = 'list'
    }

    async function download(tool: RisuToolPackage) {
        const selected = Number(await alertSelect([language.toolExport, language.toolExportWithData, language.cancel]))
        if (selected === 0) await exportTool(tool, false)
        if (selected === 1) await exportTool(tool, true)
    }
</script>

{#if mode === 'list'}
    <SettingPage title={language.tools}>
        <div class="mt-4 flex gap-2 items-center">
            <TextInput className="grow" placeholder={language.search} bind:value={search} />
            <button class="text-textcolor2 hover:text-primary" title={language.createTool} onclick={() => { currentTool = blankTool(); mode = 'create' }}><PlusIcon /></button>
            <button class="text-textcolor2 hover:text-primary" title={language.toolImport} onclick={importTool}><HardDriveUploadIcon /></button>
        </div>
        <div class="w-full mt-4 flex flex-col border border-selected rounded-md overflow-hidden">
            {#if DBState.db.tools.length === 0}<div class="text-textcolor2 p-3">{language.noTools}</div>{/if}
            {#each DBState.db.tools.filter((tool) => !search || `${tool.name} ${tool.namespace}`.toLowerCase().includes(search.toLowerCase())) as tool, index}
                {#if index > 0}<div class="border-t border-selected"></div>{/if}
                <div class="p-3 flex flex-wrap gap-2 items-start">
                    <WrenchIcon size={18} class="mt-1 shrink-0" />
                    <div class="min-w-0 grow basis-[calc(100%-1.75rem)]"><div class="font-bold truncate">{tool.name}</div><div class="text-sm text-textcolor2 break-words">{tool.namespace} · {tool.description}</div></div>
                    <div class="ml-auto flex items-center gap-3 pl-7">
                        <button class={DBState.db.enabledTools.includes(tool.id) ? 'text-blue-500' : 'text-textcolor2 hover:text-primary'} title={language.enableGlobal} onclick={() => { DBState.db.enabledTools = DBState.db.enabledTools.includes(tool.id) ? DBState.db.enabledTools.filter((id) => id !== tool.id) : [...DBState.db.enabledTools, tool.id] }}><GlobeIcon size={18}/></button>
                        <button class="text-textcolor2 hover:text-primary" title={language.toolExport} onclick={() => download(tool)}><DownloadIcon size={18}/></button>
                        <button class="text-textcolor2 hover:text-primary" title={language.toolClone} onclick={() => cloneTool(tool)}><CopyIcon size={18}/></button>
                        <button class="text-textcolor2 hover:text-primary" title={language.editTool} onclick={() => openEdit(tool)}><SquarePenIcon size={18}/></button>
                        {#if !tool.readonly}<button class="text-textcolor2 hover:text-red-400" title={language.remove} onclick={async () => { if (await alertConfirm(language.removeConfirm + tool.name)) { unloadToolRuntime(tool.id); DBState.db.enabledTools = DBState.db.enabledTools.filter((id) => id !== tool.id); DBState.db.tools = DBState.db.tools.filter((item) => item.id !== tool.id); delete DBState.db.toolStates[tool.id]; delete DBState.db.toolPermissions[tool.id]; delete DBState.db.toolPolicy.tools[tool.namespace]; for (const fn of tool.functions) delete DBState.db.toolPolicy.functions[`${tool.namespace}__${fn.name}`]; notifySuccess(language.toolDeleted) } }}><TrashIcon size={18}/></button>{/if}
                    </div>
                </div>
            {/each}
        </div>
    </SettingPage>
{:else}
    <SettingPage title={mode === 'create' ? language.createTool : language.editTool}>
        <ToolEditor bind:currentTool readonly={currentTool.readonly === true} />
        <div class="flex gap-2 mt-6">
            <ShButton variant="outline" onclick={() => { mode = 'list' }}>{language.cancel}</ShButton>
            <ShButton onclick={saveTool}>{language.confirm}</ShButton>
        </div>
    </SettingPage>
{/if}
