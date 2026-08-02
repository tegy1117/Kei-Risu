export type AgentPostPlacement = 'prepend' | 'append' | 'replace' | 'none'

export type AgentInfoBindings = Record<string, Record<string, string[]>>

export interface AgentNodeBase {
    id: string
    name: string
    agentInfoBindings: AgentInfoBindings
}

export interface AgentMainNode extends AgentNodeBase {
    kind: 'main'
}

export interface AgentWorkerNode extends AgentNodeBase {
    kind: 'agent'
    promptPresetId: string
    modelPresetId: string
    usePromptPresetParams: boolean
    post: {
        placement: AgentPostPlacement
        includeInHistory: boolean
    }
}

export type AgentPipelineNode = AgentMainNode | AgentWorkerNode

export interface AgentStage {
    id: string
    nodes: AgentPipelineNode[]
}

export interface AgentPreset {
    id: string
    name: string
    maxParallel: number
    stages: AgentStage[]
}

export type AgentNodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted'

export interface AgentNodeRunRecord {
    nodeId: string
    nodeName: string
    kind: AgentPipelineNode['kind']
    stageIndex: number
    status: AgentNodeRunStatus
    promptPresetId?: string
    promptPresetName?: string
    modelPresetId?: string
    modelPresetName?: string
    model?: string
    startedAt?: number
    endedAt?: number
    output?: string
    error?: string
    inputTokens?: number
    outputTokens?: number
    warnings?: string[]
}

export interface AgentRunRecord {
    generationId: string
    agentPresetId: string
    agentPresetName: string
    startedAt: number
    endedAt?: number
    rawMainOutput?: string
    historyOutput?: string
    displayOutput?: string
    status: 'running' | 'done' | 'failed' | 'aborted' | 'superseded'
    nodes: AgentNodeRunRecord[]
    warnings: string[]
    supersededByEditAt?: number
}

export interface AgentMessageVariantState {
    displayData?: string
    agentRun?: AgentRunRecord
}
