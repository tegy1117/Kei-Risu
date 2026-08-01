import { get } from 'svelte/store'
import { v4 as uuidv4 } from 'uuid'
import { alertError } from '../alert'
import { selectedCharID } from '../stores.svelte'
import { DBState } from '../stores.svelte'
import { tokenize } from '../tokenizer'
import type { AgentMainNode, AgentNodeRunRecord, AgentPipelineNode, AgentPreset, AgentRunRecord, AgentWorkerNode } from './types'
import { applyPostOutput, runWithConcurrency, validateAgentPreset } from './pipeline'
import { applyAgentPresetRegex, buildAgentPrompt, type AgentOutputValue } from './promptBuilder'
import { requestAgentModelPreset } from '../process/request/request'
import { applyExplicitPromptPresetParams } from '../process/request/modelPresetBinding'
import { sayTTS } from '../process/tts'
import { chatGenKey, endGeneration, isChatGenerating, startGeneration } from '../process/generationState'

export interface AgentMainPromptContext {
    node: AgentMainNode
    outputs: Map<string, AgentOutputValue>
    outputOrder: Map<string, number>
    warnings: string[]
}

export interface RunAgentPipelineOptions {
    signal?: AbortSignal
    continue?: boolean
    preview?: boolean
    previewPrompt?: boolean
    runMain: (context?: AgentMainPromptContext) => Promise<boolean>
}

function findLastCharacterMessageIndex(messages: { role: string }[]): number {
    for(let i = messages.length - 1; i >= 0; i--){
        if(messages[i].role === 'char') return i
    }
    return -1
}

async function countInputTokens(messages: { content: string }[]): Promise<number> {
    let total = 0
    for(const message of messages) total += await tokenize(message.content)
    return total
}

