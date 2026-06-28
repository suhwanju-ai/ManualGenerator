# UML 클래스 다이어그램 — Manual Capture

이 확장은 클래스가 아닌 **모듈/함수 단위**로 구성됩니다. 아래 다이어그램은 3개 격리 컨텍스트를 모듈 "클래스"로, 주요 함수를 메서드로 표현합니다. 상수는 속성으로 표기합니다.

```mermaid
classDiagram
    class ContentScript {
        -boolean recording
        -string MARK
        -SENSITIVE_INPUT_TYPES
        -RegExp SENSITIVE_NAME_HINT
        -int HIGHLIGHT_PAINT_DELAY_MS
        +cssSelector(el) string
        +isSensitiveInput(el) boolean
        +labelFor(el) string
        +highlight(el) void
        +record(action, el) void
    }

    class BackgroundWorker {
        -int CAPTURE_MIN_INTERVAL_MS
        -SCREENSHOT_FORMAT
        -Promise queue
        -int lastCaptureAt
        +enablePanelOnClick() void
        +captureWithThrottle(windowId) Promise
        +handleCaptureStep(data, sender) Promise
        +handleManualCapture() Promise
        +storeStep(fields) Promise
    }

    class SidePanel {
        -string MODEL
        -string OPENROUTER_DEFAULT_MODEL
        -int GEN_CONCURRENCY
        -int MAX_RETRIES
        -int RENDER_DEBOUNCE_MS
        -Promise writeQueue
        +updateSteps(mutator) Promise
        +loadSettings() Promise
        +saveSettings() void
        +syncProviderUI() void
        +refreshRecordingUI() Promise
        +renderSteps() Promise
        +describeStep(step, settings) Promise
        +describeViaClaude(step, settings, sys, ctx) Promise
        +describeViaOpenAICompat(step, sys, ctx, api) Promise
        +fetchWithRetry(url, options) Promise
        +buildManualHtml(title, steps) string
        +escapeHtml(s) string
        +toast(msg, kind) void
    }

    class ChromeStorageLocal {
        +boolean recording
        +Step[] steps
        +string provider
        +SettingsKeys
        +get(keys) Promise
        +set(obj) Promise
        +onChanged event
    }

    class Step {
        +string id
        +int index
        +string action
        +string label
        +string tag
        +string selector
        +string url
        +number ts
        +string screenshot
        +string description
    }

    class LlmProvider {
        +string url
        +string key
        +string model
        +string name
    }

    ContentScript ..> BackgroundWorker : sendMessage CAPTURE_STEP
    BackgroundWorker ..> ChromeStorageLocal : get/set steps
    BackgroundWorker ..> Step : 생성
    ContentScript ..> ChromeStorageLocal : recording 구독
    SidePanel ..> ChromeStorageLocal : get/set/onChanged
    ChromeStorageLocal o-- Step : steps 배열 보유
    SidePanel ..> LlmProvider : describeViaOpenAICompat 설정
    SidePanel ..> Step : description 갱신
```

## 레이어/책임 요약

| 모듈 | 컨텍스트 | 단일 책임 |
|---|---|---|
| `ContentScript` | 페이지 주입 | 이벤트 감지, 요소 강조, 메타데이터 수집·전송 |
| `BackgroundWorker` | service worker | 스크린샷 캡처(스로틀), 단계 저장 직렬화 |
| `SidePanel` | 사이드패널 | 렌더링, LLM 호출(동시성·재시도), 편집, 내보내기 |
| `ChromeStorageLocal` | 브라우저 API | 상태 영속화 + 컨텍스트 간 동기화 채널 |
| `Step` | 데이터 모델 | 단계 레코드 |
| `LlmProvider` | 설정 구조체 | OpenAI 호환 호출 파라미터 묶음 |

## 관계 표기 설명

- `..>` (의존): 메시지 전송 또는 API 호출로 일시적 의존
- `o--` (집합): `ChromeStorageLocal`이 `Step` 배열을 보유하나 생명주기는 독립
