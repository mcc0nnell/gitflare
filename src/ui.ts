export function gitflareConsoleHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>Gitflare // Source Control Node</title>
  <style>
    :root {
      --bg: #000;
      --fg: #b8b8b8;
      --cyan: #55ffff;
      --green: #55ff55;
      --yellow: #ffff55;
      --red: #ff5555;
      --dim: #8a8a8a;
      --panel: #050505;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg); }
    body {
      min-height: 100vh;
      padding: max(10px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
      font-family: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-variant-ligatures: none;
      line-height: 1.35;
      background:
        radial-gradient(circle at 50% -10%, rgba(85,255,255,.06), transparent 42%),
        #000;
    }
    #console {
      width: min(100%, 80ch);
      min-height: 25em;
      margin: 0 auto;
      padding: 0;
      white-space: pre;
      overflow-x: auto;
      user-select: text;
      font-size: clamp(11px, 2.65vw, 15px);
      text-shadow: 0 0 10px rgba(85,255,255,.09);
    }
    .row { min-height: 1.35em; }
    .cyan { color: var(--cyan); }
    .green { color: var(--green); }
    .yellow { color: var(--yellow); }
    .red { color: var(--red); }
    .dim { color: var(--dim); }
    button.hotspot {
      appearance: none;
      -webkit-appearance: none;
      border: 0;
      border-bottom: 1px dotted currentColor;
      background: transparent;
      color: inherit;
      font: inherit;
      line-height: inherit;
      padding: 0;
      margin: 0;
      cursor: pointer;
      text-align: left;
    }
    button.hotspot:hover,
    button.hotspot:focus-visible {
      color: #fff;
      outline: 1px solid currentColor;
      outline-offset: 1px;
      background: rgba(85,255,255,.08);
    }
    .auth {
      width: min(100%, 80ch);
      margin: 12px auto 0;
      border-top: 1px dotted rgba(85,255,255,.28);
      padding-top: 8px;
      display: flex;
      align-items: center;
      gap: 1ch;
      flex-wrap: wrap;
      font-size: clamp(11px, 2.65vw, 14px);
    }
    .auth label { color: var(--dim); }
    .auth input {
      flex: 1 1 18ch;
      min-width: 12ch;
      background: var(--panel);
      color: var(--green);
      border: 1px solid rgba(85,255,255,.35);
      border-radius: 0;
      padding: 8px;
      font: inherit;
      outline: none;
    }
    .auth input:focus { border-color: var(--cyan); }
    .auth button {
      background: transparent;
      color: var(--cyan);
      border: 1px solid currentColor;
      border-radius: 0;
      padding: 8px 10px;
      font: inherit;
      cursor: pointer;
    }
    .auth button:hover, .auth button:focus-visible { color: #fff; outline: none; }
    .note {
      width: min(100%, 80ch);
      margin: 6px auto 0;
      color: var(--dim);
      font-size: 11px;
      line-height: 1.35;
    }
    @media (max-width: 699px) {
      button.hotspot { min-height: 44px; padding: 13px 1px; margin: -13px -1px; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <main id="console" aria-live="polite" aria-label="Gitflare ANSI source control console"></main>
  <form id="auth" class="auth" autocomplete="off">
    <label for="token">ADMIN TOKEN:</label>
    <input id="token" name="token" type="password" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Gitflare admin token">
    <button type="submit">[CONNECT]</button>
    <button type="button" id="disconnect">[DISCONNECT]</button>
  </form>
  <p class="note">The token stays in this browser session only and is sent as a Bearer credential to the existing Gitflare API. The ANSI surface does not gain Git authority by itself.</p>
  <script>
    (function () {
      'use strict';

      var WIDTH = 80;
      var tokenKey = 'gitflare-admin-token';
      var state = { screen: 'repos', repos: [], health: null, selectedRepo: null, error: null, loading: false };
      var consoleEl = document.getElementById('console');
      var authForm = document.getElementById('auth');
      var tokenInput = document.getElementById('token');
      var disconnect = document.getElementById('disconnect');

      function esc(value) {
        return String(value).replace(/[&<>"']/g, function (ch) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
        });
      }

      function pad(value, width) {
        var text = String(value == null ? '' : value);
        if (text.length > width) text = width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + '~';
        return text + ' '.repeat(Math.max(0, width - text.length));
      }

      function frameTitle(title) {
        var raw = ' ' + title + ' ';
        return '╔' + raw + '═'.repeat(Math.max(0, WIDTH - raw.length - 2)) + '╗';
      }

      function frameRow(value) {
        return '║' + pad(value || '', WIDTH - 2) + '║';
      }

      function divider() { return '╠' + '═'.repeat(WIDTH - 2) + '╣'; }
      function footer() { return '╚' + '═'.repeat(WIDTH - 2) + '╝'; }

      function navHtml() {
        return '<button class="hotspot cyan" data-screen="repos">[R] REPOS</button>  ' +
          '<button class="hotspot cyan" data-screen="changes">[C] CHANGES</button>  ' +
          '<button class="hotspot cyan" data-screen="agents">[A] AGENTS</button>  ' +
          '<button class="hotspot cyan" data-screen="builds">[B] BUILDS</button>  ' +
          '<button class="hotspot cyan" data-screen="graph">[G] GRAPH</button>';
      }

      function rowHtml(text, cls) {
        return '<div class="row' + (cls ? ' ' + cls : '') + '">' + text + '</div>';
      }

      function renderRepos() {
        var rows = [];
        rows.push(rowHtml(esc(frameTitle('GITFLARE // SOURCE CONTROL NODE')), 'cyan'));
        rows.push(rowHtml('║' + navHtml() + esc(pad('', Math.max(0, WIDTH - 2 - 58))) + '║'));
        rows.push(rowHtml(esc(divider())));
        var health = state.health || {};
        rows.push(rowHtml(esc(frameRow('SOURCE: ' + (health.sourcePlane || 'cloudflare-artifacts') + '   NAMESPACE: ' + (health.namespace || 'gitflare')))));
        rows.push(rowHtml(esc(frameRow('HEALTH: ' + (health.ok ? 'ONLINE' : 'UNKNOWN') + '   MODE: THIN FORGE / STANDARD GIT'))), health.ok ? 'green' : 'yellow');
        rows.push(rowHtml(esc(divider())));
        rows.push(rowHtml(esc(frameRow('REPOSITORIES'))));
        rows.push(rowHtml(esc(frameRow(''))));

        if (state.loading) {
          rows.push(rowHtml(esc(frameRow(' ... CONNECTING TO CONTROL PLANE ...')), 'yellow'));
        } else if (state.error) {
          rows.push(rowHtml(esc(frameRow(' ERROR: ' + state.error)), 'red'));
        } else if (!state.repos.length) {
          rows.push(rowHtml(esc(frameRow(' NO REPOSITORIES VISIBLE. CONNECT WITH ADMIN TOKEN.')), 'dim'));
        } else {
          state.repos.slice(0, 12).forEach(function (repo, index) {
            var id = String(index + 1).padStart(2, '0');
            var label = pad(repo.name, 42) + pad((repo.status || 'ready').toUpperCase(), 14);
            rows.push(rowHtml('║ ' + '<button class="hotspot" data-repo="' + esc(repo.name) + '">[' + id + '] ' + esc(label) + '</button>' + esc(pad('', Math.max(0, WIDTH - 2 - 1 - 5 - label.length))) + '║', repo.status === 'error' ? 'red' : 'green'));
          });
        }

        while (rows.length < 20) rows.push(rowHtml(esc(frameRow(''))));
        rows.push(rowHtml(esc(divider())));
        rows.push(rowHtml(esc(frameRow('SELECT REPOSITORY OR COMMAND KEY. ANSI IS THE INTERFACE.')), 'dim'));
        rows.push(rowHtml(esc(footer())));
        return rows.join('');
      }

      function renderRepoDetail() {
        var repo = state.repos.find(function (candidate) { return candidate.name === state.selectedRepo; });
        if (!repo) { state.screen = 'repos'; return renderRepos(); }
        var rows = [];
        rows.push(rowHtml(esc(frameTitle('REPOSITORY // ' + repo.name.toUpperCase())), 'cyan'));
        rows.push(rowHtml('║' + navHtml() + esc(pad('', Math.max(0, WIDTH - 2 - 58))) + '║'));
        rows.push(rowHtml(esc(divider())));
        rows.push(rowHtml(esc(frameRow('NAME: ' + repo.name))));
        rows.push(rowHtml(esc(frameRow('STATUS: ' + (repo.status || 'ready').toUpperCase())), 'green'));
        rows.push(rowHtml(esc(frameRow('SOURCE PLANE: CLOUDFLARE ARTIFACTS'))));
        rows.push(rowHtml(esc(frameRow('AUTHORITY: STANDARD GIT + REPO-SCOPED TOKENS'))));
        rows.push(rowHtml(esc(divider())));
        rows.push(rowHtml(esc(frameRow('CHANGE / CHECK / BUILD GRAPH'))));
        rows.push(rowHtml(esc(frameRow('')));
        rows.push(rowHtml(esc(frameRow('  repository'))));
        rows.push(rowHtml(esc(frameRow('      |'))));
        rows.push(rowHtml(esc(frameRow('      +----> refs / commits'))));
        rows.push(rowHtml(esc(frameRow('      |          |'))));
        rows.push(rowHtml(esc(frameRow('      |          +----> checks / evidence'))));
        rows.push(rowHtml(esc(frameRow('      |'))));
        rows.push(rowHtml(esc(frameRow('      +----> push event ----> workflow ----> sandbox'))));
        while (rows.length < 21) rows.push(rowHtml(esc(frameRow(''))));
        rows.push(rowHtml(esc(divider())));
        rows.push(rowHtml(esc(frameRow('[ESC] REPOSITORIES   [G] GRAPH')), 'dim'));
        rows.push(rowHtml(esc(footer())));
        return rows.join('');
      }

      function renderPlaceholder(title, copy) {
        var rows = [];
        rows.push(rowHtml(esc(frameTitle(title)), 'cyan'));
        rows.push(rowHtml('║' + navHtml() + esc(pad('', Math.max(0, WIDTH - 2 - 58))) + '║'));
        rows.push(rowHtml(esc(divider())));
        rows.push(rowHtml(esc(frameRow('')));
        copy.forEach(function (line) { rows.push(rowHtml(esc(frameRow(' ' + line)))); });
        while (rows.length < 21) rows.push(rowHtml(esc(frameRow(''))));
        rows.push(rowHtml(esc(divider())));
        rows.push(rowHtml(esc(frameRow('[ESC] REPOSITORIES')), 'dim'));
        rows.push(rowHtml(esc(footer())));
        return rows.join('');
      }

      function render() {
        if (state.screen === 'repo') consoleEl.innerHTML = renderRepoDetail();
        else if (state.screen === 'changes') consoleEl.innerHTML = renderPlaceholder('CHANGES', [
          'CHANGE OBJECTS ARE THE COLLABORATION UNIT ABOVE BRANCHES.',
          'NEXT: INTENT, REVIEW, CHECK STATUS, AND PROMOTION STATE.'
        ]);
        else if (state.screen === 'agents') consoleEl.innerHTML = renderPlaceholder('AGENT SWITCHBOARD', [
          'AGENTS GET SHORT-LIVED REPO-SCOPED CAPABILITIES.',
          'NO LONG-LIVED FORGE-WIDE PAT REQUIRED.'
        ]);
        else if (state.screen === 'builds') consoleEl.innerHTML = renderPlaceholder('BUILDS / DEPLOYS', [
          'PUSH EVENT -> WORKFLOW -> SANDBOX/CONTAINER -> EVIDENCE.',
          'EXECUTION IS SEPARATE FROM GIT STORAGE.'
        ]);
        else if (state.screen === 'graph') consoleEl.innerHTML = renderPlaceholder('CAUSAL GRAPH', [
          'INTENT -> CHANGE -> COMMIT -> CHECK -> BUILD -> DEPLOY',
          'THE GRAPH IS DERIVED; GIT HISTORY REMAINS BORING.'
        ]);
        else consoleEl.innerHTML = renderRepos();

        consoleEl.querySelectorAll('[data-screen]').forEach(function (button) {
          button.addEventListener('click', function () {
            state.screen = button.getAttribute('data-screen') || 'repos';
            render();
          });
        });
        consoleEl.querySelectorAll('[data-repo]').forEach(function (button) {
          button.addEventListener('click', function () {
            state.selectedRepo = button.getAttribute('data-repo');
            state.screen = 'repo';
            render();
          });
        });
      }

      async function loadHealth() {
        try {
          var response = await fetch('/healthz', { cache: 'no-store' });
          if (response.ok) state.health = await response.json();
        } catch (_) {}
        render();
      }

      async function loadRepos() {
        var token = sessionStorage.getItem(tokenKey) || '';
        if (!token) { state.repos = []; state.error = null; render(); return; }
        state.loading = true;
        state.error = null;
        render();
        try {
          var response = await fetch('/repos?limit=50', {
            cache: 'no-store',
            headers: { 'authorization': 'Bearer ' + token }
          });
          var body = await response.json();
          if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status);
          state.repos = Array.isArray(body.repos) ? body.repos : [];
        } catch (error) {
          state.repos = [];
          state.error = error instanceof Error ? error.message : String(error);
        } finally {
          state.loading = false;
          render();
        }
      }

      authForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var token = tokenInput.value.trim();
        if (token) sessionStorage.setItem(tokenKey, token);
        tokenInput.value = '';
        loadRepos();
      });

      disconnect.addEventListener('click', function () {
        sessionStorage.removeItem(tokenKey);
        tokenInput.value = '';
        state.repos = [];
        state.error = null;
        state.screen = 'repos';
        render();
      });

      window.addEventListener('keydown', function (event) {
        if (document.activeElement === tokenInput) return;
        var key = event.key.toLowerCase();
        var map = { r: 'repos', c: 'changes', a: 'agents', b: 'builds', g: 'graph' };
        if (map[key]) { state.screen = map[key]; event.preventDefault(); render(); }
        if (event.key === 'Escape') { state.screen = 'repos'; state.selectedRepo = null; render(); }
      });

      render();
      loadHealth();
      loadRepos();
    }());
  </script>
</body>
</html>`;
}
