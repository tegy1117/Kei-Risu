<p align="center">
  <a href="../en/agent-pipeline.md">English</a> | <strong>한국어</strong>
</p>

# Agent 파이프라인 상태 및 결과 정책

Agent 프리셋은 stage 순서대로 실행됩니다. **Main Output** 이전 worker stage는 필수 pre-stage이고, Main Output 이후 worker stage는 선택 post-stage입니다.

## 실행 상태

| 상태 | 의미 |
| --- | --- |
| `done` | Main Output과 모든 worker가 성공했습니다. |
| `partial` | Main Output은 성공했지만 하나 이상의 post-stage worker가 실패했습니다. |
| `failed` | Main Output, 필수 pre-stage worker 또는 파이프라인 결과 저장에 실패했습니다. |
| `aborted` | 사용자가 실행을 중단했습니다. |

`superseded`는 실행 결과와 별도입니다. 이후 메시지 편집으로 저장된 실행 상세가 대체되었음을 나타냅니다.

## post-stage 실패

- post-stage worker가 실패해도 Main Output과 성공한 post-stage 결과는 유지합니다.
- 한 stage의 모든 worker가 끝난 뒤 성공한 출력만 설정된 노드 순서대로 적용하며, 실패한 출력은 제외합니다.
- 이후 post-stage도 계속 실행합니다. 실패한 출력에 연결된 항목은 사용할 수 없으며 기존 Agent prompt 경고를 남깁니다.
- 모든 post-stage worker가 실패해도 Main Output을 사용할 수 있으므로 run 상태는 `partial`입니다.
- 상단 요청 상태 카드와 메시지의 Agent 실행 상세에 실패한 Agent 이름을 표시하며, 펼친 상세에서 각 오류를 확인할 수 있습니다.

## 사용자 중단

사용자 중단은 실패 분류보다 우선합니다. 중단 전에 완료되어 적용된 stage 결과는 유지하지만, 중단된 현재 stage의 결과는 적용하지 않습니다. 중단된 run은 자동 TTS와 완료 알림을 실행하지 않습니다.
