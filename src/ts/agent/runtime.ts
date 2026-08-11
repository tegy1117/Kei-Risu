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
import { addBadge, beginPostProcessingStatus, endStatus } from '../status/requestStatus'
import { language } from 'src/lang'

export interface AgentMainPromptContext {
    generationId: string
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
    const initialCharacter = DBState.db.characters[charIndex]
    const initialChatIndex = initialCharacter?.chatPage
    const initialChat = initialCharacter?.chats?.[initialChatIndex]
    const characterId = initialCharacter?.chaId
    const chatId = initialChat?.id
    const resolveTarget = () => {
        const character = DBState.db.characters.find((entry) => entry.chaId === characterId)
            ?? DBState.db.characters[charIndex]
        const chat = character?.chats?.find((entry) => entry.id === chatId)
            ?? character?.chats?.[initialChatIndex]
        return character && chat ? { character, chat } : null
    }
    const initialTarget = resolveTarget()
    if(!initialTarget) return false
    const { chat } = initialTarget
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
    const restorePreviousMessage = () => {
        if(!previousState || previousMessageIndex < 0) return
        const message = resolveTarget()?.chat.message[previousMessageIndex]
        if(!message) return
        message.data = previousState.data
        message.displayData = previousState.displayData
        message.agentRun = previousState.agentRun
    }
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
        const target = resolveTarget()
        if(!promptPreset || !storedModelPreset || !target){
            record.status = 'failed'
            record.error = !promptPreset ? 'Prompt preset not found.'
                : !storedModelPreset ? 'Model preset not found.' : 'Agent chat is no longer available.'
            record.endedAt = Date.now()
            return record
        }
        record.promptPresetName = promptPreset.name
        record.modelPresetName = storedModelPreset.name
        try {
            const built = await buildAgentPrompt({ node, promptPreset, character: target.character, chat: target.chat, outputs, outputOrder })
            record.warnings = built.warnings
            run.warnings.push(...built.warnings.map((warning) => `${node.name}: ${warning}`))
            record.inputTokens = await countInputTokens(built.messages)
            const effectivePreset = applyExplicitPromptPresetParams(storedModelPreset, promptPreset, node.usePromptPresetParams)
            const requestPreset = { ...effectivePreset, name: `${node.name} · ${storedModelPreset.name}` }
            const response = await requestAgentModelPreset({
                formated: built.messages,
                bias: {},
                biasString: promptPreset.bias,
                currentChar: target.character,
                useStreaming: true,
                chatId: `${generationId}:${node.id}`,
                rememberToolUsage: DBState.db.rememberToolUsage,
                requestStatus: {
                    kind: 'agent',
                    parentId: generationId,
                    order: outputOrder.get(node.id),
                },
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
    const postFailures: AgentNodeRunRecord[] = []
    const hasPostStages = preset.stages
        .slice(validation.mainStageIndex + 1)
        .some((stage) => stage.nodes.some((node) => node.kind === 'agent'))

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
            const ok = await options.runMain({ generationId, node: mainNode, outputs, outputOrder, warnings: mainWarnings })
            record.warnings = mainWarnings
            run.warnings.push(...mainWarnings.map((warning) => `${mainNode.name}: ${warning}`))
            record.endedAt = Date.now()
            if(!ok){
                record.status = options.signal?.aborted ? 'aborted' : 'failed'
                const outcome = record.status === 'aborted' ? 'aborted' : 'failed'
                run.status = outcome
                run.endedAt = Date.now()
                console.warn('[Agent] main stage did not complete', {
                    generationId,
                    agentPresetId: preset.id,
                    nodeId: record.nodeId,
                    nodeName: record.nodeName,
                    status: record.status,
                })
                restorePreviousMessage()
                endStatus(generationId, outcome, { now: run.endedAt })
                endGeneration(generationKey)
                return false
            }
            const target = resolveTarget()
            if(!target){
                record.status = 'failed'
                record.error = 'Agent chat is no longer available.'
                run.status = 'failed'
                run.endedAt = Date.now()
                endStatus(generationId, 'failed', { now: run.endedAt, error: record.error })
                endGeneration(generationKey)
                return false
            }
            messageIndex = findLastCharacterMessageIndex(target.chat.message)
            if(messageIndex < 0){
                record.status = 'failed'
                record.error = 'Main output message was not created.'
                run.status = 'failed'
                run.endedAt = Date.now()
                endStatus(generationId, 'failed', { now: run.endedAt, error: record.error })
                endGeneration(generationKey)
                return false
            }
            const message = target.chat.message[messageIndex]
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
            if(hasPostStages) beginPostProcessingStatus(generationId, Date.now())
            continue
        }

        const workers = stage.nodes.filter((node): node is AgentWorkerNode => node.kind === 'agent')
        const stageRecords = await runWithConcurrency(workers, preset.maxParallel, (node) => executeWorker(node, stageIndex))

        if(!passedMain){
            const incomplete = stageRecords.filter((record) => record.status !== 'done')
            if(incomplete.length > 0){
                const failed = incomplete.filter((record) => record.status === 'failed')
                const aborted = options.signal?.aborted || incomplete.some((record) => record.status === 'aborted')
                const outcome = aborted ? 'aborted' : 'failed'
                run.status = outcome
                run.endedAt = Date.now()
                restorePreviousMessage()
                if(failed.length > 0){
                    console.warn('[Agent] pre-stage failed', {
                        generationId,
                        agentPresetId: preset.id,
                        failedAgents: failed.map((record) => ({
                            nodeId: record.nodeId,
                            nodeName: record.nodeName,
                            error: record.error || 'Agent request failed.',
                        })),
                    })
                    alertError(failed.map((record) => `${record.nodeName}: ${record.error || 'Agent request failed.'}`).join('\n'))
                }
                endStatus(generationId, outcome, { now: run.endedAt })
                endGeneration(generationKey)
                return false
            }
            continue
        }

        if(options.signal?.aborted || stageRecords.some((record) => record.status === 'aborted')){
            run.status = 'aborted'
            run.endedAt = Date.now()
            break
        }
        postFailures.push(...stageRecords.filter((record) => record.status === 'failed'))
        for(const node of workers){
            const record = records.get(node.id)!
            if(record.status !== 'done') continue
            const output = record.output ?? ''
            displayOutput = applyPostOutput(displayOutput, output, node.post.placement)
            if(node.post.includeInHistory){
                historyOutput = applyPostOutput(historyOutput, output, node.post.placement)
            }
        }
        const target = resolveTarget()
        if(!target){
            run.status = 'failed'
            run.endedAt = Date.now()
            endStatus(generationId, 'failed', { now: run.endedAt, error: 'Agent chat is no longer available.' })
            endGeneration(generationKey)
            return false
        }
        const message = target.chat.message[messageIndex]
        message.data = historyOutput
        message.displayData = displayOutput !== historyOutput ? displayOutput : undefined
        message.agentRun = run
        target.character.reloadKeys += 1
    }

    if(!passedMain){
        endGeneration(generationKey)
        return false
    }
    const target = resolveTarget()
    if(!target){
        run.status = 'failed'
        run.endedAt = Date.now()
        endStatus(generationId, 'failed', { now: run.endedAt, error: 'Agent chat is no longer available.' })
        endGeneration(generationKey)
        return false
    }
    const message = target.chat.message[messageIndex]
    run.historyOutput = historyOutput
    run.displayOutput = displayOutput
    const finalStatus = run.status === 'aborted' ? 'aborted' : postFailures.length > 0 ? 'partial' : 'done'
    run.status = finalStatus
    run.endedAt = Date.now()
    message.agentRun = run
    message.data = historyOutput
    message.displayData = displayOutput !== historyOutput ? displayOutput : undefined
    target.character.reloadKeys += 1
    if(postFailures.length > 0){
        const failedNames = postFailures.map((record) => record.nodeName)
        addBadge(generationId, {
            key: 'agent-failures',
            text: language.agent.failedAgents.replace('{names}', failedNames.join(', ')),
            tone: 'warn',
        })
        console.warn('[Agent] post-stage worker failures', {
            generationId,
            agentPresetId: preset.id,
            outcome: finalStatus,
            failedAgents: postFailures.map((record) => ({
                nodeId: record.nodeId,
                nodeName: record.nodeName,
                error: record.error || 'Agent request failed.',
            })),
        })
    }
    endStatus(generationId, finalStatus, { now: run.endedAt })
    if(finalStatus === 'aborted') return false
    if(DBState.db.ttsAutoSpeech) await sayTTS(target.character, displayOutput)
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