export async function runAgentPipeline(options: RunAgentPipelineOptions): Promise<boolean> {
    if(options.preview || options.previewPrompt) return options.runMain()

    const charIndex = get(selectedCharID)
    const character = DBState.db.characters[charIndex]
    const chat = character?.chats?.[character.chatPage]
    const boundId = chat?.boundAgentPresetId
    if(!boundId) return options.runMain()

    const preset = DBState.db.agentPresets.find((entry) => entry.id === boundId)
    if(!preset){
        alertError('The agent preset bound to this chat no longer exists.')
        return false
    }
    const validation = validateAgentPreset(preset, {
        promptPresetIds: new Set(DBState.db.botPresets.map((entry) => entry.id).filter(Boolean)),
        modelPresetIds: new Set(DBState.db.modelPresets.map((entry) => entry.id)),
    })
    if(validation.errors.length > 0){
        alertError(validation.errors.join('\n'))
        return false
    }

    const generationId = uuidv4()
    const generationKey = chatGenKey(chat.id)
    if(isChatGenerating(generationKey)) return false
    startGeneration(generationKey, generationId)
    const startedAt = Date.now()
    const records = new Map<string, AgentNodeRunRecord>()
    preset.stages.forEach((stage, stageIndex) => {
        stage.nodes.forEach((node) => records.set(node.id, {
            nodeId: node.id,
            nodeName: node.name,
            kind: node.kind,
            stageIndex,
            status: 'pending',
        }))
    })
    const run: AgentRunRecord = {
        generationId,
        agentPresetId: preset.id,
        agentPresetName: preset.name,
        startedAt,
        status: 'running',
        nodes: [...records.values()],
        warnings: [...validation.warnings],
    }
    const outputs = new Map<string, AgentOutputValue>()
    const outputOrder = new Map(preset.stages.flatMap((stage) => stage.nodes).map((node, index) => [node.id, index]))

    const previousMessageIndex = findLastCharacterMessageIndex(chat.message)
    const continuedMessage = options.continue && previousMessageIndex >= 0 ? chat.message[previousMessageIndex] : null
    const previousState = continuedMessage ? {
        data: continuedMessage.data,
        displayData: continuedMessage.displayData,
        agentRun: continuedMessage.agentRun,
    } : null
    if(continuedMessage?.agentRun?.rawMainOutput !== undefined){
        continuedMessage.data = continuedMessage.agentRun.rawMainOutput
        delete continuedMessage.displayData
    }

    const executeWorker = async (node: AgentWorkerNode, stageIndex: number): Promise<AgentNodeRunRecord> => {
        const record = records.get(node.id)!
        record.status = 'running'
        record.startedAt = Date.now()
        record.promptPresetId = node.promptPresetId
        record.modelPresetId = node.modelPresetId
        if(options.signal?.aborted){
            record.status = 'aborted'
            record.endedAt = Date.now()
            return record
        }
        const promptPreset = DBState.db.botPresets.find((entry) => entry.id === node.promptPresetId)
        const storedModelPreset = DBState.db.modelPresets.find((entry) => entry.id === node.modelPresetId)
        if(!promptPreset || !storedModelPreset){
            record.status = 'failed'
            record.error = !promptPreset ? 'Prompt preset not found.' : 'Model preset not found.'
            record.endedAt = Date.now()
            return record
        }
        record.promptPresetName = promptPreset.name
        record.modelPresetName = storedModelPreset.name
        try {
            const built = await buildAgentPrompt({ node, promptPreset, character, chat, outputs, outputOrder })
            record.warnings = built.warnings
            run.warnings.push(...built.warnings.map((warning) => `${node.name}: ${warning}`))
            record.inputTokens = await countInputTokens(built.messages)
            const effectivePreset = applyExplicitPromptPresetParams(storedModelPreset, promptPreset, node.usePromptPresetParams)
            const requestPreset = { ...effectivePreset, name: `${node.name} · ${storedModelPreset.name}` }
            const response = await requestAgentModelPreset({
                formated: built.messages,
                bias: {},
                biasString: promptPreset.bias,
                currentChar: character,
                useStreaming: true,
                chatId: `${generationId}:${node.id}`,
                rememberToolUsage: DBState.db.rememberToolUsage,
            }, requestPreset, options.signal)
            record.model = response.model
            if(!response.ok){
                record.status = options.signal?.aborted ? 'aborted' : 'failed'
                record.error = 'error' in response ? response.error : 'Agent request failed.'
            } else {
                const output = applyAgentPresetRegex(response.text.trim(), promptPreset.regex)
                record.output = output
                record.outputTokens = await tokenize(output)
                record.status = 'done'
                outputs.set(node.id, { nodeId: node.id, nodeName: node.name, output })
            }
        } catch (error) {
            record.status = options.signal?.aborted ? 'aborted' : 'failed'
            record.error = error instanceof Error ? error.message : String(error)
        }
        record.endedAt = Date.now()
        return record
    }

    let messageIndex = -1
    let historyOutput = ''
    let displayOutput = ''
    let passedMain = false

    for(let stageIndex = 0; stageIndex < preset.stages.length; stageIndex++){
        const stage = preset.stages[stageIndex]
        const mainNode = stage.nodes.find((node): node is AgentMainNode => node.kind === 'main')
        if(mainNode){
            const record = records.get(mainNode.id)!
            record.status = 'running'
            record.startedAt = Date.now()
            const activePrompt = DBState.db.botPresets[DBState.db.botPresetsId]
            record.promptPresetId = activePrompt?.id
            record.promptPresetName = activePrompt?.name
            const mainWarnings: string[] = []
            const ok = await options.runMain({ node: mainNode, outputs, outputOrder, warnings: mainWarnings })
            record.warnings = mainWarnings
            run.warnings.push(...mainWarnings.map((warning) => `${mainNode.name}: ${warning}`))
            record.endedAt = Date.now()
            if(!ok){
                record.status = options.signal?.aborted ? 'aborted' : 'failed'
                run.status = record.status === 'aborted' ? 'aborted' : 'failed'
                run.endedAt = Date.now()
                if(continuedMessage && previousState){
                    continuedMessage.data = previousState.data
                    continuedMessage.displayData = previousState.displayData
                    continuedMessage.agentRun = previousState.agentRun
                }
                endGeneration(generationKey)
                return false
            }
            messageIndex = findLastCharacterMessageIndex(chat.message)
            if(messageIndex < 0){
                record.status = 'failed'
                record.error = 'Main output message was not created.'
                run.status = 'failed'
                run.endedAt = Date.now()
                endGeneration(generationKey)
                return false
            }
            const message = chat.message[messageIndex]
            const rawMainOutput = message.data
            record.status = 'done'
            record.output = rawMainOutput
            record.model = message.generationInfo?.model
            record.inputTokens = message.generationInfo?.inputTokens
            record.outputTokens = message.generationInfo?.outputTokens
            outputs.set(mainNode.id, { nodeId: mainNode.id, nodeName: mainNode.name, output: rawMainOutput })
            run.rawMainOutput = rawMainOutput
            historyOutput = rawMainOutput
            displayOutput = rawMainOutput
            message.agentRun = run
            delete message.displayData
            passedMain = true
            continue
        }

        const workers = stage.nodes.filter((node): node is AgentWorkerNode => node.kind === 'agent')
        const stageRecords = await runWithConcurrency(workers, preset.maxParallel, (node) => executeWorker(node, stageIndex))

        if(!passedMain){
            const failed = stageRecords.find((record) => record.status !== 'done')
            if(failed){
                run.status = failed.status === 'aborted' ? 'aborted' : 'failed'
                run.endedAt = Date.now()
                if(continuedMessage && previousState){
                    continuedMessage.data = previousState.data
                    continuedMessage.displayData = previousState.displayData
                    continuedMessage.agentRun = previousState.agentRun
                }
                if(failed.status === 'failed') alertError(`${failed.nodeName}: ${failed.error || 'Agent request failed.'}`)
                endGeneration(generationKey)
                return false
            }
            continue
        }

        if(options.signal?.aborted){
            run.status = 'aborted'
            run.endedAt = Date.now()
            break
        }
        for(const node of workers){
            const record = records.get(node.id)!
            if(record.status !== 'done') continue
            const output = record.output ?? ''
            displayOutput = applyPostOutput(displayOutput, output, node.post.placement)
            if(node.post.includeInHistory){
                historyOutput = applyPostOutput(historyOutput, output, node.post.placement)
            }
        }
        const message = chat.message[messageIndex]
        message.data = historyOutput
        message.displayData = displayOutput !== historyOutput ? displayOutput : undefined
        message.agentRun = run
        character.reloadKeys += 1
    }

    if(!passedMain) return false
    const message = chat.message[messageIndex]
    run.historyOutput = historyOutput
    run.displayOutput = displayOutput
    if(run.status === 'running') run.status = 'done'
    run.endedAt = Date.now()
    message.agentRun = run
    message.data = historyOutput
    message.displayData = displayOutput !== historyOutput ? displayOutput : undefined
    character.reloadKeys += 1
    if(DBState.db.ttsAutoSpeech) await sayTTS(character, displayOutput)
    if(DBState.db.notification){
        try {
            const permission = await Notification.requestPermission()
            if(permission === 'granted'){
                const notification = new Notification('Risuai', { body: displayOutput })
                notification.onclick = () => window.focus()
            }
        } catch (error) {
            console.warn('[Agent] notification failed', error)
        }
    }
    return true
}
