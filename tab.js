import {
  getCapture,
  getAllCaptures,
  deleteCapture,
  deleteAllCaptures,
  estimateStorageBytes
} from "./db.js"

// ── Clipboard ────────────────────────────────────────────────────────────────

async function copyToClipboard(dataUrl) {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
}

function bindCopyBtn(btnId, getDataUrl) {
  const btn = document.getElementById(btnId)
  if (!btn) return
  // Use .onclick (idempotent assignment) so repeated calls from openHistoryDetail
  // replace the handler instead of stacking multiple listeners.
  btn.onclick = async () => {
    const orig = btn.innerHTML
    try {
      await copyToClipboard(getDataUrl())
      btn.textContent = "Copied ✓"
    } catch (_) {
      btn.textContent = "Failed ✗"
    }
    setTimeout(() => { btn.innerHTML = orig }, 1500)
  }
}

// ── Routing ──────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search)
const captureId = params.has("id") ? Number(params.get("id")) : null

// ── Tab navigation ────────────────────────────────────────────────────────────

const tabBtns = document.querySelectorAll(".tab-btn")
const tabPanels = document.querySelectorAll(".tab-panel")

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn))
    tabPanels.forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${target}`))
    if (target === "history") loadHistory()
    if (target === "settings") loadSettings()
  })
})

// ── Lightbox ──────────────────────────────────────────────────────────────────

const lightbox = document.getElementById("lightbox")
const lightboxImg = document.getElementById("lightbox-img")
document.getElementById("lightbox-close").addEventListener("click", closeLightbox)
lightbox.addEventListener("click", (e) => { if (e.target === lightbox || e.target === lightboxImg) closeLightbox() })

function openLightbox(src) {
  lightboxImg.src = src
  lightbox.classList.remove("hidden")
}

function closeLightbox() {
  lightbox.classList.add("hidden")
  lightboxImg.src = ""
}

// ── Zoom system ───────────────────────────────────────────────────────────────

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0] // multipliers of natural display size
const ZOOM_FIT = "fit"

// Per-image zoom state: imgId → {zoom, levelIndex}
const zoomState = {}

// Click handlers stored separately so initZoom can update them without
// re-registering DOM listeners on repeated openHistoryDetail calls.
const zoomClickHandlers = {}

// Tracks which .preview-wrap elements already have DOM listeners attached.
// Prevents duplicate wheel/mouse handlers when the same detail panel reopens.
const initializedWraps = new WeakSet()

function getWrap(img) {
  return img.closest(".preview-wrap")
}

function getLevelEl(img) {
  return img.closest(".preview-col").querySelector(".zoom-level")
}

function applyZoom(img, zoom) {
  const wrap = getWrap(img)
  if (!wrap) return
  img.style.cursor = "grab"
  img.style.userSelect = "none"
  if (zoom === ZOOM_FIT) {
    img.style.width = "100%"
    img.style.height = "auto"
    wrap.style.overflow = "hidden"
  } else {
    const naturalDisplay = img.naturalWidth / (window.devicePixelRatio || 1)
    const w = Math.round(naturalDisplay * zoom)
    img.style.width = w + "px"
    img.style.height = "auto"
    wrap.style.overflow = "auto"
  }
  const levelEl = getLevelEl(img)
  if (levelEl) levelEl.textContent = zoom === ZOOM_FIT ? "Fit" : Math.round(zoom * 100) + "%"
}

function zoomIn(imgId) {
  const st = zoomState[imgId]
  if (!st) return
  if (st.zoom === ZOOM_FIT) {
    st.levelIndex = 3 // 100%
  } else {
    st.levelIndex = Math.min(st.levelIndex + 1, ZOOM_LEVELS.length - 1)
  }
  st.zoom = ZOOM_LEVELS[st.levelIndex]
  applyZoom(document.getElementById(imgId), st.zoom)
}

function zoomOut(imgId) {
  const st = zoomState[imgId]
  if (!st) return
  if (st.zoom === ZOOM_FIT) return
  if (st.levelIndex <= 0) {
    st.zoom = ZOOM_FIT
  } else {
    st.levelIndex = Math.max(st.levelIndex - 1, 0)
    st.zoom = ZOOM_LEVELS[st.levelIndex]
  }
  applyZoom(document.getElementById(imgId), st.zoom)
}

function zoomFit(imgId) {
  const st = zoomState[imgId]
  if (!st) return
  st.zoom = ZOOM_FIT
  applyZoom(document.getElementById(imgId), ZOOM_FIT)
}

function initZoom(imgId, onImageClick) {
  zoomState[imgId] = { zoom: ZOOM_FIT, levelIndex: 3 }
  // Always update the click handler ref so openHistoryDetail gets a fresh closure
  // without needing to re-add DOM listeners.
  zoomClickHandlers[imgId] = onImageClick

  const img = document.getElementById(imgId)
  if (!img) return
  applyZoom(img, ZOOM_FIT)
  const wrap = getWrap(img)
  if (!wrap) return

  // Guard: only attach DOM listeners once per wrap element.
  if (initializedWraps.has(wrap)) return
  initializedWraps.add(wrap)

  // Wheel to zoom
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault()
    if (e.deltaY < 0) zoomIn(imgId); else zoomOut(imgId)
  }, { passive: false })

  // Drag-to-pan at ALL zoom levels; short click (< 5px) triggers onImageClick
  let isPanning = false
  let panMoved = false
  let panStartX = 0, panStartY = 0
  let panScrollLeft = 0, panScrollTop = 0

  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    isPanning = true
    panMoved = false
    panStartX = e.clientX
    panStartY = e.clientY
    panScrollLeft = wrap.scrollLeft
    panScrollTop = wrap.scrollTop
    img.style.cursor = "grabbing"
    wrap.style.cursor = "grabbing"
  })

  window.addEventListener("mousemove", (e) => {
    if (!isPanning) return
    const dx = e.clientX - panStartX
    const dy = e.clientY - panStartY
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) panMoved = true
    wrap.scrollLeft = panScrollLeft - dx
    wrap.scrollTop = panScrollTop - dy
  })

  window.addEventListener("mouseup", () => {
    if (!isPanning) return
    isPanning = false
    img.style.cursor = "grab"
    wrap.style.cursor = ""
    // Read from zoomClickHandlers so the latest handler is always invoked
    // even if initZoom was called again (new record) after listeners were set up.
    if (!panMoved && zoomClickHandlers[imgId]) zoomClickHandlers[imgId]()
    panMoved = false
  })

  window.addEventListener("mouseleave", () => {
    if (!isPanning) return
    isPanning = false
    img.style.cursor = "grab"
    wrap.style.cursor = ""
    panMoved = false
  })
}

// Wire toolbar buttons (delegated on document — buttons may be added after DOMContentLoaded)
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".zoom-btn")
  if (!btn) return
  const imgId = btn.dataset.target
  if (!imgId) return
  if (btn.hasAttribute("data-zoom-in")) zoomIn(imgId)
  else if (btn.hasAttribute("data-zoom-out")) zoomOut(imgId)
  else if (btn.hasAttribute("data-zoom-fit")) zoomFit(imgId)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  })
}

function fmtSize(w, h) {
  return `${w.toLocaleString()} × ${h.toLocaleString()} px`
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return url }
}

function triggerDownload(dataUrl, name) {
  const a = document.createElement("a")
  a.href = dataUrl
  a.download = name
  a.click()
}

function filenameBase(record) {
  const host = hostname(record.sourceUrl).replace(/[^a-z0-9]/gi, "-")
  const ts = record.timestamp.slice(0, 10)
  return `evidexa-${host}-${ts}`
}

function downloadJpeg(record) {
  const img = new Image()
  img.onload = () => {
    const c = document.createElement("canvas")
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext("2d")
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0)
    c.toBlob((blob) => {
      const url = URL.createObjectURL(blob)
      triggerDownload(url, filenameBase(record) + ".jpg")
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }, "image/jpeg", 0.92)
  }
  img.src = record.dataUrl
}

function downloadPdf(record) {
  const img = new Image()
  img.onload = () => {
    const { jsPDF } = window.jspdf
    const wPx = img.naturalWidth
    const hPx = img.naturalHeight
    const wMm = (wPx * 25.4) / 96
    const hMm = (hPx * 25.4) / 96
    const pdf = new jsPDF({
      orientation: hMm > wMm ? "portrait" : "landscape",
      unit: "mm",
      format: [wMm, hMm]
    })
    pdf.addImage(record.dataUrl, "PNG", 0, 0, wMm, hMm)
    pdf.save(filenameBase(record) + ".pdf")
  }
  img.src = record.dataUrl
}

function bindDownloads(record, pngBtn, jpegBtn, pdfBtn) {
  // .onclick assignments replace the handler on each call — no listener accumulation.
  pngBtn.onclick = () => triggerDownload(record.dataUrl, filenameBase(record) + ".png")
  jpegBtn.onclick = () => downloadJpeg(record)
  pdfBtn.onclick = () => downloadPdf(record)
}

// ── Current Capture tab ───────────────────────────────────────────────────────

const captureLoading = document.getElementById("capture-loading")
const captureEmpty = document.getElementById("capture-empty")
const captureContent = document.getElementById("capture-content")

async function loadCurrentCapture() {
  if (!captureId) {
    captureLoading.classList.add("hidden")
    captureEmpty.classList.remove("hidden")
    return
  }

  let record
  try { record = await getCapture(captureId) } catch (_) { record = null }

  if (!record) {
    captureLoading.classList.add("hidden")
    captureEmpty.classList.remove("hidden")
    return
  }

  document.getElementById("preview-img").src = record.dataUrl
  document.getElementById("meta-url").href = record.sourceUrl
  document.getElementById("meta-url").textContent = record.sourceUrl
  document.getElementById("meta-title").textContent = record.sourceTitle || "—"
  document.getElementById("meta-size").textContent = fmtSize(record.width, record.height)
  document.getElementById("meta-time").textContent = fmtDate(record.timestamp)
  if (record.heightCapped) {
    document.getElementById("meta-capped").classList.remove("hidden")
  }

  bindDownloads(
    record,
    document.getElementById("btn-download-png"),
    document.getElementById("btn-download-jpeg"),
    document.getElementById("btn-download-pdf")
  )

  initZoom("preview-img", () => openLightbox(record.dataUrl))
  document.getElementById("btn-lightbox-main").addEventListener("click", () => openLightbox(record.dataUrl))

  bindCopyBtn("btn-copy-png", () => record.dataUrl)

  if (record.devicePreset) {
    document.getElementById("meta-device").textContent = record.devicePreset
    document.getElementById("meta-device-row").classList.remove("hidden")
  }

  const { autoCopyClipboard } = await chrome.storage.sync.get("autoCopyClipboard")
  if (autoCopyClipboard) copyToClipboard(record.dataUrl).catch(() => {})

  captureLoading.classList.add("hidden")
  captureContent.classList.remove("hidden")
}

// ── History tab ───────────────────────────────────────────────────────────────

const historyLoading = document.getElementById("history-loading")
const historyEmpty = document.getElementById("history-empty")
const historyGrid = document.getElementById("history-grid")
const historyDetail = document.getElementById("history-detail")

let historyLoaded = false

async function loadHistory() {
  if (historyLoaded) return
  historyLoaded = false

  historyLoading.classList.remove("hidden")
  historyEmpty.classList.add("hidden")
  historyGrid.classList.add("hidden")
  historyDetail.classList.add("hidden")

  let records
  try { records = await getAllCaptures() } catch (_) { records = [] }

  historyLoading.classList.add("hidden")

  if (records.length === 0) {
    historyEmpty.classList.remove("hidden")
    return
  }

  historyGrid.innerHTML = ""
  records.forEach((r) => historyGrid.appendChild(buildHistoryCard(r)))
  historyGrid.classList.remove("hidden")
  historyLoaded = true
}

function buildHistoryCard(record) {
  const card = document.createElement("div")
  card.className = "history-card"
  card.dataset.id = record.id

  const thumb = document.createElement("img")
  thumb.className = "history-thumb"
  thumb.src = record.thumbnailUrl || record.dataUrl
  thumb.alt = record.sourceTitle || "Screenshot"
  thumb.loading = "lazy"

  const body = document.createElement("div")
  body.className = "history-card-body"
  body.innerHTML = `
    <div class="history-card-host">${hostname(record.sourceUrl)}</div>
    <div class="history-card-date">${fmtDate(record.timestamp)}</div>
    <div class="history-card-size">${fmtSize(record.width, record.height)}</div>
  `

  const delBtn = document.createElement("button")
  delBtn.className = "history-card-del"
  delBtn.textContent = "✕"
  delBtn.title = "Delete"
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation()
    await deleteCapture(record.id)
    card.remove()
    if (historyGrid.children.length === 0) {
      historyGrid.classList.add("hidden")
      historyEmpty.classList.remove("hidden")
    }
  })

  card.appendChild(thumb)
  card.appendChild(body)
  card.appendChild(delBtn)
  card.addEventListener("click", () => openHistoryDetail(record))
  return card
}

function openHistoryDetail(record) {
  historyGrid.classList.add("hidden")
  historyDetail.classList.remove("hidden")

  document.getElementById("detail-preview-img").src = record.dataUrl
  document.getElementById("detail-url").href = record.sourceUrl
  document.getElementById("detail-url").textContent = record.sourceUrl
  document.getElementById("detail-title").textContent = record.sourceTitle || "—"
  document.getElementById("detail-size").textContent = fmtSize(record.width, record.height)
  document.getElementById("detail-time").textContent = fmtDate(record.timestamp)

  initZoom("detail-preview-img", () => openLightbox(record.dataUrl))
  document.getElementById("btn-lightbox-detail").onclick = () => openLightbox(record.dataUrl)

  bindCopyBtn("detail-btn-copy-png", () => record.dataUrl)

  const devRow = document.getElementById("detail-device-row")
  const devEl = document.getElementById("detail-device")
  if (record.devicePreset) {
    devEl.textContent = record.devicePreset
    devRow.classList.remove("hidden")
  } else {
    devRow.classList.add("hidden")
  }

  bindDownloads(
    record,
    document.getElementById("detail-btn-png"),
    document.getElementById("detail-btn-jpeg"),
    document.getElementById("detail-btn-pdf")
  )

  const deleteBtn = document.getElementById("detail-btn-delete")
  const confirmRow = document.getElementById("detail-confirm-delete")
  const confirmYes = document.getElementById("detail-confirm-yes")
  const confirmNo = document.getElementById("detail-confirm-no")

  deleteBtn.onclick = () => confirmRow.classList.toggle("hidden")
  confirmNo.onclick = () => confirmRow.classList.add("hidden")
  confirmYes.onclick = async () => {
    await deleteCapture(record.id)
    historyLoaded = false
    historyDetail.classList.add("hidden")
    await loadHistory()
  }
}

document.getElementById("detail-back").addEventListener("click", () => {
  historyDetail.classList.add("hidden")
  historyGrid.classList.remove("hidden")
})

// ── Settings tab ──────────────────────────────────────────────────────────────

const STANDARD_DEVICE_PRESETS = [
  { id: "iphone-16e",        name: "iPhone 16e",        width: 390,  height: 844,  dpr: 3,     mobile: true },
  { id: "iphone-17",         name: "iPhone 17",         width: 402,  height: 874,  dpr: 3,     mobile: true },
  { id: "iphone-air",        name: "iPhone Air",        width: 420,  height: 912,  dpr: 3,     mobile: true },
  { id: "iphone-17-pro-max", name: "iPhone 17 Pro Max", width: 440,  height: 956,  dpr: 3,     mobile: true },
  { id: "ipad-mini",         name: "iPad Mini",         width: 744,  height: 1133, dpr: 2,     mobile: false },
  { id: "ipad-air-11",       name: 'iPad Air 11"',      width: 820,  height: 1180, dpr: 2,     mobile: false },
  { id: "ipad-pro-13",       name: 'iPad Pro 13"',      width: 1032, height: 1376, dpr: 2,     mobile: false },
  { id: "pixel-9",           name: "Pixel 9",           width: 412,  height: 915,  dpr: 2.625, mobile: true },
  { id: "galaxy-s25",        name: "Galaxy S25",        width: 360,  height: 780,  dpr: 3,     mobile: true },
  { id: "macbook-13",        name: 'MacBook Air 13"',   width: 1280, height: 800,  dpr: 2,     mobile: false },
  { id: "desktop-1080",      name: "Desktop 1080p",     width: 1920, height: 1080, dpr: 1,     mobile: false }
]

let settingsLoaded = false

async function loadSettings() {
  const bytes = await estimateStorageBytes()
  const mb = bytes / (1024 * 1024)
  const fill = document.getElementById("storage-fill")
  const label = document.getElementById("storage-label")
  const warning = document.getElementById("storage-warning")

  const pct = Math.min((mb / 200) * 100, 100)
  fill.style.width = pct + "%"
  fill.className = "storage-fill" + (mb >= 100 ? " danger" : mb >= 80 ? " warn" : "")
  label.textContent = `${mb.toFixed(1)} MB used`
  warning.classList.toggle("hidden", mb < 100)

  document.getElementById("about-ext-id").textContent = `Extension ID: ${chrome.runtime.id}`

  if (!settingsLoaded) {
    settingsLoaded = true
    initBehaviourSettings()
    initDevicePresets()
  }
}

function initBehaviourSettings() {
  const toggle = document.getElementById("setting-auto-copy")
  chrome.storage.sync.get("autoCopyClipboard", ({ autoCopyClipboard }) => {
    toggle.checked = !!autoCopyClipboard
  })
  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ autoCopyClipboard: toggle.checked })
  })
}

function renderPresets(standardList, customList) {
  const stdEl = document.getElementById("device-presets-standard")
  const custEl = document.getElementById("device-presets-custom")

  stdEl.innerHTML = standardList.map((d) =>
    `<div class="preset-pill preset-pill-std">
      <span class="preset-name">${d.name}</span>
      <span class="preset-dims">${d.width}\u00d7${d.height} @${d.dpr}x</span>
    </div>`
  ).join("")

  custEl.innerHTML = customList.length ? customList.map((d) =>
    `<div class="preset-pill preset-pill-custom" data-id="${d.id}">
      <span class="preset-name">${d.name}</span>
      <span class="preset-dims">${d.width}\u00d7${d.height} @${d.dpr}x</span>
      <button class="preset-delete" data-id="${d.id}" title="Delete">&times;</button>
    </div>`
  ).join("") : ""

  custEl.querySelectorAll(".preset-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { customDevicePresets = [] } = await chrome.storage.sync.get("customDevicePresets")
      const updated = customDevicePresets.filter((d) => d.id !== btn.dataset.id)
      await chrome.storage.sync.set({ customDevicePresets: updated })
      renderPresets(STANDARD_DEVICE_PRESETS, updated)
    })
  })
}

function initDevicePresets() {
  chrome.storage.sync.get("customDevicePresets", ({ customDevicePresets = [] }) => {
    renderPresets(STANDARD_DEVICE_PRESETS, customDevicePresets)
  })

  const addBtn = document.getElementById("btn-add-preset")
  const form = document.getElementById("add-preset-form")
  const cancelBtn = document.getElementById("btn-cancel-preset")
  const saveBtn = document.getElementById("btn-save-preset")

  addBtn.addEventListener("click", () => form.classList.remove("hidden"))
  cancelBtn.addEventListener("click", () => form.classList.add("hidden"))

  saveBtn.addEventListener("click", async () => {
    const name = document.getElementById("preset-name").value.trim()
    const width = parseInt(document.getElementById("preset-width").value, 10)
    const height = parseInt(document.getElementById("preset-height").value, 10)
    const dpr = parseFloat(document.getElementById("preset-dpr").value) || 1
    const mobile = document.getElementById("preset-mobile").checked

    if (!name || !width || !height) return

    const { customDevicePresets = [] } = await chrome.storage.sync.get("customDevicePresets")
    const newPreset = { id: Date.now().toString(36), name, width, height, dpr, mobile }
    const updated = [...customDevicePresets, newPreset]
    await chrome.storage.sync.set({ customDevicePresets: updated })
    renderPresets(STANDARD_DEVICE_PRESETS, updated)
    form.classList.add("hidden")
    document.getElementById("preset-name").value = ""
    document.getElementById("preset-width").value = ""
    document.getElementById("preset-height").value = ""
    document.getElementById("preset-dpr").value = ""
    document.getElementById("preset-mobile").checked = false
  })
}

const btnClearAll = document.getElementById("btn-clear-all")
const clearConfirm = document.getElementById("clear-confirm")
const clearYes = document.getElementById("clear-confirm-yes")
const clearNo = document.getElementById("clear-confirm-no")

btnClearAll.addEventListener("click", () => clearConfirm.classList.toggle("hidden"))
clearNo.addEventListener("click", () => clearConfirm.classList.add("hidden"))
clearYes.addEventListener("click", async () => {
  await deleteAllCaptures()
  clearConfirm.classList.add("hidden")
  historyLoaded = false
  await loadSettings()
})

// ── Init ──────────────────────────────────────────────────────────────────────

loadCurrentCapture()
