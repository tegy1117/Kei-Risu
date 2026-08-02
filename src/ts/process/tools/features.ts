import type { customscript, triggerscript } from 'src/ts/storage/database.svelte'
import { getActiveToolFeaturePackages } from './tools'

export function getToolAssets(): [string, string, string][] {
    return getActiveToolFeaturePackages().flatMap((tool) => tool.assets ?? [])
}

export function getToolRegexScripts(): customscript[] {
    return getActiveToolFeaturePackages().flatMap((tool) => tool.regex ?? [])
}

export function getToolTriggers(): triggerscript[] {
    return getActiveToolFeaturePackages().flatMap((tool) =>
        (tool.trigger ?? []).map((trigger) => ({ ...trigger, lowLevelAccess: false })))
}

export function getToolToggles(): string {
    return getActiveToolFeaturePackages().map((tool) => tool.customToggle ?? '').filter(Boolean).join('\n')
}

export function getToolBackgroundEmbedding(): string {
    return getActiveToolFeaturePackages().map((tool) => tool.backgroundEmbedding ?? '').filter(Boolean).join('\n')
}
