<script lang="ts">
    import { PinIcon, SaveIcon, SettingsIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { notifySuccess } from "src/ts/alert";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";

    const currentChat = $derived(
        DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]
    );
    const boundId = $derived(currentChat?.boundAgentPresetId ?? '');
    const isDangling = $derived(Boolean(boundId) && !DBState.db.agentPresets.some((preset) => preset.id === boundId));

    function bindAgentPreset(value: string) {
        if (!currentChat) return;
        currentChat.boundAgentPresetId = value || undefined;
    }

    function setDefault() {
        DBState.db.defaultAgentPresetId = boundId || undefined;
        notifySuccess(language.agent.defaultSaved);
    }
</script>

<div class="flex flex-col gap-1 mt-4">
    <div class="text-[11px] text-textcolor2 px-1">{language.agent.binding}</div>
    <div class="flex gap-1 items-stretch">
        <div class="flex-1 min-w-0">
            <SelectInput value={boundId} onchange={(event) => bindAgentPreset(event.currentTarget.value)}>
                <option value="">{language.none}</option>
                {#each DBState.db.agentPresets as preset (preset.id)}
                    <option value={preset.id}>{preset.name}</option>
                {/each}
                {#if isDangling}<option value={boundId}>{language.agent.unbound}</option>{/if}
            </SelectInput>
        </div>
        <ShButton size="icon" className="shrink-0" onclick={setDefault} title={language.agent.setDefault}>
            {#if DBState.db.defaultAgentPresetId === boundId && boundId}<PinIcon size={16}/>{:else}<SaveIcon size={16}/>{/if}
        </ShButton>
        <ShButton size="icon" className="shrink-0" onclick={() => openSettings(SettingsRoute.AgentPreset)} title={language.agent.menu}>
            <SettingsIcon size={16}/>
        </ShButton>
    </div>
    {#if isDangling}<div class="text-xs text-draculared px-1">{language.agent.unbound}</div>{/if}
</div>
