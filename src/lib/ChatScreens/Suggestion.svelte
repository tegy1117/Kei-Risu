<script lang="ts">
	import { requestChatData } from "src/ts/process/request/request";
    import { type OpenAIChat } from "../../ts/process/index.svelte";
    import { generationStates } from "../../ts/process/generationState";
    import { createChatExecutionContext, withExecutionContext } from "../../ts/process/executionContext.svelte";
    import { type character } from "../../ts/storage/database.svelte";
	import { DBState } from 'src/ts/stores.svelte';
    import { selectedCharID } from "../../ts/stores.svelte";
    import { translate } from "src/ts/translator/translator";
    import { CopyIcon, LanguagesIcon, RefreshCcwIcon } from "@lucide/svelte";
    import { alertConfirm } from "src/ts/alert";
    import { language } from "src/lang";
    import { getUserName, replacePlaceholders } from "../../ts/util";
    import { onDestroy, untrack } from 'svelte';
    import { ParseMarkdown } from "src/ts/parser/parser.svelte";
    import {defaultAutoSuggestPrompt} from "../../ts/storage/defaultPrompts.js";

    interface Props {
        send: () => any;
        messageInput: (string:string) => any;
    }

    let { send, messageInput }: Props = $props();
    let suggestMessages:string[] = $state(DBState.db.characters[$selectedCharID]?.chats[DBState.db.characters[$selectedCharID].chatPage]?.suggestMessages)
    let suggestMessagesTranslated:string[] = $state()
    let toggleTranslate:boolean = $state(DBState.db.autoTranslate)
    let progress:boolean = $state();
    let abortController:AbortController;
    let attemptedKey = '';
    let translationRun = 0;
    const currentChat = $derived(DBState.db.characters[$selectedCharID]?.chats[DBState.db.characters[$selectedCharID]?.chatPage]);
    const currentGenerating = $derived($generationStates.has(currentChat?.id));

    async function generateSuggestions(force = false) {
        const context = createChatExecutionContext();
        const target = context?.resolve();
        if (!target || currentGenerating) return;
        const { character: currentChar, chat } = target;
        const lastMessages = chat.message.slice(-10);
        if (!lastMessages.length) return;
        const key = `${chat.id}:${chat.message.length}:${lastMessages.at(-1)?.data}`;
        if (!force && (chat.suggestMessages?.length || attemptedKey === key)) return;
        attemptedKey = key;
        abortController?.abort();
        const controller = new AbortController();
        abortController = controller;
        progress = true;
        const db = context.db;
        const prompt = db.autoSuggestPrompt || defaultAutoSuggestPrompt;
        let promptbody:OpenAIChat[] = [
            { role: 'system', content: replacePlaceholders(prompt, currentChar.name) },
            { role: 'user', content: lastMessages.map(b => (b.role === 'char' ? currentChar.name : getUserName()) + ':' + b.data).join(',') },
        ];
        if (db.subModel === 'textgen_webui' || db.subModel === 'mancer' || db.subModel.startsWith('local_')) {
            promptbody = [
                { role: 'system', content: replacePlaceholders(prompt, currentChar.name) },
                ...lastMessages.map(({ role, data }) => ({ role: role === 'user' ? 'user' as const : 'assistant' as const, content: data })),
            ];
        }
        try {
            const response = await withExecutionContext(context, () => requestChatData({
                formated: promptbody, bias: {}, currentChar: currentChar as character, executionContext: context,
            }, 'submodel', controller.signal));
            if (controller.signal.aborted || !context.resolve()) return;
            if (response.type === 'success') {
                const messages = response.result.split('\n').filter(msg => msg.startsWith('-')).map(msg => msg.slice(1).trim());
                context.resolve().chat.suggestMessages = messages;
                if (currentChat?.id === context.chatId) suggestMessages = messages;
            }
        } finally {
            if (abortController === controller) progress = false;
        }
    }

    $effect(() => {
        const chat = currentChat;
        const generating = currentGenerating;
        const messageCount = chat?.message.length;
        untrack(() => {
            abortController?.abort();
            progress = false;
            suggestMessages = generating ? [] : chat?.suggestMessages;
            if (!generating && messageCount) void generateSuggestions().catch(() => {});
        });
    });

    const translateSuggest = async (toggle:boolean, messages:string[]) => {
        const run = ++translationRun;
        if (!toggle || !messages?.length) return;
        const context = createChatExecutionContext();
        const translated:string[] = [];
        for (const message of messages) {
            translated.push(await withExecutionContext(context, () => translate(message, false)));
            if (run !== translationRun) return;
        }
        suggestMessagesTranslated = translated;
    };
    onDestroy(() => { abortController?.abort(); translationRun++; });
    $effect(() => { void translateSuggest(toggleTranslate, suggestMessages); });
</script>

<div class="ml-4 flex flex-wrap">
    {#if progress}
        <div class="flex bg-textcolor2 p-2 rounded-lg items-center">
            <div class="loadmove mx-2"></div>
            <div>{language.creatingSuggestions}</div>
        </div>        
    {:else if !currentGenerating}
        {#if DBState.db.translator !== ''}
            <div class="flex mr-2 mb-2">
                <button class={"bg-textcolor2 hover:bg-darkbutton font-bold py-2 px-4 rounded-sm " + (toggleTranslate ? 'text-green-500' : 'text-textcolor')}
                    onclick={() => {
                        toggleTranslate = !toggleTranslate
                    }}
                >
                    <LanguagesIcon/>
                </button>
            </div>    
        {/if}
        

        <div class="flex mr-2 mb-2">
            <button class="bg-textcolor2 hover:bg-darkbutton font-bold py-2 px-4 rounded-sm text-textcolor"
                onclick={() => {
                    alertConfirm(language.askReRollAutoSuggestions).then((result) => {
                        if(result) {
                            suggestMessages = []
                            void generateSuggestions(true).catch(() => {})
                        }
                    })
                }}
            >
                <RefreshCcwIcon/>
            </button>
        </div>
        {#each suggestMessages??[] as suggest, i}
            <div class="flex mr-2 mb-2">
                <button class="bg-textcolor2 hover:bg-darkbutton text-textcolor font-bold py-2 px-4 rounded-sm" onclick={() => {
                    suggestMessages = []
                    messageInput(suggest)
                    send()
                }}>
                {#await ParseMarkdown((DBState.db.translator !== '' && toggleTranslate && suggestMessagesTranslated && suggestMessagesTranslated.length > 0) ? suggestMessagesTranslated[i]??suggest : suggest) then md}
                    {@html md}
                {/await}
                </button>
                <button class="bg-textcolor2 hover:bg-darkbutton text-textcolor font-bold py-2 px-4 rounded-sm ml-1" onclick={() => {
                    messageInput(suggest)
                }}>
                    <CopyIcon/>
                </button>
            </div>
        {/each}
        
    {/if}
</div>

<style>
    
    .loadmove {
        animation: spin 1s linear infinite;
        border-radius: 50%;
        border: 0.4rem solid rgba(0,0,0,0);
        width: 1rem;
        height: 1rem;
        border-top: 0.4rem solid var(--risu-theme-textcolor);
        border-left: 0.4rem solid var(--risu-theme-textcolor);
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
</style>

