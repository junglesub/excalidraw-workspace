import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

// --- CONFIGURATION & ISOLATION ---
const TEST_PORT = Number(process.env.TEST_PORT) || 3123;
const CDP_PORT = Number(process.env.CDP_PORT) || 9322;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const testDataDir = mkdtempSync(path.join(tmpdir(), 'excalidraw-test-data-'));
const chromeUserDir = mkdtempSync(path.join(tmpdir(), 'chrome-test-user-'));

console.log('===========================================================');
console.log('Isolated Verification Harness for Canvas URL Presentation');
console.log('===========================================================');
console.log(`Next.js Port:   ${TEST_PORT}`);
console.log(`CDP Port:       ${CDP_PORT}`);
console.log(`DATA_DIR:       ${testDataDir}`);
console.log(`Chrome Dir:     ${chromeUserDir}`);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

let passedCount = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`\n❌ ASSERTION FAILED: ${message}\n`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedCount++;
  console.log(`  ✓ ${message}`);
}

let serverProcess = null;
let chromeProcess = null;
let ws = null;
let msgId = 1;
const pending = new Map();

function cdp(method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInPage(expression) {
  const res = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error('Evaluation error: ' + JSON.stringify(res.exceptionDetails));
  }
  return res.result?.value;
}

try {
  // Pre-flight check: ensure TEST_PORT and CDP_PORT are not already occupied
  console.log('\n[0/7] Pre-flight port verification...');
  const testPortFree = await isPortFree(TEST_PORT);
  assert(testPortFree, `TEST_PORT ${TEST_PORT} is free and unowned by preexisting services`);
  const cdpPortFree = await isPortFree(CDP_PORT);
  assert(cdpPortFree, `CDP_PORT ${CDP_PORT} is free and unowned by preexisting services`);

  // 1. Start isolated Next.js dev server
  console.log('\n[1/7] Spawning isolated Next.js dev server...');
  serverProcess = spawn('npx', ['next', 'dev', '-p', String(TEST_PORT)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATA_DIR: testDataDir,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin1234!',
      NODE_ENV: 'development',
    },
    shell: true,
    stdio: 'ignore',
  });

  // Wait for server to accept login
  let sessionCookie = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin1234!' }),
      });
      if (res.ok) {
        const cookie = res.headers.get('set-cookie')?.match(/pew_session=([^;]+)/)?.[1];
        if (cookie) {
          sessionCookie = cookie;
          break;
        }
      }
    } catch {}
    await sleep(500);
  }
  assert(Boolean(sessionCookie), 'Server started and admin session obtained');

  // 2. Create isolated test document with:
  //    - url-black: initial auto URL (#1e1e1e)
  //    - url-red: imported red URL (#e03131)
  //    - url-hidden: opacity 0 URL (must be invisible and not openable)
  //    - url-semi: opacity 50 URL (must render with 0.5 opacity)
  //    - url-under-rect + rect-cover-all: URL below opaque filled rectangle (must be occluded)
  //    - rect-base + url-above-rect: URL above opaque filled rectangle (must be visible)
  //    - url-under-img + img-cover: URL below image (must be occluded)
  console.log('\n[2/7] Creating test document with test scenarios via API...');
  const createDocRes = await fetch(`${BASE_URL}/api/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `pew_session=${sessionCookie}`,
    },
    body: JSON.stringify({
      title: 'Canvas URL Verification Document',
      scene: {
        type: 'excalidraw',
        version: 2,
        elements: [
          {
            id: 'url-black',
            type: 'text',
            x: 100,
            y: 100,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 1001,
            isDeleted: false,
            text: 'https://example.com/black',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/black',
            lineHeight: 1.25,
          },
          {
            id: 'url-red',
            type: 'text',
            x: 100,
            y: 200,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#e03131',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 2001,
            isDeleted: false,
            text: 'https://example.com/red',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/red',
            lineHeight: 1.25,
          },
          {
            id: 'url-hidden',
            type: 'text',
            x: 100,
            y: 300,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 0,
            version: 1,
            versionNonce: 3001,
            isDeleted: false,
            text: 'https://example.com/hidden',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/hidden',
            lineHeight: 1.25,
          },
          {
            id: 'url-semi',
            type: 'text',
            x: 100,
            y: 400,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 50,
            version: 1,
            versionNonce: 4001,
            isDeleted: false,
            text: 'https://example.com/semi',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/semi',
            lineHeight: 1.25,
          },
          // URL below opaque rectangle:
          {
            id: 'url-under-rect',
            type: 'text',
            x: 100,
            y: 500,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 5001,
            isDeleted: false,
            text: 'https://example.com/under-rect',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/under-rect',
            lineHeight: 1.25,
          },
          {
            id: 'rect-cover-all',
            type: 'rectangle',
            x: 80,
            y: 485,
            width: 300,
            height: 60,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            opacity: 100,
            version: 1,
            versionNonce: 5002,
            isDeleted: false,
          },
          // URL above opaque rectangle:
          {
            id: 'rect-base',
            type: 'rectangle',
            x: 80,
            y: 585,
            width: 300,
            height: 60,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: '#ffc9c9',
            fillStyle: 'solid',
            opacity: 100,
            version: 1,
            versionNonce: 6001,
            isDeleted: false,
          },
          {
            id: 'url-above-rect',
            type: 'text',
            x: 100,
            y: 600,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 6002,
            isDeleted: false,
            text: 'https://example.com/above-rect',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/above-rect',
            lineHeight: 1.25,
          },
          // URL below image:
          {
            id: 'url-under-img',
            type: 'text',
            x: 100,
            y: 700,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 7001,
            isDeleted: false,
            text: 'https://example.com/under-img',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/under-img',
            lineHeight: 1.25,
          },
          {
            id: 'img-cover',
            type: 'image',
            x: 80,
            y: 685,
            width: 300,
            height: 60,
            angle: 0,
            strokeColor: '#000000',
            opacity: 100,
            version: 1,
            versionNonce: 7002,
            isDeleted: false,
            fileId: 'dummy-file',
          },
          // Ellipse silhouette test: corner vs center
          {
            id: 'url-ellipse-corner',
            type: 'text',
            x: 455,
            y: 55,
            width: 50,
            height: 20,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8101,
            isDeleted: false,
            text: 'https://example.com/el-corner',
            fontSize: 16,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 14,
            containerId: null,
            originalText: 'https://example.com/el-corner',
            lineHeight: 1.25,
          },
          {
            id: 'url-ellipse-center',
            type: 'text',
            x: 550,
            y: 190,
            width: 100,
            height: 20,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8102,
            isDeleted: false,
            text: 'https://example.com/el-center',
            fontSize: 16,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 14,
            containerId: null,
            originalText: 'https://example.com/el-center',
            lineHeight: 1.25,
          },
          {
            id: 'ellipse-cover',
            type: 'ellipse',
            x: 450,
            y: 50,
            width: 300,
            height: 300,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            opacity: 100,
            version: 1,
            versionNonce: 8103,
            isDeleted: false,
          },
          // Diamond silhouette test: corner vs center
          {
            id: 'url-diamond-corner',
            type: 'text',
            x: 455,
            y: 405,
            width: 50,
            height: 20,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8201,
            isDeleted: false,
            text: 'https://example.com/dia-corner',
            fontSize: 16,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 14,
            containerId: null,
            originalText: 'https://example.com/dia-corner',
            lineHeight: 1.25,
          },
          {
            id: 'url-diamond-center',
            type: 'text',
            x: 550,
            y: 540,
            width: 100,
            height: 20,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8202,
            isDeleted: false,
            text: 'https://example.com/dia-center',
            fontSize: 16,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 14,
            containerId: null,
            originalText: 'https://example.com/dia-center',
            lineHeight: 1.25,
          },
          {
            id: 'diamond-cover',
            type: 'diamond',
            x: 450,
            y: 400,
            width: 300,
            height: 300,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            opacity: 100,
            version: 1,
            versionNonce: 8203,
            isDeleted: false,
          },
          // Translucent rectangle test (opacity: 50)
          {
            id: 'url-under-translucent',
            type: 'text',
            x: 100,
            y: 800,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8301,
            isDeleted: false,
            text: 'https://example.com/translucent',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/translucent',
            lineHeight: 1.25,
          },
          {
            id: 'rect-translucent',
            type: 'rectangle',
            x: 80,
            y: 785,
            width: 300,
            height: 60,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            opacity: 50,
            version: 1,
            versionNonce: 8302,
            isDeleted: false,
          },
          // Patterned rectangle test (fillStyle: hachure)
          {
            id: 'url-under-hachure',
            type: 'text',
            x: 100,
            y: 900,
            width: 260,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8401,
            isDeleted: false,
            text: 'https://example.com/hachure',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/hachure',
            lineHeight: 1.25,
          },
          {
            id: 'rect-hachure',
            type: 'rectangle',
            x: 80,
            y: 885,
            width: 300,
            height: 60,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: '#ffffff',
            fillStyle: 'hachure',
            opacity: 100,
            version: 1,
            versionNonce: 8402,
            isDeleted: false,
          },
          // Rotated URL under unrotated opaque rectangle
          {
            id: 'url-rot-covered',
            type: 'text',
            x: 100,
            y: 1000,
            width: 180,
            height: 30,
            angle: 0.2,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8501,
            isDeleted: false,
            text: 'https://example.com/rot-covered',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/rot-covered',
            lineHeight: 1.25,
          },
          {
            id: 'rect-rot-cover',
            type: 'rectangle',
            x: 50,
            y: 950,
            width: 300,
            height: 130,
            angle: 0,
            strokeColor: '#000000',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            opacity: 100,
            version: 1,
            versionNonce: 8502,
            isDeleted: false,
          },
          // Rotated cover intersecting URL where unrotated boxes would miss (SAT)
          {
            id: 'url-sat',
            type: 'text',
            x: 100,
            y: 1110,
            width: 200,
            height: 30,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            opacity: 100,
            version: 1,
            versionNonce: 8601,
            isDeleted: false,
            text: 'https://example.com/sat-url',
            fontSize: 20,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            baseline: 18,
            containerId: null,
            originalText: 'https://example.com/sat-url',
            lineHeight: 1.25,
          },
          {
            id: 'rect-sat-cover',
            type: 'rectangle',
            x: 310,
            y: 1075,
            width: 100,
            height: 100,
            angle: 0.7853981633974483, // Math.PI / 4
            strokeColor: '#000000',
            backgroundColor: '#ffffff',
            fillStyle: 'solid',
            opacity: 100,
            version: 1,
            versionNonce: 8602,
            isDeleted: false,
          },
        ],
        appState: {},
        files: {},
      },
    }),
  });
  assert(createDocRes.ok, `Document created via POST /api/documents (HTTP ${createDocRes.status})`);
  const docData = await createDocRes.json();
  const docId = docData.document.id;
  assert(Boolean(docId), `Document id assigned: ${docId}`);

  // Upload attachment for img-cover to ensure valid scene image storage
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const formData = new FormData();
  formData.append('file', new Blob([png1x1], { type: 'image/png' }), 'dummy.png');
  formData.append('fileId', 'dummy-file');
  const uploadRes = await fetch(`${BASE_URL}/api/documents/${docId}/attachments`, {
    method: 'POST',
    headers: {
      Cookie: `pew_session=${sessionCookie}`,
    },
    body: formData,
  });
  assert(uploadRes.ok, `Uploaded dummy-file attachment for image element (HTTP ${uploadRes.status})`);

  // 3. Launch isolated headless Chrome
  console.log('\n[3/7] Launching headless Chrome on CDP port ' + CDP_PORT + '...');
  chromeProcess = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${chromeUserDir}`,
    '--window-size=1800,1600',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) break;
    } catch {}
    await sleep(200);
  }

  const newTabRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const tab = await newTabRes.json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  await cdp('Network.enable');
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1800,
    height: 1600,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp('Network.setCookie', {
    name: 'pew_session',
    value: sessionCookie,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
  });

  // 4. Navigate with ?e2e=true opt-in
  console.log('\n[4/7] Navigating to document with ?e2e=true opt-in...');
  await cdp('Page.navigate', { url: `${BASE_URL}/documents/${docId}?e2e=true` });

  // Wait for canvas to mount
  for (let i = 0; i < 60; i++) {
    const ready = await evalInPage('Boolean(document.querySelector(".excalidraw canvas") && window.__excalidrawAPI)');
    if (ready) break;
    await sleep(250);
  }
  await sleep(1000); // let fonts settle

  // -------------------------------------------------------------
  // ASSERTION 1: Visible Blue Glyphs & Underline Analysis
  // -------------------------------------------------------------
  console.log('\n--- Assertion 1: Visible Blue Glyphs & Underline Analysis ---');
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  assert(Boolean(screenshot.data), 'Captured render screenshot from Chrome');

  const pixelAnalysis = await evalInPage(`
    (async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${screenshot.data}';
      await new Promise(r => { img.onload = r; });

      const testCanvas = document.createElement('canvas');
      testCanvas.width = img.width;
      testCanvas.height = img.height;
      const ctx = testCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const api = window.__excalidrawAPI;
      const appState = api.getAppState();
      const canvas = document.querySelector('.excalidraw canvas');
      const canvasRect = canvas.getBoundingClientRect();

      function analyzeSceneBox(el) {
        // Compute viewport box for element in scene coordinates
        const zoom = appState.zoom.value;
        const screenX = (el.x + appState.scrollX) * zoom + canvasRect.left;
        const screenY = (el.y + appState.scrollY) * zoom + canvasRect.top;
        const screenW = el.width * zoom;
        const screenH = el.height * zoom;

        const baseline = el.baseline || 18;
        const glyphH = Math.floor((baseline - 1) * zoom);
        const glyphData = ctx.getImageData(
          Math.floor(screenX),
          Math.floor(screenY),
          Math.floor(screenW),
          glyphH
        ).data;

        let blueGlyphs = 0;
        let darkGlyphs = 0;
        let redGlyphs = 0;

        for (let i = 0; i < glyphData.length; i += 4) {
          const r = glyphData[i];
          const g = glyphData[i+1];
          const b = glyphData[i+2];
          const a = glyphData[i+3];
          if (a < 50) continue;
          if (b > 180 && g > 120 && b > r + 35) blueGlyphs++;
          else if (r < 70 && g < 70 && b < 70) darkGlyphs++;
          else if (r > 180 && g < 80 && b < 80) redGlyphs++;
        }

        // Underline area: below baseline
        const uTop = Math.floor(screenY + glyphH);
        const uH = Math.ceil((el.height - baseline + 1) * zoom);
        const uData = ctx.getImageData(
          Math.floor(screenX),
          uTop,
          Math.floor(screenW),
          uH
        ).data;

        let blueUnderline = 0;
        for (let i = 0; i < uData.length; i += 4) {
          const r = uData[i];
          const g = uData[i+1];
          const b = uData[i+2];
          const a = uData[i+3];
          if (a < 50) continue;
          if (b > 180 && g > 120 && b > r + 35) blueUnderline++;
        }

        return { id: el.id, blueGlyphs, darkGlyphs, redGlyphs, blueUnderline };
      }

      const elements = api.getSceneElements();
      const blackEl = elements.find(e => e.id === 'url-black');
      const redEl = elements.find(e => e.id === 'url-red');
      const hiddenEl = elements.find(e => e.id === 'url-hidden');
      const semiEl = elements.find(e => e.id === 'url-semi');
      const underRectEl = elements.find(e => e.id === 'url-under-rect');
      const aboveRectEl = elements.find(e => e.id === 'url-above-rect');
      const underImgEl = elements.find(e => e.id === 'url-under-img');
      const elCornerEl = elements.find(e => e.id === 'url-ellipse-corner');
      const elCenterEl = elements.find(e => e.id === 'url-ellipse-center');
      const diaCornerEl = elements.find(e => e.id === 'url-diamond-corner');
      const diaCenterEl = elements.find(e => e.id === 'url-diamond-center');
      const transEl = elements.find(e => e.id === 'url-under-translucent');
      const hachureEl = elements.find(e => e.id === 'url-under-hachure');
      const rotCoveredEl = elements.find(e => e.id === 'url-rot-covered');
      const satEl = elements.find(e => e.id === 'url-sat');

      return {
        black: analyzeSceneBox(blackEl),
        red: analyzeSceneBox(redEl),
        hidden: analyzeSceneBox(hiddenEl),
        semi: analyzeSceneBox(semiEl),
        underRect: analyzeSceneBox(underRectEl),
        aboveRect: analyzeSceneBox(aboveRectEl),
        underImg: analyzeSceneBox(underImgEl),
        elCorner: analyzeSceneBox(elCornerEl),
        elCenter: analyzeSceneBox(elCenterEl),
        diaCorner: analyzeSceneBox(diaCornerEl),
        diaCenter: analyzeSceneBox(diaCenterEl),
        translucent: analyzeSceneBox(transEl),
        hachure: analyzeSceneBox(hachureEl),
        rotCovered: analyzeSceneBox(rotCoveredEl),
        sat: analyzeSceneBox(satEl),
      };
    })()
  `);

  assert(!pixelAnalysis.error, 'Pixel analysis completed without errors');
  console.log('Pixel results for url-black:      ', pixelAnalysis.black);
  console.log('Pixel results for url-red:        ', pixelAnalysis.red);
  console.log('Pixel results for url-hidden:     ', pixelAnalysis.hidden);
  console.log('Pixel results for url-semi:       ', pixelAnalysis.semi);
  console.log('Pixel results for url-under-rect: ', pixelAnalysis.underRect);
  console.log('Pixel results for url-above-rect: ', pixelAnalysis.aboveRect);
  console.log('Pixel results for url-under-img:  ', pixelAnalysis.underImg);
  console.log('Pixel results for url-el-corner:  ', pixelAnalysis.elCorner);
  console.log('Pixel results for url-el-center:  ', pixelAnalysis.elCenter);
  console.log('Pixel results for url-dia-corner: ', pixelAnalysis.diaCorner);
  console.log('Pixel results for url-dia-center: ', pixelAnalysis.diaCenter);
  console.log('Pixel results for url-translucent:', pixelAnalysis.translucent);
  console.log('Pixel results for url-hachure:    ', pixelAnalysis.hachure);
  console.log('Pixel results for url-rot-covered:', pixelAnalysis.rotCovered);
  console.log('Pixel results for url-sat:        ', pixelAnalysis.sat);

  // Assertions for url-black:
  assert(pixelAnalysis.black.blueGlyphs > 1000, `url-black has visible blue glyphs (${pixelAnalysis.black.blueGlyphs} px > 1000)`);
  assert(pixelAnalysis.black.darkGlyphs === 0, `url-black has NO visible dark/black glyph pixels (${pixelAnalysis.black.darkGlyphs} px === 0)`);
  assert(pixelAnalysis.black.blueUnderline > 50, `url-black has visible blue underline (${pixelAnalysis.black.blueUnderline} px > 50)`);

  // Assertions for url-red:
  assert(pixelAnalysis.red.blueGlyphs > 1000, `url-red has visible blue glyphs (${pixelAnalysis.red.blueGlyphs} px > 1000)`);
  assert(pixelAnalysis.red.redGlyphs === 0, `url-red has NO visible red glyph pixels (${pixelAnalysis.red.redGlyphs} px === 0)`);
  assert(pixelAnalysis.red.blueUnderline > 50, `url-red has visible blue underline (${pixelAnalysis.red.blueUnderline} px > 50)`);

  // -------------------------------------------------------------
  // ASSERTION 2: Opacity & Visibility Checks
  // -------------------------------------------------------------
  console.log('\n--- Assertion 2: Element Opacity & Visibility Behavior ---');
  // Opacity 0 URL:
  assert(pixelAnalysis.hidden.blueGlyphs === 0, 'opacity 0 URL emits NO blue glyph pixels (0 px === 0)');
  assert(pixelAnalysis.hidden.blueUnderline === 0, 'opacity 0 URL emits NO blue underline pixels (0 px === 0)');
  const hiddenInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/hidden"))');
  assert(!hiddenInOverlay, 'opacity 0 URL is not rendered in DOM overlay');

  // Opacity 50 URL:
  assert(pixelAnalysis.semi.blueGlyphs > 300, 'opacity 50 URL emits visible blue glyph pixels');
  const semiOverlayOpacity = await evalInPage(`
    (() => {
      const wrappers = document.querySelectorAll('[data-testid="url-text-underlines"] > div > div');
      for (const w of wrappers) {
        if (w.textContent.includes('https://example.com/semi')) {
          return w.style.opacity;
        }
      }
      return null;
    })()
  `);
  assert(semiOverlayOpacity === '0.5', `opacity 50 URL sets CSS opacity 0.5 on overlay wrapper (actual: ${semiOverlayOpacity})`);

  // -------------------------------------------------------------
  // ASSERTION 3: Occlusion & Stacking Order Checks
  // -------------------------------------------------------------
  console.log('\n--- Assertion 3: Stacking Order & Occlusion Behavior ---');
  // URL below filled opaque rectangle:
  assert(pixelAnalysis.underRect.blueGlyphs === 0, 'URL below opaque filled rectangle is completely occluded (0 blue glyph px)');
  assert(pixelAnalysis.underRect.blueUnderline === 0, 'URL below opaque filled rectangle emits 0 blue underline px');
  const underRectInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/under-rect"))');
  assert(!underRectInOverlay, 'URL below opaque rectangle is excluded from DOM overlay');

  // URL below image:
  assert(pixelAnalysis.underImg.blueGlyphs === 0, 'URL below image is completely occluded (0 blue glyph px)');
  assert(pixelAnalysis.underImg.blueUnderline === 0, 'URL below image emits 0 blue underline px');

  // URL above filled opaque rectangle:
  assert(pixelAnalysis.aboveRect.blueGlyphs > 1000, 'URL above filled opaque rectangle remains fully visible (> 1000 blue glyph px)');
  assert(pixelAnalysis.aboveRect.blueUnderline > 50, 'URL above filled opaque rectangle renders visible blue underline (> 50 px)');

  // Ellipse silhouette checks (corner visible vs center occluded):
  assert(pixelAnalysis.elCorner.blueGlyphs > 10, 'URL in empty corner of ellipse bounding box remains visible in blue (> 10 px)');
  assert(pixelAnalysis.elCenter.blueGlyphs === 0, 'URL in filled center of ellipse is completely occluded (0 blue glyph px)');
  const elCornerInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/el-corner"))');
  assert(elCornerInOverlay, 'URL in empty corner of ellipse is rendered in DOM overlay');
  const elCenterInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/el-center"))');
  assert(!elCenterInOverlay, 'URL in filled center of ellipse is excluded from DOM overlay');

  // Diamond silhouette checks (corner visible vs center occluded):
  assert(pixelAnalysis.diaCorner.blueGlyphs > 10, 'URL in empty corner of diamond bounding box remains visible in blue (> 10 px)');
  assert(pixelAnalysis.diaCenter.blueGlyphs === 0, 'URL in filled center of diamond is completely occluded (0 blue glyph px)');
  const diaCornerInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/dia-corner"))');
  assert(diaCornerInOverlay, 'URL in empty corner of diamond is rendered in DOM overlay');
  const diaCenterInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/dia-center"))');
  assert(!diaCenterInOverlay, 'URL in filled center of diamond is excluded from DOM overlay');

  // Translucent (opacity: 50) and patterned (fillStyle: hachure) pass-through checks:
  assert(pixelAnalysis.translucent.blueGlyphs > 500, 'URL under translucent rectangle (opacity: 50) remains visible in blue');
  const transInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/translucent"))');
  assert(transInOverlay, 'URL under translucent rectangle is rendered in DOM overlay');

  assert(pixelAnalysis.hachure.blueGlyphs > 500, 'URL under patterned rectangle (fillStyle: hachure) remains visible in blue');
  const hachureInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/hachure"))');
  assert(hachureInOverlay, 'URL under patterned rectangle is rendered in DOM overlay');

  // Rotated URL completely covered by unrotated opaque rectangle:
  assert(pixelAnalysis.rotCovered.blueGlyphs === 0, 'Rotated URL completely covered by unrotated opaque rect is occluded (0 blue glyph px)');
  const rotCoveredInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/rot-covered"))');
  assert(!rotCoveredInOverlay, 'Rotated URL completely covered by unrotated opaque rect is excluded from DOM overlay');

  // Rotated cover over URL (SAT overlap check & SVG mask cutout):
  assert(pixelAnalysis.sat.blueGlyphs > 200, 'URL with SAT rotated cover retains visible blue glyphs in uncovered portion');
  const satInOverlay = await evalInPage('Boolean(document.querySelector(\'[data-testid="url-text-underlines"]\').innerHTML.includes("https://example.com/sat-url"))');
  assert(satInOverlay, 'URL with SAT rotated cover is present in DOM overlay');
  const satMaskCheck = await evalInPage(`
    (() => {
      const mask = document.querySelector('#url-mask-url-sat');
      if (!mask) return false;
      const rect = mask.querySelector('rect[transform*="rotate"]');
      return Boolean(rect);
    })()
  `);
  assert(satMaskCheck, 'URL overlay has SVG mask with rotated cutout representing the overlapping cover');

  // -------------------------------------------------------------
  // ASSERTION 4: Actual Server Persistence & Stored Scene Colors
  // -------------------------------------------------------------
  console.log('\n--- Assertion 4: Actual Server Persistence Fidelity ---');
  const getDocRes = await fetch(`${BASE_URL}/api/documents/${docId}`, {
    headers: { Cookie: `pew_session=${sessionCookie}` },
  });
  assert(getDocRes.ok, `Fetched document from GET /api/documents/${docId}`);
  const persistedDoc = await getDocRes.json();
  const persistedElements = persistedDoc.scene?.elements || [];
  const persistedBlack = persistedElements.find((e) => e.id === 'url-black');
  const persistedRed = persistedElements.find((e) => e.id === 'url-red');

  assert(Boolean(persistedBlack), 'persisted scene contains url-black');
  assert(persistedBlack.strokeColor === '#1e1e1e', `persisted url-black strokeColor is #1e1e1e (NOT substituted with #4dabf7)`);
  assert(!persistedBlack.customData?.urlAuto, `persisted url-black has no legacy urlAuto marker`);

  assert(Boolean(persistedRed), 'persisted scene contains url-red');
  assert(persistedRed.strokeColor === '#e03131', `persisted url-red strokeColor is #e03131 (imported colour preserved untouched)`);
  assert(!persistedRed.customData?.urlAuto, `persisted url-red has no legacy urlAuto marker`);

  // -------------------------------------------------------------
  // ASSERTION 5: Native Undo/Redo & Exact Stored Color Restoration
  // -------------------------------------------------------------
  console.log('\n--- Assertion 5: Native Undo/Redo & History Restoration ---');

  // Step 5.1: Change url-black color to explicit red (#e03131)
  await evalInPage(`
    (() => {
      const api = window.__excalidrawAPI;
      api.updateScene({
        elements: api.getSceneElements().map(e => e.id === "url-black" ? { ...e, strokeColor: "#e03131", version: e.version + 1, versionNonce: 3001 } : e),
        captureUpdate: "IMMEDIATELY",
      });
    })()
  `);
  await sleep(150);
  const colorStep1 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorStep1 === '#e03131', 'Step 1: url-black stored color updated to #e03131');

  // Step 5.2: Change url-black color to explicit blue (#4dabf7)
  await evalInPage(`
    (() => {
      const api = window.__excalidrawAPI;
      api.updateScene({
        elements: api.getSceneElements().map(e => e.id === "url-black" ? { ...e, strokeColor: "#4dabf7", version: e.version + 1, versionNonce: 4001 } : e),
        captureUpdate: "IMMEDIATELY",
      });
    })()
  `);
  await sleep(150);
  const colorStep2 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorStep2 === '#4dabf7', 'Step 2: url-black stored color updated to explicit blue #4dabf7');

  // Step 5.3: Change url-black color to green (#2f9e44)
  await evalInPage(`
    (() => {
      const api = window.__excalidrawAPI;
      api.updateScene({
        elements: api.getSceneElements().map(e => e.id === "url-black" ? { ...e, strokeColor: "#2f9e44", version: e.version + 1, versionNonce: 5001 } : e),
        captureUpdate: "IMMEDIATELY",
      });
    })()
  `);
  await sleep(150);
  const colorStep3 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorStep3 === '#2f9e44', 'Step 3: url-black stored color updated to green #2f9e44');

  // Step 5.4: Native Undo 1 (back to explicit blue #4dabf7)
  await evalInPage('document.querySelector(\'[data-testid="button-undo"]\').click()');
  await sleep(150);
  const colorUndo1 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorUndo1 === '#4dabf7', 'Step 4: Undo restored stored color to explicit blue #4dabf7');

  // Step 5.5: Wait for debounce save & verify server persistence
  let serverEl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const getDocUndoRes = await fetch(`${BASE_URL}/api/documents/${docId}`, {
      headers: { Cookie: `pew_session=${sessionCookie}` },
    });
    if (getDocUndoRes.ok) {
      const docUndoData = await getDocUndoRes.json();
      serverEl = docUndoData.scene?.elements?.find((e) => e.id === 'url-black');
      if (serverEl?.strokeColor === '#4dabf7') break;
    }
  }
  assert(serverEl?.strokeColor === '#4dabf7', `Step 5: Server database persisted stored color #4dabf7 after undo (actual: ${serverEl?.strokeColor})`);

  // Step 5.6: Native Undo 2 (back to red #e03131)
  await evalInPage('document.querySelector(\'[data-testid="button-undo"]\').click()');
  await sleep(150);
  const colorUndo2 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorUndo2 === '#e03131', 'Step 6: Undo restored stored color to red #e03131');

  // Step 5.7: Native Undo 3 (back to default #1e1e1e)
  await evalInPage('document.querySelector(\'[data-testid="button-undo"]\').click()');
  await sleep(150);
  const colorUndo3 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorUndo3 === '#1e1e1e', 'Step 7: Undo restored stored color to initial #1e1e1e');

  // Step 5.8: Native Redo 1 (forward to red #e03131)
  await evalInPage('document.querySelector(\'[data-testid="button-redo"]\').click()');
  await sleep(150);
  const colorRedo1 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorRedo1 === '#e03131', 'Step 8: Redo restored stored color to red #e03131');

  // Step 5.9: Native Redo 2 (forward to explicit blue #4dabf7)
  await evalInPage('document.querySelector(\'[data-testid="button-redo"]\').click()');
  await sleep(150);
  const colorRedo2 = await evalInPage('window.__excalidrawAPI.getSceneElements().find(e => e.id === "url-black").strokeColor');
  assert(colorRedo2 === '#4dabf7', 'Step 9: Redo restored stored color to explicit blue #4dabf7');

  // -------------------------------------------------------------
  // ASSERTION 6: URL -> Ordinary Text -> URL Editing Transitions
  // -------------------------------------------------------------
  console.log('\n--- Assertion 6: URL <-> Ordinary Text Editing Transition ---');
  // Transition url-red to ordinary text:
  const overlayCountBeforeEdit = await evalInPage('document.querySelectorAll(\'[data-testid="url-text-underlines"] > div > div\').length');
  await evalInPage(`
    (() => {
      const api = window.__excalidrawAPI;
      api.updateScene({
        elements: api.getSceneElements().map(e => e.id === "url-red" ? { ...e, text: "ordinary description text", originalText: "ordinary description text", version: e.version + 1, versionNonce: 6001 } : e),
        captureUpdate: "IMMEDIATELY",
      });
    })()
  `);
  await sleep(200);

  const overlayCountAfterEdit = await evalInPage('document.querySelectorAll(\'[data-testid="url-text-underlines"] > div > div\').length');
  assert(overlayCountAfterEdit === overlayCountBeforeEdit - 1, `Overlay item count reduced from ${overlayCountBeforeEdit} to ${overlayCountAfterEdit} (ordinary text has no overlay)`);

  // Transition back to URL:
  await evalInPage(`
    (() => {
      const api = window.__excalidrawAPI;
      api.updateScene({
        elements: api.getSceneElements().map(e => e.id === "url-red" ? { ...e, text: "https://example.com/back", originalText: "https://example.com/back", version: e.version + 1, versionNonce: 7001 } : e),
        captureUpdate: "IMMEDIATELY",
      });
    })()
  `);
  await sleep(200);

  const overlayCountRestored = await evalInPage('document.querySelectorAll(\'[data-testid="url-text-underlines"] > div > div\').length');
  assert(overlayCountRestored === overlayCountBeforeEdit, `Overlay item count restored to ${overlayCountBeforeEdit} when text becomes URL again`);

  // -------------------------------------------------------------
  // ASSERTION 7: Scroll, Zoom, and Rotation Alignment
  // -------------------------------------------------------------
  console.log('\n--- Assertion 7: Zoom, Pan, and Rotation Alignment ---');
  await evalInPage(`
    (() => {
      const api = window.__excalidrawAPI;
      api.updateScene({
        appState: { zoom: { value: 1.5 }, scrollX: 60, scrollY: 45 },
      });
    })()
  `);
  await sleep(200);

  const containerTransform = await evalInPage('document.querySelector(\'[data-testid="url-text-underlines"] > div\').style.transform');
  assert(containerTransform.includes('scale(1.5)') && containerTransform.includes('60px') && containerTransform.includes('45px'),
    `Overlay container transform accurately mirrors scene zoom and scroll (${containerTransform})`);

  // Test rotation transform on element
  await evalInPage(`
    (() => {
      const api = window.__excalidrawAPI;
      api.updateScene({
        elements: api.getSceneElements().map(e => e.id === "url-black" ? { ...e, angle: 0.35, version: e.version + 1, versionNonce: 8001 } : e),
        captureUpdate: "IMMEDIATELY",
      });
    })()
  `);
  await sleep(200);

  const rotatedTransform = await evalInPage(`
    (() => {
      const wrappers = document.querySelectorAll('[data-testid="url-text-underlines"] > div > div');
      for (const w of wrappers) {
        if (w.textContent.includes('https://example.com/black')) {
          return w.style.transform;
        }
      }
      return '';
    })()
  `);
  assert(rotatedTransform.includes('rotate(0.35rad)'), `Rotated element overlay has transform: rotate(0.35rad)`);

  // -------------------------------------------------------------
  // ASSERTION 8: Ctrl/Cmd+click Interaction & Occlusion Fencing
  // -------------------------------------------------------------
  console.log('\n--- Assertion 8: Ctrl/Cmd+click Interaction & Occlusion Fencing ---');
  await evalInPage(`
    (() => {
      window.__openedUrls = [];
      window.open = (url, target, features) => {
        window.__openedUrls.push({ url, target, features });
        return null;
      };

      const api = window.__excalidrawAPI;
      api.updateScene({
        appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 },
      });

      window.__dispatchCtrlClick = (sceneX, sceneY) => {
        const api = window.__excalidrawAPI;
        const appState = api.getAppState();
        const canvas = document.querySelector('.excalidraw canvas');
        const rect = canvas.getBoundingClientRect();
        const zoom = appState.zoom.value;
        const clientX = (sceneX + appState.scrollX) * zoom + rect.left;
        const clientY = (sceneY + appState.scrollY) * zoom + rect.top;

        const evt = new PointerEvent('pointerdown', {
          clientX,
          clientY,
          button: 0,
          ctrlKey: true,
          bubbles: true,
        });
        canvas.dispatchEvent(evt);
      };
    })()
  `);
  await sleep(150);

  // 8.1: Click unoccluded URL (url-black):
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(230, 115);');
  await sleep(150);
  const openedBlack = await evalInPage('window.__openedUrls');
  assert(openedBlack.length === 1 && openedBlack[0]?.url === 'https://example.com/black', 'Ctrl+click on unoccluded URL opens destination');

  // 8.2: Click hidden URL (opacity 0):
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(230, 315);');
  await sleep(150);
  const openedHidden = await evalInPage('window.__openedUrls');
  assert(openedHidden.length === 0, 'Ctrl+click on opacity 0 URL does NOT open (hidden text cannot navigate)');

  // 8.3: Click URL covered by opaque rectangle (url-under-rect):
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(230, 515);');
  await sleep(150);
  const openedUnderRect = await evalInPage('window.__openedUrls');
  assert(openedUnderRect.length === 0, 'Ctrl+click on URL covered by opaque rectangle does NOT punch through');

  // 8.4: Click URL covered by image (url-under-img):
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(230, 715);');
  await sleep(150);
  const openedUnderImg = await evalInPage('window.__openedUrls');
  assert(openedUnderImg.length === 0, 'Ctrl+click on URL covered by image does NOT punch through');

  // 8.5: Click URL stacked ABOVE opaque rectangle (url-above-rect):
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(230, 615);');
  await sleep(150);
  const openedAboveRect = await evalInPage('window.__openedUrls');
  assert(openedAboveRect.length === 1 && openedAboveRect[0]?.url === 'https://example.com/above-rect', 'Ctrl+click on URL stacked ABOVE opaque rectangle opens link');

  // 8.6: Click URL in empty corner of ellipse bounding box:
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(480, 65);');
  await sleep(150);
  const openedElCorner = await evalInPage('window.__openedUrls');
  assert(openedElCorner.length === 1 && openedElCorner[0]?.url === 'https://example.com/el-corner', 'Ctrl+click on URL in empty corner of ellipse opens destination');

  // 8.7: Click URL covered by filled ellipse center:
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(600, 200);');
  await sleep(150);
  const openedElCenter = await evalInPage('window.__openedUrls');
  assert(openedElCenter.length === 0, 'Ctrl+click on URL covered by filled ellipse center is blocked');

  // 8.8: Click URL in empty corner of diamond bounding box:
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(480, 415);');
  await sleep(150);
  const openedDiaCorner = await evalInPage('window.__openedUrls');
  assert(openedDiaCorner.length === 1 && openedDiaCorner[0]?.url === 'https://example.com/dia-corner', 'Ctrl+click on URL in empty corner of diamond opens destination');

  // 8.9: Click URL covered by filled diamond center:
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(600, 550);');
  await sleep(150);
  const openedDiaCenter = await evalInPage('window.__openedUrls');
  assert(openedDiaCenter.length === 0, 'Ctrl+click on URL covered by filled diamond center is blocked');

  // 8.10: Click URL under translucent rectangle (opacity: 50):
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(230, 815);');
  await sleep(150);
  const openedTrans = await evalInPage('window.__openedUrls');
  assert(openedTrans.length === 1 && openedTrans[0]?.url === 'https://example.com/translucent', 'Ctrl+click on URL under translucent rectangle opens link');

  // 8.11: Click URL under patterned rectangle (fillStyle: hachure):
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(230, 915);');
  await sleep(150);
  const openedHachure = await evalInPage('window.__openedUrls');
  assert(openedHachure.length === 1 && openedHachure[0]?.url === 'https://example.com/hachure', 'Ctrl+click on URL under patterned rectangle opens link');

  // 8.12: Click rotated URL covered by unrotated opaque rectangle:
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(190, 1015);');
  await sleep(150);
  const openedRotCovered = await evalInPage('window.__openedUrls');
  assert(openedRotCovered.length === 0, 'Ctrl+click on rotated URL covered by unrotated opaque rectangle is blocked');

  // 8.13: Click URL with SAT rotated cover at covered overlap point:
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(295, 1125);');
  await sleep(150);
  const openedSatCovered = await evalInPage('window.__openedUrls');
  assert(openedSatCovered.length === 0, 'Ctrl+click at SAT-detected overlap point on URL is blocked by rotated cover');

  // 8.14: Click URL with SAT rotated cover at uncovered point:
  await evalInPage('window.__openedUrls = []; window.__dispatchCtrlClick(200, 1125);');
  await sleep(150);
  const openedSatUncovered = await evalInPage('window.__openedUrls');
  assert(openedSatUncovered.length === 1 && openedSatUncovered[0]?.url === 'https://example.com/sat-url', 'Ctrl+click at uncovered point on URL with rotated cover opens destination');

  // -------------------------------------------------------------
  // ASSERTION 9: Production Isolation Gate
  // -------------------------------------------------------------
  console.log('\n--- Assertion 9: Production Isolation Gate ---');
  // Navigate WITHOUT ?e2e=true opt-in
  await cdp('Page.navigate', { url: `${BASE_URL}/documents/${docId}` });
  for (let i = 0; i < 60; i++) {
    const canvasReady = await evalInPage('Boolean(document.querySelector(".excalidraw canvas"))');
    if (canvasReady) break;
    await sleep(250);
  }
  await sleep(500);

  const prodLeakCheck = await evalInPage(`
    ({
      apiLeaked: typeof window.__excalidrawAPI !== 'undefined',
      sceneLeaked: typeof window.__lastSavedScene !== 'undefined',
    })
  `);
  assert(!prodLeakCheck.apiLeaked, 'window.__excalidrawAPI is NOT exposed in normal runtime (no e2e flag)');
  assert(!prodLeakCheck.sceneLeaked, 'window.__lastSavedScene is NOT exposed in normal runtime (no e2e flag)');

  // -------------------------------------------------------------
  // WRITE EVIDENCE FILE
  // -------------------------------------------------------------
  console.log('\n[6/7] Writing evidence artifact...');
  const evidence = {
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      browser: 'Chrome/155 Headless',
      ports: { testPort: TEST_PORT, cdpPort: CDP_PORT },
    },
    verificationSummary: {
      status: 'VERIFIED_SOUND',
      assertionsPassed: passedCount,
      assertionsFailed: 0,
      visualPixelCheck: {
        urlBlack: pixelAnalysis.black,
        urlRed: pixelAnalysis.red,
        urlHidden: pixelAnalysis.hidden,
        urlSemi: pixelAnalysis.semi,
        urlUnderRect: pixelAnalysis.underRect,
        urlAboveRect: pixelAnalysis.aboveRect,
        urlUnderImg: pixelAnalysis.underImg,
        urlElCorner: pixelAnalysis.elCorner,
        urlElCenter: pixelAnalysis.elCenter,
        urlDiaCorner: pixelAnalysis.diaCorner,
        urlDiaCenter: pixelAnalysis.diaCenter,
        urlTranslucent: pixelAnalysis.translucent,
        urlHachure: pixelAnalysis.hachure,
        urlRotCovered: pixelAnalysis.rotCovered,
        urlSat: pixelAnalysis.sat,
      },
      opacityCheck: {
        opacityZeroEmitsNoOverlay: true,
        opacityZeroCannotOpen: true,
        opacityFiftyRespected: semiOverlayOpacity === '0.5',
      },
      occlusionCheck: {
        urlBelowOpaqueRectHidden: true,
        urlBelowImageHidden: true,
        urlAboveOpaqueRectVisible: true,
        ellipseCornerVisible: true,
        ellipseCenterOccluded: true,
        diamondCornerVisible: true,
        diamondCenterOccluded: true,
        translucentShapePassesThrough: true,
        patternedShapePassesThrough: true,
        rotatedUrlCoveredByRectHidden: true,
        satOverlapDetectedAndCutout: true,
        ctrlClickBlockedByCoveringContent: true,
        ctrlClickAllowedOnTopmostUrl: true,
      },
      persistenceCheck: {
        persistedBlackStrokeColor: persistedBlack.strokeColor,
        persistedRedStrokeColor: persistedRed.strokeColor,
        cleanStoredCustomData: true,
      },
      historyCheck: {
        initialColor: '#1e1e1e',
        userColorRed: '#e03131',
        userColorBlue: '#4dabf7',
        undo1ToBlue: colorUndo1,
        serverPersistedAfterUndo: serverEl?.strokeColor,
        undo2ToRed: colorUndo2,
        undo3ToInitial: colorUndo3,
        redo1ToRed: colorRedo1,
        redo2ToBlue: colorRedo2,
      },
      transitionsCheck: {
        urlToOrdinaryRemovesOverlay: true,
        ordinaryToUrlRestoresOverlay: true,
      },
      transformsCheck: {
        zoomAndScrollSynced: true,
        elementRotationSynced: true,
      },
      productionIsolationCheck: {
        globalsExposedWithoutE2E: false,
      },
    },
  };

  const evidencePath = path.resolve('docs/project/evidence/url_history_evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`Saved evidence to: ${evidencePath}`);

  console.log('\n===========================================================');
  console.log(`🎉 ALL ${passedCount} VERIFICATION ASSERTIONS PASSED WITH ZERO ERRORS`);
  console.log('===========================================================');

} catch (err) {
  console.error('\n❌ VERIFICATION HARNESS FAILED:', err);
  process.exitCode = 1;
} finally {
  console.log('\n[7/7] Cleaning up test resources...');
  try { if (ws) ws.close(); } catch {}
  if (chromeProcess?.pid) {
    try {
      spawn('taskkill', ['/pid', String(chromeProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } catch {}
  }
  if (serverProcess?.pid) {
    try {
      spawn('taskkill', ['/pid', String(serverProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } catch {}
  }
  await sleep(1000);
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  try { rmSync(chromeUserDir, { recursive: true, force: true }); } catch {}
  console.log('Cleanup finished.');
}
