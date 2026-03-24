const stateIdle = document.getElementById("state-idle")
const stateCapturing = document.getElementById("state-capturing")
const stateLongScroll = document.getElementById("state-long-scroll")
const stateDone = document.getElementById("state-done")
const stateError = document.getElementById("state-error")

const progressLabel = document.getElementById("progress-label")
const progressFill = document.getElementById("progress-fill")
const errorMsg = document.getElementById("error-msg")

const btnStart = document.getElementById("btn-start")
const btnCancel = document.getElementById("btn-cancel")
const btnRetry = document.getElementById("btn-retry")
const btnLsCancel = document.getElementById("btn-ls-cancel")

function showState(name) {
  stateIdle.classList.add("hidden")
  stateCapturing.classList.add("hidden")
  stateLongScroll.classList.add("hidden")
  stateDone.classList.add("hidden")
  stateError.classList.add("hidden")
  document.getElementById("state-" + name).classList.remove("hidden")
}

function setProgress(tile, total) {
  if (total > 0) {
    progressFill.style.width = Math.round((tile / total) * 100) + "%"
    progressLabel.textContent = `Capturing tile ${tile} of ${total}…`
  }
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "LONG_SCROLL_DETECTED": {
      const { totalTiles, scrollHeight } = message.payload
      const screens = Math.round(scrollHeight / window.screen.height) || totalTiles
      document.getElementById("ls-desc").textContent =
        `This page has ~${totalTiles} screens of content (${Math.round(scrollHeight / 1000)}k px tall).`
      showState("long-scroll")
      break
    }

    case "CAPTURE_START":
      showState("capturing")
      progressFill.style.width = "0%"
      progressLabel.textContent = "Preparing…"
      if (message.payload && message.payload.totalTiles) {
        setProgress(0, message.payload.totalTiles)
      }
      break

    case "CAPTURE_PROGRESS":
      setProgress(message.payload.tile, message.payload.totalTiles)
      break

    case "CAPTURE_DONE":
      showState("done")
      setTimeout(() => window.close(), 1200)
      break

    case "CAPTURE_CANCELLED":
      window.close()
      break

    case "CAPTURE_ERROR":
      errorMsg.textContent = message.payload.message || "An error occurred."
      showState("error")
      break
  }
})

btnStart.addEventListener("click", () => {
  showState("capturing")
  chrome.runtime.sendMessage({ type: "REQUEST_CAPTURE" })
})

btnCancel.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" })
  window.close()
})

// Long scroll tile picker
document.querySelectorAll(".ls-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const maxTiles = parseInt(btn.dataset.tiles, 10)
    showState("capturing")
    progressFill.style.width = "0%"
    progressLabel.textContent = "Preparing…"
    chrome.runtime.sendMessage({ type: "CONFIRM_CAPTURE", payload: { maxTiles } })
  })
})

btnLsCancel.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" })
  window.close()
})

btnRetry.addEventListener("click", () => {
  showState("capturing")
  progressFill.style.width = "0%"
  progressLabel.textContent = "Preparing…"
  chrome.runtime.sendMessage({ type: "REQUEST_CAPTURE" })
})

// Auto-trigger capture when popup opens (toolbar button opens popup automatically)
// The service worker's REQUEST_CAPTURE handler resolves the active tab.
chrome.runtime.sendMessage({ type: "REQUEST_CAPTURE" })
showState("capturing")
