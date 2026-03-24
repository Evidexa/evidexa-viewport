const DB_NAME = "evidexa_db"
const DB_VERSION = 1
const STORE_NAME = "captures"

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true })
        store.createIndex("timestamp", "timestamp", { unique: false })
        store.createIndex("sourceUrl", "sourceUrl", { unique: false })
      }
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function saveCapture(record) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).add(record)
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function getAllCaptures() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly")
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = (e) => resolve(e.target.result.reverse())
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function getCapture(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly")
    const req = tx.objectStore(STORE_NAME).get(id)
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function deleteCapture(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).delete(id)
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function deleteAllCaptures() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).clear()
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function estimateStorageBytes() {
  const records = await getAllCaptures()
  return records.reduce((sum, r) => {
    const dataLen = r.dataUrl ? Math.floor(r.dataUrl.length * 0.75) : 0
    const thumbLen = r.thumbnailUrl ? Math.floor(r.thumbnailUrl.length * 0.75) : 0
    return sum + dataLen + thumbLen
  }, 0)
}
