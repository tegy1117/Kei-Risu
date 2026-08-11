<p align="center">
  <strong>English</strong> | <a href="../ko/agent-pipeline.md">한국어</a>
</p>

# Agent pipeline status and output policy

An Agent preset runs stages in order. Worker stages before **Main Output** are required pre-stages. Worker stages after Main Output are optional post-stages.

## Run status

| Status | Meaning |
| --- | --- |
| `done` | Main Output and every worker completed successfully. |
| `partial` | Main Output completed, but one or more post-stage workers failed. |
| `failed` | Main Output, a required pre-stage worker, or pipeline persistence failed. |
| `aborted` | The user stopped the run. |

`superseded` is separate from execution results. It marks saved run details that were replaced by a later message edit.

## Post-stage failures

- A failed post-stage worker does not discard Main Output or successful post-stage results.
- After every worker in a stage settles, successful outputs are applied in the configured node order. Failed outputs are skipped.
- Later post-stages still run. A binding to a failed output is unavailable and produces the existing Agent prompt warning.
- Even if every post-stage worker fails, the run is `partial` because Main Output remains usable.
- The request-status card and the message's Agent run details list the failed Agent names. Expanded details show each recorded error.

## Cancellation

Cancellation takes precedence over failure classification. Results from stages committed before cancellation remain, but no result from the interrupted stage is applied. An aborted run does not trigger automatic TTS or a completion notification.

## Regex scope

Agent workers intentionally use a narrower regex contract than the normal Main Output pipeline. This keeps Agent-to-Agent routing predictable and avoids applying display-only or input-side transformations to intermediate data.

The current worker flow is:

1. Build the worker prompt from its selected prompt preset, chat context, lorebook, and connected `AgentInfo` outputs.
2. Send the request with the selected model preset.
3. Trim the returned worker text.
4. Apply only enabled prompt-preset regex entries whose type is `editoutput`, in preset order.
5. Store that transformed text as the worker output.
6. Expose the transformed text to later `AgentInfo` bindings.
7. If the worker is a post-stage, apply the transformed text to the final message according to `prepend`, `append`, `replace`, or `none`.

The following regex categories are **not** applied as an additional Agent-worker pass:

- `editinput`: input-side processing remains part of the normal request/prompt pipeline, not worker output processing.
- `editdisplay`: display-only transforms are not used for intermediate Agent outputs.
- `editprocess` and `edittrans`: they are not replayed after an Agent worker returns.
- Tool function regex stages (`arguments`, `agentOutput`, `modelResult`, `visibleCall`, and card stages): these belong to Managed Tools, not Agent presets.

A worker output therefore has one canonical routed value: **trimmed model response after that worker prompt preset's `editoutput` regex**. The same value is recorded in run details, sent through `AgentInfo`, and used for post-stage placement. Invalid regex entries are skipped after logging an error so that one malformed script does not crash the entire Agent run.

If a future feature needs a different scope, add an explicit Agent-specific stage rather than silently reusing a normal-chat regex category. That keeps existing Agent presets behavior-compatible.
