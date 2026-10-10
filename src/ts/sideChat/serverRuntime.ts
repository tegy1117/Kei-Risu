import { sendChatRequest, streamChatRequest } from '../preset/adapter/openaiCompatible'
import { sendAnthropicChatRequest, streamAnthropicChatRequest } from '../preset/adapter/anthropicMessages'
import { sendGoogleChatRequest, streamGoogleChatRequest } from '../preset/adapter/googleGemini'
import type { AdapterChatMessage, AdapterChatOptions, AdapterCredential } from '../preset/adapter/types'
import type { ModelPreset } from '../preset/types'
export { materializeSidePrompt } from './core'
export { reissueMessageIds } from '../chatClone'

export function normalizeSideMessages(preset: ModelPreset, input: AdapterChatMessage[], settings: any = {}): AdapterChatMessage[] {
    let messages = structuredClone(input)
    let firstSystem: AdapterChatMessage | undefined
    if (preset.profileSnapshot.adapterKind === 'openai-compatible' && preset.foldSystemPrompt) {
        if (preset.keepFirstSystemPrompt) {
            while (messages[0]?.role === 'system') {
                const message = messages.shift()
                if (firstSystem) firstSystem.content += '\n\n' + message.content
                else firstSystem = message
            }
        }
        for (const message of messages) if (message.role === 'system') {
            message.role = settings.systemRoleReplacement || 'user'
            message.content = settings.systemContentReplacement ? settings.systemContentReplacement.replace('{{slot}}', message.content) : `system: ${message.content}`
        }
    }
    if (preset.alternateRole) {
        const merged: AdapterChatMessage[] = []
        for (const message of messages) {
            const previous = merged.at(-1)
            if (previous?.role === message.role) {
                previous.content += '\n' + message.content
                if (message.images) previous.images = [...(previous.images || []), ...message.images]
                if (message.cachePoint) previous.cachePoint = true
            } else merged.push(message)
        }
        messages = merged
    }
    if (preset.startWithUserInput && messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: ' ' })
    if (firstSystem) messages.unshift(firstSystem)
    return messages
}

export async function runSideModel(preset: ModelPreset, options: AdapterChatOptions & { roleSettings?: any }, credential: AdapterCredential | undefined, onText: (text: string) => void) {
    const adapters = {
        'openai-compatible': [sendChatRequest, streamChatRequest],
        'anthropic-messages': [sendAnthropicChatRequest, streamAnthropicChatRequest],
        'google-gemini': [sendGoogleChatRequest, streamGoogleChatRequest],
    } as const
    const adapter = adapters[preset.profileSnapshot.adapterKind]
    if (!adapter) throw new Error('Unsupported side-chat model adapter.')
    const clean = { ...preset, toolUse: false }
    options = { ...options, messages: normalizeSideMessages(preset, options.messages, options.roleSettings) }
    // Never leak tool definitions from freeform preset parameters either.
    clean.customBody = { ...clean.customBody, tools: undefined, tool_choice: undefined }
    if (!preset.useStreaming) {
        const response = await adapter[0](clean, options, credential)
        onText(response.text)
        return { text: response.text, usage: response.usage }
    }
    let text = ''
    let usage
    for await (const delta of adapter[1](clean, options, credential)) {
        text += delta.textDelta
        if (delta.usage) usage = delta.usage
        onText(text)
    }
    return { text, usage }
}
