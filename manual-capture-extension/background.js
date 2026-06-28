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
  // 사이드패널의 '현재 화면 캡처' 버튼 — 클릭/입력과 무관하게 보이는 탭을 단계로 추가
  if (msg?.type === "MANUAL_CAPTURE") {
    queue = queue
      .then(() => handleManualCapture())
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
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

  return storeStep({
    action: data.action,
    label: data.label,
    tag: data.tag,
    selector: data.selector,
    url: data.url,
    screenshot: dataUrl, // data:image/jpeg;base64,... (민감 입력은 빈 문자열)
  });
}

// 사이드패널 버튼으로 수동 캡처: 활성 탭을 직접 조회해 보이는 화면을 단계로 추가.
// 특정 요소가 없으므로 action은 "화면 캡처", label/tag/selector는 비운다.
async function handleManualCapture() {
  const { recording, recordingTabId } = await chrome.storage.local.get([
    "recording",
    "recordingTabId",
  ]);
  if (!recording) return { ok: false, skipped: true };

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let dataUrl = "";
  try {
    dataUrl = await captureWithThrottle(tab?.windowId);
  } catch (e) {
    console.warn("captureVisibleTab 실패:", e);
  }

  const res = await storeStep({
    action: "화면 캡처",
    label: "",
    tag: "",
    selector: "",
    url: tab?.url || "",
    screenshot: dataUrl,
  });

  // 녹화 시작 탭과 다른 탭을 찍었는지 알려, 사이드패널이 사용자에게 경고할 수 있게 한다.
  const otherTab =
    recordingTabId != null && tab?.id != null && tab.id !== recordingTabId;
  return { ...res, otherTab, url: tab?.url || "" };
}

// steps 배열에 단계 하나를 추가(직렬화 큐 안에서만 호출). id/index/ts/description 기본값 부여.
async function storeStep(fields) {
  const { steps = [] } = await chrome.storage.local.get("steps");
  steps.push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    index: steps.length + 1,
    action: fields.action,
    label: fields.label,
    tag: fields.tag,
    selector: fields.selector,
    url: fields.url,
    ts: Date.now(),
    screenshot: fields.screenshot,
    description: "",
  });
  await chrome.storage.local.set({ steps });
  return { ok: true, count: steps.length };
}
