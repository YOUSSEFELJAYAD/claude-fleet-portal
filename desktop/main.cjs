/**
 * Claude Fleet Portal — desktop shell.
 *
 * Boots the SAME stack the source install runs (Fastify control plane + Next.js web),
 * but fully self-contained: the server is an esbuild bundle, the web app is a Next
 * standalone build, both forked from Electron's own Node — no system Node, pnpm, or
 * checkout required. Data lives in the OS user-data dir.
 *
 * Real agent runs need the `claude` CLI on the machine (resolved from the usual install
 * locations — GUI apps don't inherit the shell PATH). Without it, the app falls back to
 * the bundled deterministic mock so the portal is still fully explorable.
 */
const { app, BrowserWindow, utilityProcess, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const WEB_PORT = 4318;
const API_PORT = 4319; // fixed: the web bundle bakes NEXT_PUBLIC_FLEET_API at build time

const children = [];

/** GUI apps get a minimal PATH on macOS/Linux — extend it with the usual install dirs. */
function augmentedPath() {
  const extra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin'),
  ];
  return [process.env.PATH || '', ...extra].filter(Boolean).join(path.delimiter);
}

/** Find the claude CLI; null when not installed (→ mock fallback). */
function resolveClaudeBin(envPath) {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * The mock is a Node script, but a packaged machine may have NO system Node — write a tiny
 * shim that runs it with Electron's own runtime (ELECTRON_RUN_AS_NODE) and use the shim as
 * CLAUDE_BIN (the server spawns CLAUDE_BIN as a plain executable).
 */
function writeMockShim(mockScript) {
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'mock-claude.cmd');
    fs.writeFileSync(shim, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${mockScript}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, 'mock-claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${process.execPath}" "${mockScript}" "$@"\n`, {
    mode: 0o755,
  });
  return shim;
}

function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode != null && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await httpOk(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function fork(scriptPath, { cwd, env }) {
  const child = utilityProcess.fork(scriptPath, [], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  return child;
}

async function bootStack() {
  // If both ports already answer, another portal instance (or a dev stack) is running —
  // don't double-boot, just attach a window to it.
  if ((await httpOk(`http://127.0.0.1:${API_PORT}/api/health`)) && (await httpOk(`http://127.0.0.1:${WEB_PORT}`))) {
    return { attached: true, mock: false };
  }

  // app code (bundle/) lives in the app dir; web/mock payloads ship as extraResources
  const appDir = __dirname;
  const resources = app.isPackaged ? process.resourcesPath : __dirname;
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const PATH = augmentedPath();
  let claudeBin = resolveClaudeBin(PATH);
  let mock = false;
  if (!claudeBin) {
    claudeBin = writeMockShim(path.join(resources, 'mock', 'tools', 'mock-claude.mjs'));
    mock = true;
  }

  fork(path.join(appDir, 'bundle', 'server.cjs'), {
    cwd: resources,
    env: {
      PATH,
      FLEET_DATA_DIR: dataDir,
      FLEET_SERVER_PORT: String(API_PORT),
      FLEET_WEB_PORT: String(WEB_PORT),
      CLAUDE_BIN: claudeBin,
      // release checks in the packaged app: no checkout → version comes from the app's own
      // package.json (FLEET_REPO_ROOT) and updates are checked against the GitHub repo;
      // self-update is impossible (no git), so the popup offers the download page instead.
      FLEET_REPO_ROOT: appDir, // version-stamped package.json ships with the app code
      FLEET_GITHUB_REPO: 'YOUSSEFELJAYAD/claude-fleet-portal',
    },
  });

  const webDir = path.join(resources, 'web', 'apps', 'web');
  fork(path.join(webDir, 'server.js'), {
    cwd: webDir,
    env: { PATH, PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
  });

  const apiUp = await waitFor(`http://127.0.0.1:${API_PORT}/api/health`);
  const webUp = await waitFor(`http://127.0.0.1:${WEB_PORT}`);
  if (!apiUp || !webUp) {
    dialog.showErrorBox(
      'Claude Fleet Portal',
      `The portal failed to start (api: ${apiUp ? 'ok' : 'down'}, web: ${webUp ? 'ok' : 'down'}).`,
    );
    app.quit();
    return { attached: false, mock };
  }
  return { attached: false, mock };
}

function createWindow(mock) {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0a0c10',
    title: 'Claude Fleet Portal',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${WEB_PORT}/`);
  // external links (GitHub releases, PR urls, …) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${WEB_PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  if (mock) {
    win.webContents.once('did-finish-load', () => {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Mock mode',
        message: 'Claude Code CLI not found — running with the free deterministic mock.',
        detail: 'Install Claude Code (https://claude.com/claude-code) and restart the app for real agent runs.',
      });
    });
  }
}

app.whenReady().then(async () => {
  const { mock } = await bootStack();
  createWindow(mock);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(false);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
});
