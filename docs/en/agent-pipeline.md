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
