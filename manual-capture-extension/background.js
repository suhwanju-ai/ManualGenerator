// background.js — 서비스 워커 (MV3)
// 역할: 사이드패널 토글, content script가 보낸 단계마다 보이는 탭을 캡처해 저장.
// 주의: MV3 워커는 휘발성이므로 상태/단계는 항상 chrome.storage.local 에 보관한다.

const CAPTURE_MIN_INTERVAL_MS = 650; // captureVisibleTab 초당 호출 제한 회피
const SCREENSHOT_FORMAT = { format: "jpeg", quality: 60 };

// 툴바 아이콘 클릭 시 사이드패널 열기
function enablePanelOnClick() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}
chrome.runtime.onInstalled.addListener(enablePanelOnClick);
enablePanelOnClick();

// ---- 직렬화 큐 ----
// steps 배열의 read-modify-write가 동시에 일어나면 마지막 write가 앞 단계를
// 덮어써 단계가 유실된다(race condition). 모든 단계 처리를 Promise 체인으로
// 직렬화해 한 번에 하나씩만 storage를 갱신한다. 캡처 호출 간격 보장도 겸한다.
let queue = Promise.resolve();
let lastCaptureAt = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "CAPTURE_STEP") {
    queue = queue
      .then(() => handleCaptureStep(msg.data, sender))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 비동기 응답
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureWithThrottle(windowId) {
  const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, SCREENSHOT_FORMAT);
}

async function handleCaptureStep(data, sender) {
  const { recording } = await chrome.storage.local.get("recording");
  if (!recording) return { ok: false, skipped: true };

  let dataUrl = "";
  if (!data.skipScreenshot) {
    try {
      dataUrl = await captureWithThrottle(sender?.tab?.windowId);
    } catch (e) {
      // chrome:// 등 캡처 불가 페이지 — 단계는 텍스트만이라도 기록
      console.warn("captureVisibleTab 실패:", e);
    }
  }

  const { steps = [] } = await chrome.storage.local.get("steps");
  steps.push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    index: steps.length + 1,
    action: data.action,
    label: data.label,
    tag: data.tag,
    selector: data.selector,
    url: data.url,
    ts: Date.now(),
    screenshot: dataUrl, // data:image/jpeg;base64,... (민감 입력은 빈 문자열)
    description: "",
  });
  await chrome.storage.local.set({ steps });
  return { ok: true, count: steps.length };
}
