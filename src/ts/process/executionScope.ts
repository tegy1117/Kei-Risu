import type { ChatExecutionContext } from './executionContext.svelte'
export type { ChatExecutionContext } from './executionContext.svelte'

// No runtime imports: database readers may be called by store initialization.
let current: ChatExecutionContext | undefined
export const getExecutionContext = () => current

// Scope only the synchronous call/start, never the lifetime of a promise.
export function withExecutionContext<T>(context: ChatExecutionContext | undefined, fn: () => T): T {
    const previous = current
    current = context
    try { return fn() } finally { current = previous }
}

export function lazyFunction<F extends (...args: any[]) => any>(factory: () => F): F {
    return ((...args: Parameters<F>) => factory()(...args)) as F
}

export function bindExecutionContext<F extends (...args: any[]) => any>(context: ChatExecutionContext | undefined, fn: F): F
export function bindExecutionContext<F extends (...args: any[]) => any>(context: ChatExecutionContext | undefined, fn: () => F, lazy: true): F
export function bindExecutionContext(context: ChatExecutionContext | undefined, fn: (...args: any[]) => any, lazy = false) {
    return (...args: any[]) => withExecutionContext(context, () => (lazy ? fn() : fn)(...args))
}
