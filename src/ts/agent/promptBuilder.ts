import type { OpenAIChat } from '../process/index.svelte'
import { parseChatML } from '../parser/chatML'
import { risuChatParser } from '../parser/parser.svelte'
import { loadLoreBookV3Prompt } from '../process/lorebook.svelte'
import type { AgentPipelineNode } from './types'
import type { PromptItem, PromptRole } from '../process/prompt'
import type { botPreset, character, Chat, customscript } from '../storage/database.svelte'
import { getPersonaPrompt } from '../util'

export interface AgentOutputValue {
    nodeId: string
    nodeName: string
    output: string
}

export interface BuildAgentPromptInput {
    node: AgentPipelineNode
    promptPreset: botPreset
    character: character
    chat: Chat
    outputs: Map<string, AgentOutputValue>
    outputOrder?: Map<string, number>
}

export interface BuildAgentPromptResult {
    messages: OpenAIChat[]
    warnings: string[]
}

const roleMap: Record<PromptRole, OpenAIChat['role']> = {
    user: 'user',
    bot: 'assistant',
    system: 'system',
}

function wrap(content: string, innerFormat?: string): string {
    if(!innerFormat) return content
    return innerFormat.replaceAll('{{slot}}', content)
}

function sliceChats(messages: OpenAIChat[], item: Extract<PromptItem, { type: 'chat' }>): OpenAIChat[] {
    let start = item.rangeStart === -1000 ? 0 : item.rangeStart
    let end = item.rangeEnd === 'end' ? messages.length : item.rangeEnd
    if(start < 0) start = Math.max(0, messages.length + start)
    if(end < 0) end = Math.max(0, messages.length + end)
    return start < end ? messages.slice(start, end) : []
}

function push(messages: OpenAIChat[], value: OpenAIChat | OpenAIChat[]) {
    const values = Array.isArray(value) ? value : [value]
    for(const message of values){
        if(message.content.trim() || message.multimodals?.length) messages.push(message)
    }
}

export async function buildAgentPrompt(input: BuildAgentPromptInput): Promise<BuildAgentPromptResult> {
    const { node, promptPreset, character, chat, outputs, outputOrder } = input
    const warnings: string[] = []
    const result: OpenAIChat[] = []
    const history: OpenAIChat[] = []

    if(!chat.firstMessageDisabled && character.firstMessage){
        history.push({ role: 'assistant', content: risuChatParser(character.firstMessage, { chara: character }) })
    }
    for(const message of chat.message){
        if(message.disabled || message.isComment) continue
        history.push({
            role: message.role === 'user' ? 'user' : 'assistant',
            content: risuChatParser(message.data, { chara: character }),
            memo: message.chatId,
        })
    }

    const lore = await loadLoreBookV3Prompt()
    const loreMessages: OpenAIChat[] = lore.actives
        .filter((entry) => entry.pos !== 'depth' && entry.pos !== 'reverse_depth' && !entry.pos.startsWith('pt_'))
        .map((entry) => ({
            role: entry.role ?? 'system',
            content: risuChatParser(entry.prompt, { chara: character }),
        }))

    const description = [character.desc, character.personality, character.scenario]
        .filter(Boolean)
        .join('\n\n')
    const persona = getPersonaPrompt()
    const templates = promptPreset.promptTemplate ?? ([
        { type: 'plain', type2: 'main', role: 'system', text: promptPreset.mainPrompt ?? '' },
        { type: 'description' },
        { type: 'persona' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
        { type: 'lorebook' },
        { type: 'plain', type2: 'globalNote', role: 'system', text: promptPreset.globalNote ?? '' },
        { type: 'jailbreak', type2: 'normal', role: 'system', text: promptPreset.jailbreak ?? '' },
    ] satisfies PromptItem[])

    const promptBindings = node.agentInfoBindings?.[promptPreset.id ?? ''] ?? {}

    for(const item of templates){
        switch(item.type){
            case 'plain':
            case 'cot':
            case 'jailbreak': {
                if(item.type === 'jailbreak' && !promptPreset.jailbreak) break
                push(result, {
                    role: roleMap[item.role],
                    content: risuChatParser(item.text, { chara: character, role: item.role }),
                })
                break
            }
            case 'chatML':
                push(result, parseChatML(item.text))
                break
            case 'chat':
                push(result, sliceChats(history, item))
                break
            case 'description':
                push(result, { role: roleMap[item.role2 ?? 'system'], content: wrap(risuChatParser(description, { chara: character }), item.innerFormat) })
                break
            case 'persona':
                push(result, { role: roleMap[item.role2 ?? 'system'], content: wrap(risuChatParser(persona, { chara: character }), item.innerFormat) })
                break
            case 'authornote': {
                const note = chat.note || item.defaultText || ''
                push(result, { role: roleMap[item.role2 ?? 'system'], content: wrap(risuChatParser(note, { chara: character }), item.innerFormat) })
                break
            }
            case 'lorebook':
                push(result, loreMessages)
                break
            case 'memory':
                break
            case 'postEverything':
                if(promptPreset.promptSettings?.postEndInnerFormat){
                    push(result, { role: 'system', content: risuChatParser(promptPreset.promptSettings.postEndInnerFormat, { chara: character }) })
                }
                break
            case 'cache': {
                let remaining = Math.max(0, item.depth)
                for(let i = result.length - 1; i >= 0 && remaining > 0; i--){
                    if(item.role === 'all' || result[i].role === item.role){
                        result[i].cachePoint = true
                        remaining--
                    }
                }
                break
            }
            case 'agentInfo': {
                const sourceIds = [...(promptBindings[item.id] ?? [])]
                    .sort((a, b) => (outputOrder?.get(a) ?? Number.MAX_SAFE_INTEGER) - (outputOrder?.get(b) ?? Number.MAX_SAFE_INTEGER))
                if(sourceIds.length === 0){
                    warnings.push(`Agent info card "${item.name || item.id}" has no connected output.`)
                    break
                }
                const values: string[] = []
                for(const sourceId of sourceIds){
                    const source = outputs.get(sourceId)
                    if(!source){
                        warnings.push(`Agent info source "${sourceId}" is unavailable.`)
                        continue
                    }
                    const format = item.innerFormat ?? '<AgentInfo name="{{agent_name}}">\n{{slot}}\n</AgentInfo>'
                    values.push(format
                        .replaceAll('{{agent_name}}', source.nodeName)
                        .replaceAll('{{slot}}', source.output))
                }
                push(result, { role: roleMap[item.role2 ?? 'system'], content: values.join('\n\n') })
                break
            }
        }
    }

    return { messages: result, warnings }
}

export function applyAgentPresetRegex(text: string, scripts: customscript[] | undefined): string {
    let result = text
    for(const script of scripts ?? []){
        if(script.type !== 'editoutput' || !script.in) continue
        try {
            const flags = script.ableFlag
                ? (script.flag || 'g').replace(/[^dgimsuvy]/g, '') || 'u'
                : 'g'
            result = result.replace(new RegExp(script.in, flags), script.out.replaceAll('$n', '\n'))
        } catch (error) {
            console.error('[Agent] prompt-preset regex failed', error)
        }
    }
    return result
}
