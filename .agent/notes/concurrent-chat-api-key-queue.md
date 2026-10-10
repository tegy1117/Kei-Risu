# Concurrent chats and managed API key limits

Generation ownership is keyed by the originating `chat.id`. Sending reserves that
chat before any asynchronous preparation. Another conversation remains usable;
the same conversation retains its Stop control and cannot start a second send.

`ChatExecutionContext` captures request settings and stable character/chat IDs.
Continuations bind their own synchronous entry points instead of keeping a global
context active across an await. Conversations are resolved against the current
database so rebases and chat reordering do not redirect writes. Whole-character
results preserve other conversations and the visible chat page. Deleted origins
are never redirected to the newly selected conversation.

Autosave observes every live generation, including conversations outside the
visible screen. A send explicitly persists its originating conversation at the
end, including partial responses, before releasing ownership.

The API key manager stores `maxConcurrentRequests` (positive integer, default 1).
The Node server owns a shared FIFO scheduler. Duplicate pool entries with the
same credential share capacity, using the smallest configured limit. Limits
cover durable model jobs, HTTP proxies and the local streaming proxy; calls
through globalFetch/fetchNative use the same scheduler even when plain fetch is
enabled. Low-level calls carrying a pool credential are recognized from their
headers or query parameters. OAuth service-account adapters carry a key reference.

Capacity remains occupied until the upstream body finishes, fails or is aborted.
Queued time does not consume the upstream timeout. Cancelling a queued request
removes it without calling the provider. Lowering a limit preserves active
requests and pauses later admissions; editing/removing a key invalidates its
waiting reservations. Private reservation headers are removed before forwarding.
Ready reservations expire after 30 seconds if not consumed. Queues are in memory;
durable jobs left by a server restart follow the existing failed-job recovery.

Request cards use a touch-through overlay. Each card independently collapses to
its generating/completed status, aligned to the right to keep the mobile menu
usable. The separate 44px square button resolves the originating chat by ID and
opens it. Completion notices retain the existing four-second dismissal window.

Validation uses the client, server and compatibility suites plus an isolated
Node server with a controlled streaming provider and a 360px Chromium touch
context. This does not modify production data or call a paid model provider.
