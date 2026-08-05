<script lang="ts">
    import { CircleCheckIcon, PlayIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { openSettings, SettingsRoute } from 'src/ts/routing'
    import { callManualTool } from 'src/ts/process/tools/tools'
    import { notifyError } from 'src/ts/alert'
    import { DBState, ReloadGUIPointer, selectedCharID } from 'src/ts/stores.svelte'

    interface Props { close?: () => void }
    let { close = () => {} }: Props = $props()
    let search = $state('')

    function toggleCharacter(toolId: string) {
        const character = DBState.db.characters[$selectedCharID]
        character.tools ??= []
        character.tools = character.tools.includes(toolId) ? character.tools.filter((id) => id !== toolId) : [...character.tools, toolId]
        $ReloadGUIPointer += 1
    }

    async function run(toolId: string, functionId: string) {
        close()
        try { await callManualTool(toolId, functionId) }
        catch (error) { notifyError(error) }
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-full max-h-full overflow-y-auto text-textcolor">
        <div class="flex items-center"><h2 class="m-0 text-lg">{language.tools}</h2><button class="ml-auto text-textcolor2 hover:text-primary" onclick={close}><XIcon size={24}/></button></div>
        <span class="text-sm text-textcolor2">{language.chatToolsInfo}</span>
        <TextInput className="mt-4" placeholder={language.search} bind:value={search} />
        <div class="w-full mt-4 flex flex-col border border-selected rounded-md">
            {#each DBState.db.tools.filter((tool) => !search || `${tool.name} ${tool.namespace}`.toLowerCase().includes(search.toLowerCase())) as tool, index}
                {#if index > 0}<div class="border-t border-selected"></div>{/if}
                {@const character = DBState.db.characters[$selectedCharID]}
                {@const chat = character.chats[character.chatPage]}
                {@const active = DBState.db.enabledTools.includes(tool.id) || character.tools?.includes(tool.id) || chat.tools?.includes(tool.id)}
                <div class="p-3 flex items-center gap-2">
                    <div class="grow">
                        <div class:opacity-60={DBState.db.enabledTools.includes(tool.id)}>{tool.name}</div><div class="text-xs text-textcolor2">{tool.namespace}</div>
                        {#if active}
                            <div class="flex flex-wrap gap-2 mt-2">
                                {#each tool.functions.filter((fn) => fn.enabled && fn.presentation?.manualLaunch?.enabled) as fn}
                                    <button class="text-xs border border-darkborderc rounded-md px-2 py-1 hover:border-primary hover:text-primary flex items-center gap-1" onclick={() => run(tool.id, fn.id)}>
                                        <PlayIcon size={13}/>{fn.presentation?.manualLaunch?.label || fn.name}
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    </div>
                    {#if DBState.db.enabledTools.includes(tool.id)}
                        <CircleCheckIcon size={18} class="text-textcolor2" />
                    {:else}
                        <button class={chat.tools?.includes(tool.id) ? 'text-blue-500' : character.tools?.includes(tool.id) ? 'text-violet-500' : 'text-textcolor2 hover:text-blue-400'} onclick={() => { chat.tools ??= []; chat.tools = chat.tools.includes(tool.id) ? chat.tools.filter((id) => id !== tool.id) : [...chat.tools, tool.id]; $ReloadGUIPointer += 1 }} oncontextmenu={(e) => { e.preventDefault(); toggleCharacter(tool.id) }}>
                            <CircleCheckIcon size={18}/>
                        </button>
                    {/if}
                </div>
            {/each}
        </div>
        <Button className="mt-4" size="sm" onclick={() => { openSettings(SettingsRoute.Tool); close() }}>{language.edit}</Button>
    </div>
</div>
<style>.break-any{overflow-wrap:anywhere}</style>
