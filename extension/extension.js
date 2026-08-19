const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

let gitApi = null;

function git(cwd, args) {
  return new Promise((resolve) => {
    cp.execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

function parseNumstat(out) {
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    const binary = m[1] === '-';
    let p = m[3];
    const r = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/) || p.match(/^(.*) => (.*)$/);
    if (r) p = r.length === 5 ? r[1] + r[3] + r[4] : r[2];
    files.push({ path: p, add: binary ? null : +m[1], del: binary ? null : +m[2], binary });
  }
  return files;
}

function parseNameStatus(out) {
  // lines: "M\tpath" or "R100\told\tnew"
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z])\S*\t(.*)$/);
    if (!m) continue;
    const parts = m[2].split('\t');
    map[parts[parts.length - 1]] = m[1];
  }
  return map;
}

function parseShortstatLine(line) {
  const add = (line.match(/(\d+) insertion/) || [])[1];
  const del = (line.match(/(\d+) deletion/) || [])[1];
  const filesChanged = (line.match(/(\d+) files? changed/) || [])[1];
  return { add: add ? +add : 0, del: del ? +del : 0, files: filesChanged ? +filesChanged : 0 };
}

function sumFiles(files) {
  return files.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });
}

function countLines(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 5 * 1024 * 1024) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null;
    if (buf.length === 0) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf[buf.length - 1] !== 10) n++;
    return n;
  } catch {
    return null;
  }
}

async function collectRepo(repoPath) {
  const [unstagedOut, stagedOut, untrackedOut, logOut, branchOut, statusOut] = await Promise.all([
    git(repoPath, ['diff', '--numstat']),
    git(repoPath, ['diff', '--numstat', '--cached']),
    git(repoPath, ['ls-files', '--others', '--exclude-standard']),
    git(repoPath, ['log', '-n', '30', '--pretty=format:%x01%H%x02%h%x02%s%x02%cr', '--shortstat']),
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['status', '--porcelain']),
  ]);

  // status letters: index (staged) and worktree columns
  const idxLetter = {}, wtLetter = {};
  for (const line of statusOut.split('\n')) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (line[0] !== ' ' && line[0] !== '?') idxLetter[p] = line[0];
    if (line[1] !== ' ') wtLetter[p] = line[1] === '?' ? 'U' : line[1];
  }

  const branch = branchOut.trim();
  const withLetter = (files, letters, fallback) =>
    files.map((f) => ({ ...f, letter: letters[f.path] || fallback }));
  const unstaged = withLetter(parseNumstat(unstagedOut), wtLetter, 'M');
  const staged = withLetter(parseNumstat(stagedOut), idxLetter, 'M');
  const untracked = untrackedOut.split('\n').filter(Boolean).map((p) => {
    const n = countLines(path.join(repoPath, p));
    return { path: p, add: n, del: n == null ? null : 0, binary: n == null, untracked: true, letter: 'U' };
  });

  let vsMaster = null;
  if (branch && branch !== 'master') {
    const masterSha = (await git(repoPath, ['rev-parse', '--verify', '--quiet', 'master'])).trim();
    if (masterSha) {
      const [behindOut, aheadOut, mbOut, numstatOut, nameStatusOut] = await Promise.all([
        git(repoPath, ['rev-list', '--count', 'HEAD..master']),
        git(repoPath, ['rev-list', '--count', 'master..HEAD']),
        git(repoPath, ['merge-base', 'HEAD', 'master']),
        git(repoPath, ['diff', '--numstat', '--find-renames', 'master...HEAD']),
        git(repoPath, ['diff', '--name-status', '--find-renames', 'master...HEAD']),
      ]);
      const files = withLetter(parseNumstat(numstatOut), parseNameStatus(nameStatusOut), 'M');
      vsMaster = {
        behind: +behindOut.trim() || 0,
        ahead: +aheadOut.trim() || 0,
        mergeBase: mbOut.trim(),
        files,
        totals: sumFiles(files),
      };
    }
  }

  const aheadUpstreamOut = await git(repoPath, ['rev-list', '--count', '@{u}..HEAD']);
  const aheadUpstream = aheadUpstreamOut.trim() === '' ? null : +aheadUpstreamOut.trim();

  const commits = [];
  for (const entry of logOut.split('\x01')) {
    if (!entry.trim()) continue;
    const lines = entry.split('\n');
    const [hash, short, subject, when] = lines[0].split('\x02');
    const statLine = (lines.slice(1).join('\n').match(/\d+ files? changed[^\n]*/) || [''])[0];
    const s = statLine ? parseShortstatLine(statLine) : { add: 0, del: 0, files: 0 };
    commits.push({ hash, short, subject, when, ...s });
  }
  const shownCommits =
    aheadUpstream != null && aheadUpstream > 0 ? commits.slice(0, aheadUpstream) : commits.slice(0, 8);
  const commitsLabel =
    aheadUpstream != null && aheadUpstream > 0 ? `Outgoing commits (${aheadUpstream})` : 'Recent commits';

  const totals = sumFiles([...staged, ...unstaged, ...untracked]);
  return {
    repoPath,
    name: path.basename(repoPath),
    branch,
    staged,
    unstaged,
    untracked,
    totals,
    vsMaster,
    commits: shownCommits,
    commitsLabel,
  };
}

