# ER 다이어그램 — Manual Capture

이 확장은 관계형 DB를 사용하지 않고 `chrome.storage.local`에 키-값으로 저장합니다(→ [DB 설계 문서](database-design.md)). 아래 ER 다이어그램은 논리적 데이터 모델(저장 키 간의 개념적 관계)을 표현합니다.

```mermaid
erDiagram
    STORAGE_ROOT {
        boolean recording "녹화 상태 플래그"
        string provider "선택된 AI 제공자"
        string docTitle "매뉴얼 제목"
        string audience "대상 독자(선택)"
    }
    SETTINGS_PROVIDER {
        string apiKey "Claude 직접 키"
        string openrouterKey "OpenRouter 키"
        string openrouterModel "OpenRouter 모델(선택)"
        string customKey "커스텀 키(선택)"
        string customModel "커스텀 모델"
        string customBaseUrl "커스텀 Base URL"
    }
    STEP {
        string id PK "Date.now-base36 고유 ID"
        int index "1부터 시작하는 순번"
        string action "클릭 또는 입력"
        string label "요소 식별 텍스트"
        string tag "HTML 태그명"
        string selector "추정 CSS selector"
        string url "동작 발생 페이지 URL"
        number ts "생성 epoch ms"
        string screenshot "JPEG base64 data URL"
        string description "LLM 생성 설명"
    }

    STORAGE_ROOT ||--|| SETTINGS_PROVIDER : "포함"
    STORAGE_ROOT ||--o{ STEP : "수집"
    SETTINGS_PROVIDER ||--o{ STEP : "설명 생성에 사용"
```

## 관계 설명

| 관계 | 표기 | 의미 |
|---|---|---|
| STORAGE_ROOT — SETTINGS_PROVIDER | 1:1 | 단일 storage 루트가 하나의 설정 묶음을 가짐 |
| STORAGE_ROOT — STEP | 1:N | `steps` 배열이 0개 이상의 단계 레코드를 보유 |
| SETTINGS_PROVIDER — STEP | 1:N (논리) | 선택된 제공자/모델 설정이 각 단계의 `description` 생성에 사용됨 |

> 물리적으로는 모두 `chrome.storage.local`의 평면(flat) 키이며, `STEP`만 `steps` 키 아래 배열로 중첩 저장됩니다. PK인 `id`는 단계 편집·삭제 시 대상 식별에 사용됩니다(외래키 제약은 없음 — 애플리케이션 레벨 참조).
