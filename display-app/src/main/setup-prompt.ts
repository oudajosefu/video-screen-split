import { BrowserWindow, app, ipcMain } from "electron";

const PROMPT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>video-screen-split — setup</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 24px; background: #0c0d10; color: #e7e9ee;
    font-family: -apple-system, "Segoe UI", "SF Pro Text", Roboto, sans-serif;
    font-size: 14px; line-height: 1.5;
  }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p { color: #8b8f9a; margin: 0 0 16px; font-size: 13px; }
  label { display: block; font-size: 12px; color: #8b8f9a; margin-bottom: 6px; }
  input {
    width: 100%; box-sizing: border-box;
    background: #1d2027; color: #e7e9ee;
    border: 1px solid #2a2e38; border-radius: 8px;
    padding: 10px 12px; font: inherit;
  }
  input:focus { outline: 2px solid #6aa6ff; border-color: transparent; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button {
    background: #1d2027; color: #e7e9ee;
    border: 1px solid #2a2e38; border-radius: 8px;
    padding: 8px 16px; font: inherit; cursor: pointer;
  }
  button.primary { background: #6aa6ff; border-color: #6aa6ff; color: #0c0d10; font-weight: 600; }
  button:hover { filter: brightness(1.1); }
  .err { color: #ff6a6a; font-size: 12px; margin-top: 8px; min-height: 16px; }
  .hint { color: #8b8f9a; font-size: 11px; margin-top: 8px; }
  code { background: #1d2027; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; }
</style>
</head><body>
<h1>Connect to coordinator</h1>
<p>Enter the WebSocket URL of the coordinator running on the host machine.</p>
<label for="url">Coordinator URL</label>
<input id="url" type="text" placeholder="ws://192.168.x.x:8787/ws" autofocus>
<div class="err" id="err"></div>
<p class="hint">Examples: <code>ws://localhost:8787/ws</code> on the same machine, or <code>ws://&lt;host-ip&gt;:8787/ws</code> across the LAN.</p>
<div class="row">
  <button id="quit">Quit</button>
  <button id="connect" class="primary">Connect</button>
</div>
<script>
  const { ipcRenderer } = require('electron');
  const input = document.getElementById('url');
  const err = document.getElementById('err');
  const connectBtn = document.getElementById('connect');
  const quitBtn = document.getElementById('quit');

  ipcRenderer.invoke('setup:get-default').then((d) => {
    if (d) input.value = d;
  });

  function submit() {
    const url = input.value.trim();
    if (!/^wss?:\\/\\//.test(url)) {
      err.textContent = 'URL must start with ws:// or wss://';
      return;
    }
    ipcRenderer.send('setup:submit', url);
  }

  connectBtn.addEventListener('click', submit);
  quitBtn.addEventListener('click', () => ipcRenderer.send('setup:quit'));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  ipcRenderer.on('setup:error', (_e, msg) => {
    err.textContent = msg;
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  });
</script>
</body></html>`;

export async function promptForCoordinatorUrl(defaultUrl?: string): Promise<string> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 500,
      height: 340,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "video-screen-split — setup",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const handleGet = (): string | undefined => defaultUrl;
    ipcMain.handle("setup:get-default", handleGet);

    const cleanup = () => {
      ipcMain.removeHandler("setup:get-default");
      ipcMain.removeAllListeners("setup:submit");
      ipcMain.removeAllListeners("setup:quit");
    };

    ipcMain.on("setup:submit", (_e, url: string) => {
      cleanup();
      win.close();
      resolve(url);
    });

    ipcMain.on("setup:quit", () => {
      cleanup();
      app.exit(0);
    });

    win.on("closed", () => cleanup());

    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(PROMPT_HTML)}`,
    );
  });
}