function getHtml(nonce) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 0; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); user-select: none; }
  .row { display: flex; align-items: center; height: 22px; cursor: pointer; white-space: nowrap; padding-right: 8px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .twist { width: 16px; flex: none; text-align: center; opacity: .8; font-size: .8em; }
  .name { overflow: hidden; text-overflow: ellipsis; }
  .hdr .name { font-weight: 600; }
  .dim { opacity: .6; margin-left: 7px; font-size: .9em; overflow: hidden; text-overflow: ellipsis; }
  .spacer { flex: 1; min-width: 8px; }
  .st { width: 1.4em; flex: none; text-align: center; font-weight: 600; }
  .add, .del { width: 3.6em; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .st-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .st-A, .st-U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .st-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .st-R, .st-C { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .behind { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .empty { padding: 8px; opacity: .6; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let repos = [];
const commitFiles = {};
const state = vscode.getState() || { collapsed: {} };

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function isCollapsed(id, dflt) { return state.collapsed[id] !== undefined ? state.collapsed[id] : dflt; }
function toggle(id, dflt) { state.collapsed[id] = !isCollapsed(id, dflt); vscode.setState(state); render(); }

function cols(add, del, letter, binary) {
  const st = letter ? '<span class="st st-' + esc(letter) + '">' + esc(letter) + '</span>' : '<span class="st"></span>';
  const a = binary ? '<span class="add">bin</span>' : (add != null ? '<span class="add">+' + add + '</span>' : '<span class="add"></span>');
  const d = binary ? '<span class="del"></span>' : (del != null ? '<span class="del">−' + del + '</span>' : '<span class="del"></span>');
  return st + a + d;
}

function row(depth, opts) {
  const pad = 4 + depth * 14;
  const twist = opts.twist === undefined ? '<span class="twist"></span>'
    : '<span class="twist">' + (opts.twist ? '▸' : '▾') + '</span>';
  return '<div class="row ' + (opts.hdr ? 'hdr' : '') + '" style="padding-left:' + pad + 'px" data-act="' + esc(opts.act || '') + '">'
    + twist
    + '<span class="name">' + opts.name + '</span>'
    + (opts.dim ? '<span class="dim">' + opts.dim + '</span>' : '')
    + '<span class="spacer"></span>'
    + (opts.cols || '')
    + '</div>';
}

function fileRow(depth, repoPath, f, act) {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  return row(depth, {
    name: esc(f.path.split('/').pop()),
    dim: esc(dir),
    cols: cols(f.add, f.del, f.letter, f.binary),
    act,
  });
}

function render() {
  const root = document.getElementById('root');
  if (!repos.length) { root.innerHTML = '<div class="empty">No git repositories found.</div>'; return; }
  let h = '';
  for (const r of repos) {
    const rid = 'r|' + r.repoPath;
    const rc = isCollapsed(rid, false);
    const t = r.totals;
    h += row(0, { hdr: true, twist: rc, name: esc(r.name), dim: esc(r.branch),
      cols: (t.add || t.del) ? cols(t.add, t.del, null, false) : '', act: 't|' + rid + '|0' });
    if (rc) continue;

    const sections = [
      ['staged', 'Staged', r.staged, false],
      ['changes', 'Changes', [...r.unstaged, ...r.untracked], false],
    ];
    for (const [kind, label, files, dflt] of sections) {
      if (!files.length) continue;
      const sid = 's|' + r.repoPath + '|' + kind;
      const sc = isCollapsed(sid, dflt);
      const st = sumFiles(files);
      h += row(1, { hdr: true, twist: sc, name: esc(label) + ' (' + files.length + ')',
        cols: cols(st.add, st.del, null, false), act: 't|' + sid + '|' + (dflt ? 1 : 0) });
      if (!sc) for (const f of files) h += fileRow(2, r.repoPath, f, 'w|' + r.repoPath + '|' + f.path);
    }

    if (r.vsMaster) {
      const v = r.vsMaster;
      const vid = 's|' + r.repoPath + '|vsmaster';
      const vc = isCollapsed(vid, false);
      const behind = v.behind
        ? '<span class="behind">↓' + v.behind + ' behind master</span>'
        : 'not behind master';
      h += row(1, { hdr: true, twist: vc, name: 'Vs master (' + v.files.length + ')',
        dim: behind + ' · ↑' + v.ahead, cols: cols(v.totals.add, v.totals.del, null, false),
        act: 't|' + vid + '|0' });
      if (!vc) for (const f of v.files) {
        h += fileRow(2, r.repoPath, f, 'm|' + r.repoPath + '|' + v.mergeBase + '|' + f.path);
      }
    }

    if (r.commits.length) {
      const cid = 's|' + r.repoPath + '|commits';
      const cc = isCollapsed(cid, true);
      h += row(1, { hdr: true, twist: cc, name: esc(r.commitsLabel), act: 't|' + cid + '|1' });
      if (!cc) for (const c of r.commits) {
        const kid = 'c|' + r.repoPath + '|' + c.hash;
        const kc = isCollapsed(kid, true);
        h += row(2, { twist: kc, name: esc(c.subject), dim: esc(c.short + ' · ' + c.when),
          cols: cols(c.add, c.del, null, false), act: 'e|' + kid + '|1' });
        if (!kc) {
          const key = r.repoPath + '|' + c.hash;
          const files = commitFiles[key];
          if (!files) {
            h += row(3, { name: '<span class="dim">loading…</span>' });
          } else {
            for (const f of files) h += fileRow(3, r.repoPath, f, 'k|' + r.repoPath + '|' + c.hash + '|' + f.path);
          }
        }
      }
    }
  }
  root.innerHTML = h;
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('.row');
  if (!el || !el.dataset.act) return;
  const act = el.dataset.act;
  const sep1 = act.indexOf('|');
  const type = act.slice(0, sep1);
  const rest = act.slice(sep1 + 1);
  if (type === 't' || type === 'e') {
    const i = rest.lastIndexOf('|');
    const id = rest.slice(0, i);
    const dflt = rest.slice(i + 1) === '1';
    if (type === 'e') {
      const [, repoPath, hash] = id.split('|');
      if (isCollapsed(id, dflt) && !commitFiles[repoPath + '|' + hash]) {
        vscode.postMessage({ type: 'expandCommit', repoPath, hash });
      }
    }
    toggle(id, dflt);
  } else if (type === 'w') {
    const i = rest.indexOf('|');
    vscode.postMessage({ type: 'open', mode: 'working', repoPath: rest.slice(0, i), path: rest.slice(i + 1) });
  } else if (type === 'm') {
    const [repoPath, mergeBase, ...p] = rest.split('|');
    vscode.postMessage({ type: 'open', mode: 'vsmaster', repoPath, mergeBase, path: p.join('|') });
  } else if (type === 'k') {
    const [repoPath, hash, ...p] = rest.split('|');
    vscode.postMessage({ type: 'open', mode: 'commit', repoPath, hash, path: p.join('|') });
  }
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'data') { repos = m.repos; render(); }
  else if (m.type === 'commitFiles') { commitFiles[m.repoPath + '|' + m.hash] = m.files; render(); }
});

function sumFiles(files) {
  return files.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

class StatsViewProvider {
  constructor() {
    this.view = null;
    this.repos = [];
    this.data = new Map();
    this.fileStats = new Map();
  }

  setRepos(paths) {
    this.repos = paths;
    this.refresh();
  }

  async refresh() {
    const results = await Promise.all(this.repos.map((r) => collectRepo(r).catch(() => null)));
    this.data.clear();
    this.fileStats.clear();
    for (const d of results) {
      if (!d) continue;
      this.data.set(d.repoPath, d);
      for (const f of [...d.staged, ...d.unstaged, ...d.untracked]) {
        this.fileStats.set(path.join(d.repoPath, f.path), f);
      }
    }
    this.push();
  }

  push() {
    if (!this.view) return;
    const repos = this.repos.filter((r) => this.data.has(r)).map((r) => this.data.get(r));
    this.view.webview.postMessage({ type: 'data', repos });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    view.webview.html = getHtml(nonce);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  async onMessage(m) {
    if (m.type === 'ready') {
      this.push();
    } else if (m.type === 'expandCommit') {
      const [numOut, nsOut] = await Promise.all([
        git(m.repoPath, ['show', '--numstat', '--format=', '--find-renames', m.hash]),
        git(m.repoPath, ['show', '--name-status', '--format=', '--find-renames', m.hash]),
      ]);
      const letters = parseNameStatus(nsOut);
      const files = parseNumstat(numOut).map((f) => ({ ...f, letter: letters[f.path] || 'M' }));
      if (this.view) this.view.webview.postMessage({ type: 'commitFiles', repoPath: m.repoPath, hash: m.hash, files });
    } else if (m.type === 'open') {
      const uri = vscode.Uri.file(path.join(m.repoPath, m.path));
      const base = path.basename(m.path);
      try {
        if (m.mode === 'working') {
          await vscode.commands.executeCommand('git.openChange', uri).then(undefined, () =>
            vscode.commands.executeCommand('vscode.open', uri)
          );
        } else if (m.mode === 'vsmaster' && gitApi) {
          const left = gitApi.toGitUri(uri, m.mergeBase);
          const right = fs.existsSync(uri.fsPath) ? uri : gitApi.toGitUri(uri, 'HEAD');
          await vscode.commands.executeCommand('vscode.diff', left, right, `${base} (master ↔ branch)`);
        } else if (m.mode === 'commit' && gitApi) {
          const left = gitApi.toGitUri(uri, `${m.hash}^`);
          const right = gitApi.toGitUri(uri, m.hash);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${base} @ ${m.hash.slice(0, 7)}`);
        } else {
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      } catch {
        vscode.commands.executeCommand('vscode.open', uri);
      }
    }
  }
}

function activate(context) {
  const provider = new StatsViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('scmDiffStats', provider));
  context.subscriptions.push(vscode.commands.registerCommand('scmDiffStats.refresh', () => provider.refresh()));

  const decoEmitter = new vscode.EventEmitter();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decoEmitter.event,
      provideFileDecoration(uri) {
        const f = provider.fileStats.get(uri.fsPath);
        if (!f || f.binary) return undefined;
        return { tooltip: `+${f.add} −${f.del}` };
      },
    })
  );

  let timer;
  const scheduleRefresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      provider.refresh().then(() => decoEmitter.fire(undefined));
    }, 700);
  };

  const wireGitApi = async () => {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return false;
    gitApi = (await gitExt.activate()).getAPI(1);
    const sync = () => provider.setRepos(gitApi.repositories.map((r) => r.rootUri.fsPath));
    context.subscriptions.push(gitApi.onDidOpenRepository((repo) => {
      context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
      sync();
    }));
    context.subscriptions.push(gitApi.onDidCloseRepository(sync));
    for (const repo of gitApi.repositories) {
      context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
    }
    sync();
    return gitApi.repositories.length > 0;
  };

  wireGitApi().then((ok) => {
    if (!ok) {
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      Promise.all(
        folders.map(async (f) => ((await git(f, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true' ? f : null))
      ).then((rs) => provider.setRepos(rs.filter(Boolean)));
    }
  });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(scheduleRefresh));
}

function deactivate() {}

module.exports = { activate, deactivate };
