export const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>acpx-node-daemon</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'Cascadia Code', 'Fira Code', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 13px; height: 100vh; display: flex; flex-direction: column;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d;
    padding: 8px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0;
  }
  header h1 { font-size: 14px; font-weight: 600; color: #58a6ff; }
  header .status {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: #1f6feb33; color: #58a6ff;
  }
  header .status.disconnected { background: #da363333; color: #f85149; }
  header .spacer { flex: 1; }
  header .meta { font-size: 11px; color: #8b949e; }

  nav {
    background: #161b22; border-bottom: 1px solid #30363d;
    padding: 4px 16px; display: flex; gap: 4px; flex-shrink: 0; overflow-x: auto;
  }
  .tab {
    background: transparent; border: 1px solid transparent; border-radius: 6px;
    color: #8b949e; font-size: 12px; padding: 4px 12px; cursor: pointer;
    font-family: inherit; display: flex; align-items: center; gap: 6px;
    white-space: nowrap;
  }
  .tab:hover { background: #21262d; color: #c9d1d9; }
  .tab.active { background: #21262d; color: #c9d1d9; border-color: #30363d; }
  .tab .dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  }
  .dot.idle { background: #3fb950; }
  .dot.busy { background: #d29922; animation: pulse 1.5s infinite; }
  .dot.closed { background: #8b949e; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  main { flex: 1; overflow: hidden; position: relative; }
  #output {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    overflow-y: auto; padding: 12px 16px;
    white-space: pre-wrap; word-wrap: break-word; line-height: 1.5;
  }
  #output .line { min-height: 1em; }
  #output .line.hidden { display: none; }

  footer {
    background: #161b22; border-top: 1px solid #30363d;
    padding: 4px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0;
    font-size: 11px; color: #8b949e;
  }
  footer button {
    background: #21262d; border: 1px solid #30363d; border-radius: 4px;
    color: #8b949e; font-size: 11px; padding: 2px 8px; cursor: pointer;
    font-family: inherit;
  }
  footer button:hover { color: #c9d1d9; border-color: #58a6ff; }
  footer button.active { color: #58a6ff; border-color: #58a6ff; }

  .ansi-bold { font-weight: bold; }
  .ansi-dim { opacity: 0.6; }
  .ansi-red { color: #ff7b72; }
  .ansi-green { color: #56d364; }
  .ansi-yellow { color: #e3b341; }
  .ansi-blue { color: #79c0ff; }
  .ansi-magenta { color: #d2a8ff; }
  .ansi-cyan { color: #76e3ea; }

  .reconnecting {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 20px 32px; font-size: 14px; color: #f85149; display: none;
    z-index: 100;
  }
  .reconnecting.show { display: block; }
</style>
</head>
<body>

<header>
  <h1>acpx-node-daemon</h1>
  <span class="status" id="conn-status">connecting</span>
  <span class="spacer"></span>
  <span class="meta" id="session-count">0 sessions</span>
</header>

<nav id="tabs">
  <button class="tab active" data-session="all">All Sessions</button>
</nav>

<main>
  <div id="output"></div>
</main>

<footer>
  <span id="line-count">0 lines</span>
  <span class="spacer" style="flex:1"></span>
  <button id="scroll-lock" onclick="toggleScrollLock()">Auto-scroll: ON</button>
  <button onclick="clearOutput()">Clear</button>
</footer>

<div class="reconnecting" id="reconnecting">Reconnecting...</div>

<script>
const output = document.getElementById('output');
const connStatus = document.getElementById('conn-status');
const sessionCount = document.getElementById('session-count');
const lineCountEl = document.getElementById('line-count');
const tabsEl = document.getElementById('tabs');
const reconnectingEl = document.getElementById('reconnecting');

let autoScroll = true;
let activeSession = 'all';
let lineCount = 0;
let sessions = {};
let es = null;

let seenLines = new Set();
let pollCount = 0;

function connect() {
  connStatus.textContent = 'polling';
  connStatus.className = 'status';
  reconnectingEl.classList.remove('show');
  setInterval(poll, 1000);
  poll();
}

async function poll() {
  try {
    pollCount++;
    const res = await fetch('/api/poll?since=0&_=' + Date.now());
    const data = await res.json();

    if (data.sessions) updateSessions(data.sessions);

    let newCount = 0;
    for (const item of data.lines) {
      const key = item.sessionId + ':' + item.idx;
      if (seenLines.has(key)) continue;
      seenLines.add(key);
      appendLine(item.sessionId, item.text);
      newCount++;
    }

    connStatus.textContent = 'connected (poll #' + pollCount + ', ' + seenLines.size + ' lines)';
    connStatus.className = 'status';
  } catch {
    connStatus.textContent = 'poll error #' + pollCount;
    connStatus.className = 'status disconnected';
  }
}

function appendLine(sessionId, text, isReplay) {
  if (!text && !isReplay) return;
  const div = document.createElement('div');
  div.className = 'line';
  div.dataset.session = sessionId;
  const rendered = ansiToHtml(text || '');
  div.innerHTML = rendered || escapeHtml(text || '');
  if (activeSession !== 'all' && activeSession !== sessionId) {
    div.classList.add('hidden');
  }
  output.appendChild(div);
  lineCount++;
  lineCountEl.textContent = lineCount + ' lines';

  // Track session
  if (!sessions[sessionId]) {
    sessions[sessionId] = { status: 'busy', lines: 0 };
    rebuildTabs();
  }
  sessions[sessionId].lines++;

  if (autoScroll && !isReplay) scrollToBottom();

  // Limit DOM nodes
  while (output.children.length > 5000) {
    output.removeChild(output.firstChild);
  }
}

function scrollToBottom() {
  output.scrollTop = output.scrollHeight;
}

function toggleScrollLock() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('scroll-lock');
  btn.textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
  btn.classList.toggle('active', autoScroll);
  if (autoScroll) scrollToBottom();
}

function clearOutput() {
  output.innerHTML = '';
  lineCount = 0;
  lineCountEl.textContent = '0 lines';
}

function updateSessions(list) {
  // Remove sessions no longer in the list
  const activeIds = new Set(list.map(s => s.id));
  for (const id of Object.keys(sessions)) {
    if (!activeIds.has(id)) {
      delete sessions[id];
      // If we were viewing this session, switch to "all"
      if (activeSession === id) activeSession = 'all';
    }
  }
  for (const s of list) {
    sessions[s.id] = sessions[s.id] || { lines: 0 };
    sessions[s.id].status = s.status;
    sessions[s.id].cwd = s.cwd;
  }
  sessionCount.textContent = list.length + ' session' + (list.length !== 1 ? 's' : '');
  rebuildTabs();
}

function rebuildTabs() {
  const existing = tabsEl.querySelectorAll('.tab:not([data-session="all"])');
  existing.forEach(t => t.remove());
  for (const [id, s] of Object.entries(sessions)) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (activeSession === id ? ' active' : '');
    btn.dataset.session = id;
    const dot = document.createElement('span');
    dot.className = 'dot ' + (s.status || 'busy');
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(id.slice(0, 8)));
    btn.onclick = () => selectSession(id);
    tabsEl.appendChild(btn);
  }
}

function selectSession(id) {
  activeSession = id;
  tabsEl.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.session === id);
  });
  output.querySelectorAll('.line').forEach(line => {
    if (id === 'all' || line.dataset.session === id) {
      line.classList.remove('hidden');
    } else {
      line.classList.add('hidden');
    }
  });
  scrollToBottom();
}

// ANSI to HTML converter
function ansiToHtml(text) {
  if (!text) return '';
  let html = '';
  let openSpans = 0;
  const parts = text.split(/(\\x1b\\[\\d+(?:;\\d+)*m)/);

  for (const part of parts) {
    const match = part.match(/^\\x1b\\[(\\d+(?:;\\d+)*)m$/);
    if (match) {
      const codes = match[1].split(';').map(Number);
      for (const code of codes) {
        if (code === 0) {
          while (openSpans > 0) { html += '</span>'; openSpans--; }
        } else {
          const cls = ansiClass(code);
          if (cls) { html += '<span class="' + cls + '">'; openSpans++; }
        }
      }
    } else {
      html += escapeHtml(part);
    }
  }
  while (openSpans > 0) { html += '</span>'; openSpans--; }
  return html;
}

function ansiClass(code) {
  switch (code) {
    case 1: return 'ansi-bold';
    case 2: return 'ansi-dim';
    case 31: return 'ansi-red';
    case 32: return 'ansi-green';
    case 33: return 'ansi-yellow';
    case 34: return 'ansi-blue';
    case 35: return 'ansi-magenta';
    case 36: return 'ansi-cyan';
    default: return null;
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Start
connect();

// Click handler for All Sessions tab
tabsEl.querySelector('[data-session="all"]').onclick = () => selectSession('all');

// DIAGNOSTIC: manual test button
const diagBtn = document.createElement('button');
diagBtn.textContent = 'Test Poll';
diagBtn.style.cssText = 'position:fixed;bottom:40px;right:10px;z-index:999;padding:8px 16px;background:#1f6feb;color:white;border:none;border-radius:4px;cursor:pointer;font-size:14px;';
diagBtn.onclick = async () => {
  try {
    const r = await fetch('/api/poll?since=0&_=' + Date.now());
    const d = await r.json();
    const msg = 'Poll result: ' + d.lines.length + ' lines, ' + d.sessions.length + ' sessions, total=' + d.total;
    alert(msg);
    // Try appending first line manually
    if (d.lines.length > 0) {
      const div = document.createElement('div');
      div.className = 'line';
      div.textContent = 'MANUAL: ' + d.lines[0].text.slice(0, 100);
      output.appendChild(div);
    }
  } catch (err) {
    alert('Poll error: ' + err.message);
  }
};
document.body.appendChild(diagBtn);
</script>
</body>
</html>`;
