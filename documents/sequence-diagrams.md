# UML 시퀀스 다이어그램 — Manual Capture

확장 내 3개 격리 컨텍스트(content / background / sidepanel)와 외부 LLM API 간의 핵심 흐름입니다. 메시지/저장 규약은 → [API 설계 문서](api-design.md).

---

## 1. 녹화 시작/토글 흐름

녹화 상태는 `chrome.storage.local.recording`에 저장되며, storage 변경 이벤트로 모든 컨텍스트에 전파됩니다.

```mermaid
sequenceDiagram
    actor User as 사용자
    participant SP as Side Panel (sidepanel.js)
    participant ST as chrome.storage.local
    participant CS as Content Script (content.js)

    User->>SP: "녹화 시작" 클릭
    SP->>ST: get(recording)
    ST-->>SP: 현재 값
    SP->>ST: set(recording = !현재)
    ST-->>SP: onChanged(recording)
    SP->>SP: refreshRecordingUI (버튼/점 갱신)
    ST-->>CS: onChanged(recording)
    CS->>CS: recording 플래그 갱신
    Note over CS: 이제 클릭/입력 이벤트를 수집
```

---

## 2. 단계 수집 흐름 (핵심 비즈니스 로직)

사용자가 웹앱을 클릭/입력하면 content script가 메타데이터를 보내고, background가 스크린샷을 찍어 저장합니다.

```mermaid
sequenceDiagram
    actor User as 사용자
    participant CS as Content Script
    participant BG as Background (service worker)
    participant Tab as chrome.tabs
    participant ST as chrome.storage.local
    participant SP as Side Panel

    User->>CS: 요소 클릭 (mousedown, 좌클릭)
    CS->>CS: highlight() 빨간 박스 표시
    CS->>CS: labelFor / cssSelector / 민감여부 판정
    Note over CS: 90ms 뒤(하이라이트 페인트 후) 전송
    CS->>BG: sendMessage(CAPTURE_STEP, data)
    BG->>BG: 직렬화 큐에 추가
    BG->>ST: get(recording)
    ST-->>BG: recording = true
    alt 스크린샷 필요 (민감 입력 아님)
        BG->>BG: 마지막 캡처 후 650ms 미만이면 대기(throttle)
        BG->>Tab: captureVisibleTab(jpeg q60)
        Tab-->>BG: data URL
    else 민감 입력
        Note over BG: 캡처 생략, screenshot=""
    end
    BG->>ST: get(steps) → push(새 단계) → set(steps)
    BG-->>CS: { ok: true, count }
    ST-->>SP: onChanged(steps)
    SP->>SP: 200ms 디바운스 후 renderSteps()
```

---

## 3. 수동 캡처 흐름 (사이드패널 버튼)

녹화 중 "📷 현재 화면 캡처" 버튼을 누르면 클릭/입력과 무관하게 현재 화면을 단계로 추가합니다. `CAPTURE_STEP`과 달리 sidepanel이 메시지를 보내고, background가 활성 탭을 직접 조회합니다.

```mermaid
sequenceDiagram
    actor User as 사용자
    participant SP as Side Panel
    participant BG as Background
    participant Tabs as chrome.tabs
    participant ST as chrome.storage.local

    User->>SP: "현재 화면 캡처" 클릭
    SP->>ST: get(recording)
    alt 녹화 중 아님
        SP-->>User: "녹화 중에만 캡처" 토스트
    else 녹화 중
        SP->>BG: sendMessage(MANUAL_CAPTURE)
        BG->>BG: 직렬화 큐에 추가 (handleManualCapture)
        BG->>Tabs: query(active, lastFocusedWindow)
        Tabs-->>BG: 활성 탭(windowId, url)
        BG->>BG: 650ms 미만이면 대기(throttle)
        BG->>Tabs: captureVisibleTab(jpeg q60)
        Tabs-->>BG: data URL
        BG->>ST: storeStep(action 화면 캡처) set(steps)
        BG-->>SP: ok true count
        SP-->>User: "현재 화면을 캡처했습니다" 토스트
        ST-->>SP: onChanged(steps) 재렌더
    end
```

---

## 4. 설명 생성 흐름 (LLM 호출 + 동시성)

```mermaid
sequenceDiagram
    actor User as 사용자
    participant SP as Side Panel
    participant ST as chrome.storage.local
    participant API as LLM 제공자

    User->>SP: "설명 생성" 클릭
    SP->>ST: get(설정 + steps)
    SP->>SP: 제공자별 필수 설정 검증
    alt 설정 누락
        SP-->>User: 토스트 안내 + 설정 패널 오픈
    else 검증 통과
        SP->>SP: description 없는 단계만 todo로 추림
        par 워커 3개 동시 실행 (GEN_CONCURRENCY)
            loop pending 큐 소진까지
                SP->>API: describeStep (이미지+컨텍스트)
                API-->>SP: 설명 텍스트
                SP->>ST: updateSteps(해당 step.description 저장)
                SP->>SP: progressBar 갱신
            end
        end
        SP->>SP: renderSteps()
        SP-->>User: "N개 단계 설명 생성" 토스트
    end
```

---

## 5. 에러 처리 / 재시도 흐름

`fetchWithRetry`는 429/5xx/네트워크 오류를 지수 백오프로 재시도하고, 단계별 실패는 격리합니다.

```mermaid
sequenceDiagram
    participant SP as Side Panel (worker)
    participant FR as fetchWithRetry
    participant API as LLM 제공자

    SP->>FR: describeStep 호출
    loop attempt 0..3
        FR->>API: fetch(요청)
        alt 상태 429 또는 5xx
            API-->>FR: 오류 상태
            Note over FR: 1s, 2s, 4s 지수 백오프 후 재시도
        else 네트워크 오류
            Note over FR: 동일하게 재시도
        else 2xx
            API-->>FR: 성공 응답
            FR-->>SP: Response
        else 4xx (429 제외)
            API-->>FR: 즉시 반환
            FR-->>SP: Response(ok=false)
            SP->>SP: Error throw
        end
    end
    alt 재시도 소진
        FR-->>SP: 마지막 오류 throw
    end
    SP->>SP: failed++ , 해당 단계 토스트 알림
    Note over SP: 다른 단계 생성은 계속 진행
```

---

## 6. HTML 내보내기 흐름

```mermaid
sequenceDiagram
    actor User as 사용자
    participant SP as Side Panel
    participant ST as chrome.storage.local
    participant DOM as Browser (Blob/다운로드)

    User->>SP: "HTML 내보내기" 클릭
    SP->>ST: get(steps, docTitle)
    alt steps 비어있음
        SP-->>User: "내보낼 단계가 없습니다" 토스트
    else
        SP->>SP: buildManualHtml(title, steps) - 이미지 base64 인라인
        SP->>DOM: Blob 생성 → createObjectURL
        SP->>DOM: a.download 클릭 → 파일 저장
        SP->>DOM: revokeObjectURL
        SP-->>User: "HTML 매뉴얼을 내보냈습니다" 토스트
    end
```
