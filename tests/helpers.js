import puppeteer from "puppeteer"
import http from "http"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const EXTENSION_PATH = path.resolve(fileURLToPath(import.meta.url), "../../")
export const FIXTURES_PATH = path.resolve(fileURLToPath(import.meta.url), "../fixtures")

let _fixtureServer = null

export async function startFixtureServer() {
  return new Promise((resolve, reject) => {
    _fixtureServer = http.createServer((req, res) => {
      const filePath = path.join(FIXTURES_PATH, req.url.split("?")[0])
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end("Not found")
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          res.end(data)
        }
      })
    })
    _fixtureServer.listen(0, "127.0.0.1", () => {
      const { port } = _fixtureServer.address()
      resolve(`http://127.0.0.1:${port}`)
    })
    _fixtureServer.on("error", reject)
  })
}

export async function stopFixtureServer() {
  if (_fixtureServer) {
    await new Promise((r) => _fixtureServer.close(r))
    _fixtureServer = null
  }
}

export async function launchWithExtension() {
  const browser = await puppeteer.launch({
    headless: false,
    pipe: true,
    enableExtensions: [EXTENSION_PATH],
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  })
  return browser
}

export async function getServiceWorker(browser) {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("background.js"),
    { timeout: 10000 }
  )
  return target.worker()
}

export async function getExtensionId(browser) {
  const worker = await getServiceWorker(browser)
  const id = await worker.evaluate(() => chrome.runtime.id)
  return id
}

export async function waitForResultTab(browser, extensionId, timeout = 30000) {
  const target = await browser.waitForTarget(
    (t) => t.type() === "page" && t.url().includes(`chrome-extension://${extensionId}/tab.html`),
    { timeout }
  )
  const page = await target.page()
  await page.waitForSelector("#capture-content:not(.hidden)", { timeout })
  return page
}

export async function getTabId(worker, urlFragment) {
  const tabs = await worker.evaluate(() => new Promise((r) => chrome.tabs.query({}, r)))
  const tab = tabs.find((t) => t.url && t.url.includes(urlFragment))
  return tab ? tab.id : null
}
