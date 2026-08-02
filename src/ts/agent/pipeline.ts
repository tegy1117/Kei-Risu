import { v4 as uuidv4 } from 'uuid'
import type { AgentPipelineNode, AgentPostPlacement, AgentPreset } from './types'

export interface AgentPresetValidationContext {
    promptPresetIds: Set<string>
    modelPresetIds: Set<string>
}

export interface AgentPresetValidationResult {
    errors: string[]
    warnings: string[]
    mainStageIndex: number
}

export function createAgentPreset(name = 'New Agent Preset'): AgentPreset {
    return {
        id: uuidv4(),
        name,
        maxParallel: 3,
        stages: [{
            id: uuidv4(),
            nodes: [{
                kind: 'main',
                id: uuidv4(),
                name: 'Main Output',
                agentInfoBindings: {},
            }],
        }],
    }
}

export function validateAgentPreset(
    preset: AgentPreset,
    context: AgentPresetValidationContext,
): AgentPresetValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    const allNodes: { node: AgentPipelineNode, stageIndex: number }[] = []
    const ids = new Set<string>()
    const names = new Set<string>()
    let mainStageIndex = -1
    let mainCount = 0

    preset.stages.forEach((stage, stageIndex) => {
        stage.nodes.forEach((node) => {
            allNodes.push({ node, stageIndex })
            if(!node.id || ids.has(node.id)) errors.push(`Duplicate or empty node id: ${node.id || '(empty)'}`)
            ids.add(node.id)
            const trimmedName = node.name?.trim()
            if(!trimmedName || names.has(trimmedName)) errors.push(`Duplicate or empty node name: ${trimmedName || '(empty)'}`)
            if(trimmedName) names.add(trimmedName)

            if(node.kind === 'main'){
                mainCount++
                mainStageIndex = stageIndex
                if(stage.nodes.length !== 1) errors.push('The main stage must contain only the main node.')
                return
            }
            if(!context.promptPresetIds.has(node.promptPresetId)) errors.push(`Missing prompt preset for ${node.name}.`)
            if(!context.modelPresetIds.has(node.modelPresetId)) errors.push(`Missing model preset for ${node.name}.`)
        })
    })

    if(mainCount !== 1) errors.push('An agent preset must contain exactly one main node.')
    if(!Number.isFinite(preset.maxParallel) || preset.maxParallel < 1 || preset.maxParallel > 16){
        errors.push('Maximum parallel requests must be between 1 and 16.')
    }

    const nodeStage = new Map(allNodes.map(({ node, stageIndex }) => [node.id, stageIndex]))
    for(const { node, stageIndex } of allNodes){
        for(const promptBindings of Object.values(node.agentInfoBindings ?? {})){
            for(const sourceIds of Object.values(promptBindings ?? {})){
                if(sourceIds.length === 0) warnings.push(`${node.name} has an empty agent-info binding.`)
                for(const sourceId of sourceIds){
                    const sourceStage = nodeStage.get(sourceId)
                    if(sourceStage === undefined) errors.push(`${node.name} references a missing agent output.`)
                    else if(sourceStage >= stageIndex) errors.push(`${node.name} can only reference an earlier stage.`)
                }
            }
        }
    }

    return { errors, warnings, mainStageIndex }
}

export async function runWithConcurrency<T, R>(
    values: T[],
    limit: number,
    task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    if(values.length === 0) return []
    const results = new Array<R>(values.length)
    let next = 0
    const worker = async () => {
        while(true){
            const index = next++
            if(index >= values.length) return
            results[index] = await task(values[index], index)
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), values.length) }, worker))
    return results
}

export function applyPostOutput(base: string, output: string, placement: AgentPostPlacement): string {
    if(placement === 'none') return base
    if(placement === 'replace') return output
    if(!output) return base
    if(!base) return output
    return placement === 'prepend' ? `${output}\n\n${base}` : `${base}\n\n${output}`
}

export function getOrderedNodes(preset: AgentPreset): AgentPipelineNode[] {
    return preset.stages.flatMap((stage) => stage.nodes)
}
