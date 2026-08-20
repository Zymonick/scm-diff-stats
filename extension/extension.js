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

function gitFull(cwd, args) {
  return new Promise((resolve) => {
    cp.execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout || '', err: stderr || '' });
    });
  });
}

// Empty-document scheme for diff sides that do not exist at a ref
// (file added or deleted between the two sides).
const EMPTY_SCHEME = 'scm-diff-stats-empty';
const emptyUri = (uri) => uri.with({ scheme: EMPTY_SCHEME });

async function existsAtRef(repoPath, ref, relPath) {
  return (await gitFull(repoPath, ['cat-file', '-e', `${ref}:${relPath}`])).code === 0;
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
  const [unstagedOut, stagedOut, untrackedOut, branchOut, statusOut] = await Promise.all([
    git(repoPath, ['diff', '--numstat']),
    git(repoPath, ['diff', '--numstat', '--cached']),
    git(repoPath, ['ls-files', '--others', '--exclude-standard']),
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
  let masterSha = '';
  if (branch && branch !== 'master') {
    masterSha = (await git(repoPath, ['rev-parse', '--verify', '--quiet', 'master'])).trim();
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

  // branch repos: only commits not already on master; master itself: recent history
  const logOut = vsMaster
    ? await git(repoPath, ['log', '-n', '50', '--pretty=format:%x01%H%x02%h%x02%s%x02%cr', '--shortstat', 'master..HEAD'])
    : await git(repoPath, ['log', '-n', '30', '--pretty=format:%x01%H%x02%h%x02%s%x02%cr', '--shortstat']);

  const commits = [];
  for (const entry of logOut.split('\x01')) {
    if (!entry.trim()) continue;
    const lines = entry.split('\n');
    const [hash, short, subject, when] = lines[0].split('\x02');
    const statLine = (lines.slice(1).join('\n').match(/\d+ files? changed[^\n]*/) || [''])[0];
    const s = statLine ? parseShortstatLine(statLine) : { add: 0, del: 0, files: 0 };
    commits.push({ hash, short, subject, when, ...s });
  }
  const shownCommits = vsMaster
    ? commits
    : aheadUpstream != null && aheadUpstream > 0
      ? commits.slice(0, aheadUpstream)
      : commits.slice(0, 8);
  const commitsLabel = `Commits (${shownCommits.length})`;

  const totals = sumFiles([...staged, ...unstaged, ...untracked]);
  const dirtyCount = staged.length + unstaged.length + untracked.length;
  const ci = await collectCi(repoPath, branch, vsMaster, dirtyCount, masterSha);
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
    upstream: aheadUpstream != null,
    ci,
  };
}

function ciCommandPath() {
  return (vscode.workspace.getConfiguration('scmDiffStats').get('ciCommand') || '').trim();
}

// Land-readiness of a scripts/ci PR worktree: the .ci/pr-N.tested.json green
// record must name exactly this HEAD, and master must not have moved since.
async function collectCi(repoPath, branch, vsMaster, dirtyCount, masterSha) {
  if (!ciCommandPath()) return null;
  if (!branch || branch === 'master') return null;
  const m = path.basename(repoPath).match(/^pr-(\d+)$/);
  if (!m) return null;
  const serial = +m[1];
  // only new-style PRs (with their docs/PR_N folder) — not old review worktrees
  if (!fs.existsSync(path.join(repoPath, 'docs', 'PR_' + serial))) return null;
  let tested = null;
  try {
    tested = JSON.parse(fs.readFileSync(path.join(path.dirname(repoPath), '.ci', 'pr-' + serial + '.tested.json')));
  } catch { /* no green record yet */ }
  const headSha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  let state, reason = '';
  if (dirtyCount || !tested || tested.branch_sha !== headSha) {
    state = 'untested';
    reason = dirtyCount
      ? 'working tree changed since the last green run'
      : tested ? 'HEAD is not the tested revision' : 'no green test record';
  } else if ((vsMaster && vsMaster.behind > 0) || tested.master_sha !== masterSha) {
    state = 'behind';
    reason = 'master moved since the green run';
  } else {
    state = 'ready';
  }
  return { serial, state, reason, suite: tested && tested.suite, time: tested && tested.time };
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
  .cbox { display: flex; gap: 4px; padding: 3px 8px 5px 18px; }
  .cmsg { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 6px;
          font-family: inherit; font-size: inherit; outline: none; }
  .cmsg:focus { border-color: var(--vscode-focusBorder); }
  .cmsg::placeholder { color: var(--vscode-input-placeholderForeground); }
  .cbtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
          border-radius: 2px; padding: 2px 8px; cursor: pointer; font-family: inherit; font-size: inherit; white-space: nowrap; }
  .cbtn:hover { background: var(--vscode-button-hoverBackground); }
  .sbtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
          border: none; border-radius: 2px; padding: 0 6px; margin-left: 8px; cursor: pointer;
          font-family: inherit; font-size: .85em; height: 18px; white-space: nowrap; flex: none; }
  .sbtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .agent { color: var(--vscode-charts-yellow, #d7ba7d); margin-left: 8px; font-size: .85em; flex: none;
           animation: agentpulse 2s ease-in-out infinite; }
  @keyframes agentpulse { 50% { opacity: .4; } }
  .ibtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
          border: none; border-radius: 2px; width: 20px; padding: 0; margin-left: 4px; cursor: pointer;
          font-family: inherit; font-size: .9em; height: 18px; line-height: 18px; flex: none; text-align: center; }
  .ibtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .ibtn.blocked { opacity: .45; }
  .cist { margin-left: 6px; flex: none; font-weight: 700; cursor: default; }
  .ci-ready { color: var(--vscode-charts-green, #89d185); }
  .ci-behind { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .ci-untested { color: var(--vscode-charts-yellow, #d7ba7d); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let repos = [];
let agents = {};
let syncEnabled = false;
let previewEnabled = false;
let ciEnabled = false;
let pendingRepos = null;
const commitFiles = {};
const state = vscode.getState() || { collapsed: {} };
state.collapsed = state.collapsed || {};
state.drafts = state.drafts || {};

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function isCollapsed(id, dflt) { return state.collapsed[id] !== undefined ? state.collapsed[id] : dflt; }
function toggle(id, dflt) { state.collapsed[id] = !isCollapsed(id, dflt); vscode.setState(state); render(); }

function ciBtn(repoPath, serial, cmd, glyph, tip, blocked) {
  return '<button class="ibtn' + (blocked ? ' blocked' : '') + '" data-repo="' + esc(repoPath)
    + '" data-serial="' + serial + '" data-cmd="' + cmd + '" title="' + esc(tip) + '">' + glyph + '</button>';
}

function ciHtml(r) {
  if (ciEnabled && r.branch === 'master') {
    return ciBtn(r.repoPath, '', 'new', '✚', 'ci new — create a new PR: worktree, branch, docs/PR_N, database');
  }
  if (!r.ci) return '';
  const c = r.ci, s = c.serial;
  let st;
  if (c.state === 'ready') {
    st = '<span class="cist ci-ready" title="tested (' + esc(c.suite || '') + ') ' + esc(c.time || '')
      + ' — ready to land">✓</span>';
  } else if (c.state === 'behind') {
    st = '<span class="cist ci-behind" title="land blocked: behind master — ' + esc(c.reason)
      + '. Run ci test ' + s + '.">↓</span>';
  } else {
    st = '<span class="cist ci-untested" title="land blocked: not tested — ' + esc(c.reason)
      + '. Run ci test ' + s + '.">○</span>';
  }
  return ciBtn(r.repoPath, s, 'preview', '▷', 'ci preview ' + s + ' — start the preview server and open the changed pages in Edge')
    + ciBtn(r.repoPath, s, 'test', '⇣', 'ci test ' + s + ' --fix — sync with master, run the gate, let Claude fix failures')
    + ciBtn(r.repoPath, s, 'land', '⇪', 'ci land ' + s + ' — squash-merge onto master (interactive terminal)', c.state !== 'ready')
    + st;
}

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
    + (opts.btns || '')
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
    const ag = agents[r.repoPath] || [];
    let agentHtml = '';
    if (ag.length) {
      const byKind = {};
      for (const a of ag) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
      const label = Object.entries(byKind).map(([k, n]) => (n > 1 ? k + ' ×' + n : k)).join(', ');
      agentHtml = '<span class="agent" title="agent process(es) running in this worktree: '
        + esc(ag.map(a => a.kind + ' (pid ' + a.pid + ')').join(', ')) + '">● ' + esc(label) + '</span>';
    }
    const ci = ciHtml(r);
    const previewBtn = (!ci && previewEnabled && r.branch !== 'master')
      ? '<button class="sbtn pbtn" data-repo="' + esc(r.repoPath) + '" title="start the worktree preview server and open its changed pages (max 5) in the browser">▷ preview</button>'
      : '';
    // collapsed repos summarize their diff vs master; expanded ones show working-tree totals
    let repoDim = esc(r.branch);
    let repoCols = (t.add || t.del) ? cols(t.add, t.del, null, false) : '';
    if (rc && r.vsMaster) {
      const v = r.vsMaster;
      repoCols = cols(v.totals.add, v.totals.del, null, false);
      if (v.behind) repoDim += ' <span class="behind">↓' + v.behind + '</span>';
    }
    h += row(0, { hdr: true, twist: rc, name: esc(r.name), dim: repoDim, btns: ci + previewBtn + agentHtml,
      cols: repoCols, act: 't|' + rid + '|0' });
    if (rc) continue;

    if (r.staged.length + r.unstaged.length + r.untracked.length > 0) {
      const draft = state.drafts[r.repoPath] || '';
      h += '<div class="cbox">'
        + '<input class="cmsg" data-repo="' + esc(r.repoPath) + '" placeholder="Commit message" value="' + esc(draft) + '">'
        + '<button class="cbtn" data-repo="' + esc(r.repoPath) + '" data-push="0" title="git add -A && git commit">Commit all</button>'
        + (r.upstream
          ? '<button class="cbtn" data-repo="' + esc(r.repoPath) + '" data-push="1" title="commit, then push to the PR branch">+ Push</button>'
          : '')
        + '</div>';
    }

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
        btns: (syncEnabled && !r.ci) ? '<button class="sbtn" data-repo="' + esc(r.repoPath) + '" title="merge master in, run the full test suite, launch a fix agent on failure">⇣ sync + test</button>' : '',
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

function doCommit(repoPath, push) {
  const msg = (state.drafts[repoPath] || '').trim();
  if (!msg) return;
  vscode.postMessage({ type: 'commit', repoPath, message: msg, push });
}

document.addEventListener('input', (ev) => {
  if (ev.target.classList && ev.target.classList.contains('cmsg')) {
    state.drafts[ev.target.dataset.repo] = ev.target.value;
    vscode.setState(state);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.classList && ev.target.classList.contains('cmsg') && ev.key === 'Enter') {
    doCommit(ev.target.dataset.repo, ev.ctrlKey || ev.metaKey);
  }
});

// pointerdown fires before the input's focusout, so a deferred render can't swallow the click
document.addEventListener('pointerdown', (ev) => {
  const btn = ev.target.closest && ev.target.closest('button.cbtn');
  if (btn) { ev.preventDefault(); doCommit(btn.dataset.repo, btn.dataset.push === '1'); return; }
  const ibtn = ev.target.closest && ev.target.closest('button.ibtn');
  if (ibtn) {
    ev.preventDefault();
    vscode.postMessage({ type: 'ci', cmd: ibtn.dataset.cmd, repoPath: ibtn.dataset.repo, serial: ibtn.dataset.serial });
    return;
  }
  const pbtn = ev.target.closest && ev.target.closest('button.pbtn');
  if (pbtn) { ev.preventDefault(); vscode.postMessage({ type: 'preview', repoPath: pbtn.dataset.repo }); return; }
  const sbtn = ev.target.closest && ev.target.closest('button.sbtn');
  if (sbtn) { ev.preventDefault(); vscode.postMessage({ type: 'synctest', repoPath: sbtn.dataset.repo }); }
});

document.addEventListener('focusout', (ev) => {
  if (pendingRepos && ev.target.classList && ev.target.classList.contains('cmsg')) {
    repos = pendingRepos;
    pendingRepos = null;
    setTimeout(render, 100);
  }
});

document.addEventListener('click', (ev) => {
  if (ev.target.closest('button')) return;
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
  if (m.type === 'data') {
    syncEnabled = !!m.syncEnabled;
    previewEnabled = !!m.previewEnabled;
    ciEnabled = !!m.ciEnabled;
    agents = m.agents || {};
    // don't re-render while a commit message is being typed
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('cmsg')) {
      pendingRepos = m.repos;
    } else {
      repos = m.repos;
      render();
    }
  }
  else if (m.type === 'commitFiles') { commitFiles[m.repoPath + '|' + m.hash] = m.files; render(); }
  else if (m.type === 'committed') {
    delete state.drafts[m.repoPath];
    vscode.setState(state);
    render();
  }
});

function sumFiles(files) {
  return files.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function scanAgents(repoPaths) {
  // agent processes (claude/codex) whose cwd is inside one of the repos
  const map = {};
  const candidates = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return map; }
  for (const pid of pids) {
    let cwd, cmd, ppid = 0;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
      const stat = fs.readFileSync(`/proc/${pid}/stat`).toString();
      ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
    } catch { continue; }
    if (!cmd.length) continue;
    const exe = path.basename(cmd[0]);
    let kind = null;
    if (exe === 'claude' || cmd[0].includes('native-binary/claude')) kind = 'claude';
    else if (exe === 'codex') kind = 'codex';
    else continue;
    candidates.push({ pid: +pid, ppid, kind, cwd });
  }
  // one session = one badge: drop children whose parent is itself an agent process
  const agentPids = new Set(candidates.map((c) => c.pid));
  for (const c of candidates) {
    if (agentPids.has(c.ppid)) continue;
    for (const rp of repoPaths) {
      if (c.cwd === rp || c.cwd.startsWith(rp + path.sep)) {
        (map[rp] = map[rp] || []).push({ pid: c.pid, kind: c.kind });
        break;
      }
    }
  }
  return map;
}

function findClaudeBin() {
  try {
    const extDir = path.join(process.env.HOME || '', '.vscode-server', 'extensions');
    const candidates = fs.readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
      .map((d) => path.join(extDir, d, 'resources', 'native-binary', 'claude'))
      .filter((p) => fs.existsSync(p));
    if (candidates.length) return candidates[0];
  } catch { /* fall through */ }
  return 'claude';
}

class StatsViewProvider {
  constructor() {
    this.view = null;
    this.repos = [];
    this.data = new Map();
    this.fileStats = new Map();
    this.running = new Set();
    this.agents = {};
    this.channel = vscode.window.createOutputChannel('Diff Stats');
  }

  syncCommand() {
    return (vscode.workspace.getConfiguration('scmDiffStats').get('syncTestCommand') || '').trim();
  }

  previewCommand() {
    return (vscode.workspace.getConfiguration('scmDiffStats').get('previewCommand') || '').trim();
  }

  browserCommand() {
    return (vscode.workspace.getConfiguration('scmDiffStats').get('browserCommand') || '').trim();
  }

  async runPreview(repoPath) {
    const name = path.basename(repoPath);
    const key = 'preview:' + repoPath;
    if (this.running.has(key)) {
      vscode.window.showWarningMessage(`${name}: preview is already starting`);
      return;
    }
    const template = this.previewCommand();
    if (!template) {
      vscode.window.showErrorMessage('Set scmDiffStats.previewCommand in your settings first.');
      return;
    }
    const cmd = template.replace(/\$\{name\}/g, name).replace(/\$\{repoPath\}/g, repoPath);
    this.running.add(key);
    this.channel.appendLine(`\n=== ${new Date().toLocaleTimeString()} · ${name}: ${cmd}`);
    let out = '';
    const append = (buf) => {
      const s = buf.toString();
      this.channel.append(s);
      out += s;
    };
    try {
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `preview: ${name}` },
        () => new Promise((resolve) => {
          const child = cp.spawn('bash', ['-lc', cmd], { cwd: repoPath });
          child.stdout.on('data', append);
          child.stderr.on('data', append);
          child.on('close', resolve);
          child.on('error', (e) => { append(String(e)); resolve(1); });
        })
      );
      if (code !== 0) {
        this.channel.show(true);
        vscode.window.showErrorMessage(`${name}: preview command failed — see the Diff Stats output.`);
        return;
      }
      // base URL: prefer this worktree's status line, else the last URL printed
      let base = null;
      const line = out.match(new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\S+\\s+(https?://\\S+)', 'm'));
      if (line) base = line[1];
      if (!base) {
        const urls = out.match(/https?:\/\/[\d.]+:\d+/g);
        base = urls ? urls[urls.length - 1] : null;
      }
      if (!base) {
        this.channel.show(true);
        vscode.window.showErrorMessage(`${name}: could not find the preview URL in the command output.`);
        return;
      }
      base = base.replace(/\/+$/, '');

      // changed pages from the worktree's frontend-review manifests (at most 5):
      // legacy .frontend-review.json plus numbered .frontend-review/NNNN-slug.json,
      // later files superseding earlier entries for the same URL
      const byUrl = new Set();
      const addManifest = (file) => {
        try {
          const manifest = JSON.parse(fs.readFileSync(file));
          for (const p of manifest.pages || []) {
            if (typeof p.url === 'string' && p.url.startsWith('/')) byUrl.add(p.url);
          }
        } catch { /* ignore missing or unreadable manifests */ }
      };
      addManifest(path.join(repoPath, '.frontend-review.json'));
      try {
        const dir = path.join(repoPath, '.frontend-review');
        for (const n of fs.readdirSync(dir).filter((n) => /^\d{4}(-[a-z0-9-]+)?\.json$/.test(n)).sort()) {
          addManifest(path.join(dir, n));
        }
      } catch { /* no manifest directory */ }
      const pages = [...byUrl];
      const urls = (pages.length ? pages.slice(0, 5).map((u) => base + u) : [base]);

      const bcmd = this.browserCommand();
      if (bcmd) {
        const full = bcmd.replace(/\$\{urls\}/g, urls.map((u) => '"' + u + '"').join(' '));
        this.channel.appendLine(`launching browser: ${full}`);
        const child = cp.spawn('bash', ['-lc', full], { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        for (const u of urls) vscode.env.openExternal(vscode.Uri.parse(u));
      }
      vscode.window.setStatusBarMessage(`$(globe) ${name}: opened ${urls.length} page(s) at ${base}`, 8000);
    } finally {
      this.running.delete(key);
    }
  }

  async runSyncTest(repoPath) {
    const name = path.basename(repoPath);
    const d = this.data.get(repoPath);
    const branch = d ? d.branch : '';
    if (this.running.has(repoPath)) {
      vscode.window.showWarningMessage(`${name}: sync + test is already running`);
      return;
    }
    const template = this.syncCommand();
    if (!template) {
      vscode.window.showErrorMessage('Set scmDiffStats.syncTestCommand in your settings first.');
      return;
    }
    const dirty = (await git(repoPath, ['status', '--porcelain'])).trim();
    if (dirty) {
      vscode.window.showWarningMessage(`${name}: commit or stash the working tree changes first.`);
      return;
    }
    const cmd = template
      .replace(/\$\{name\}/g, name)
      .replace(/\$\{branch\}/g, branch)
      .replace(/\$\{repoPath\}/g, repoPath);

    this.running.add(repoPath);
    this.channel.appendLine(`\n=== ${new Date().toLocaleTimeString()} · ${name}: ${cmd}`);
    let tail = '';
    const append = (buf) => {
      const s = buf.toString();
      this.channel.append(s);
      tail = (tail + s).slice(-4000);
    };
    try {
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `sync + test: ${name}` },
        () => new Promise((resolve) => {
          const child = cp.spawn('bash', ['-lc', cmd], { cwd: repoPath });
          child.stdout.on('data', append);
          child.stderr.on('data', append);
          child.on('close', resolve);
          child.on('error', (e) => { append(String(e)); resolve(1); });
        })
      );
      if (code === 0) {
        vscode.window.setStatusBarMessage(`$(check) ${name}: synced with master, tests green`, 8000);
      } else {
        this.channel.show(true);
        this.launchFixAgent(repoPath, name, branch, tail);
      }
    } finally {
      this.running.delete(repoPath);
      this.refresh();
    }
  }

  launchFixAgent(repoPath, name, branch, tail) {
    const prompt =
      `The command "sync + test" for worktree ${name} (branch ${branch}, path ${repoPath}) failed. ` +
      `It runs the repository's test-integration flow: merge local master into the branch, then run the full test suite. ` +
      `Diagnose and fix the problem (merge conflicts and/or test failures) so the flow passes, following the repository rules. ` +
      `The output ended with:\n\n${tail}`;
    const promptFile = path.join(require('os').tmpdir(), `scm-diff-stats-fix-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt);
    const term = vscode.window.createTerminal({ name: `fix ${name}`, cwd: repoPath });
    term.show();
    term.sendText(`${findClaudeBin()} "$(cat '${promptFile}')"`);
    vscode.window.showWarningMessage(`${name}: sync + test failed — launched a fix agent in the terminal.`);
  }

  async runCi(cmd, repoPath, serial) {
    const ci = ciCommandPath();
    if (!ci) return;
    let args;
    if (cmd === 'new') {
      const slug = await vscode.window.showInputBox({
        prompt: 'Slug for the new PR (lowercase kebab-case)',
        validateInput: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'lowercase kebab-case'),
      });
      if (!slug) return;
      args = ['new', slug];
    } else if (!/^\d+$/.test(String(serial))) {
      return;
    } else if (cmd === 'test') {
      args = ['test', String(serial), '--fix'];
    } else if (cmd === 'preview' || cmd === 'land') {
      args = [cmd, String(serial)];
    } else {
      return;
    }
    // a real terminal: land's TTY gate and confirmation prompt need one,
    // and test/preview output stays visible and interactive
    const term = vscode.window.createTerminal({ name: 'ci ' + args.join(' '), cwd: repoPath });
    term.show();
    term.sendText("'" + ci + "' " + args.join(' '));
  }

  setRepos(paths) {
    this.repos = paths;
    this.refresh();
  }

  async refresh() {
    this.agents = scanAgents(this.repos);
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
    this.view.webview.postMessage({
      type: 'data', repos, syncEnabled: !!this.syncCommand(),
      previewEnabled: !!this.previewCommand(), ciEnabled: !!ciCommandPath(),
      agents: this.agents,
    });
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
    } else if (m.type === 'synctest') {
      this.runSyncTest(m.repoPath);
    } else if (m.type === 'preview') {
      this.runPreview(m.repoPath);
    } else if (m.type === 'ci') {
      this.runCi(m.cmd, m.repoPath, m.serial);
    } else if (m.type === 'commit') {
      const repoName = path.basename(m.repoPath);
      const steps = [
        ['add', '-A'],
        ['commit', '-m', m.message],
      ];
      if (m.push) steps.push(['push']);
      for (const args of steps) {
        const r = await gitFull(m.repoPath, args);
        if (r.code !== 0) {
          vscode.window.showErrorMessage(`${repoName}: git ${args[0]} failed — ${(r.err || r.out).trim().slice(0, 300)}`);
          this.refresh();
          return;
        }
      }
      const sha = (await git(m.repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
      vscode.window.setStatusBarMessage(`$(check) ${repoName}: committed ${sha}${m.push ? ' and pushed' : ''}`, 5000);
      if (this.view) this.view.webview.postMessage({ type: 'committed', repoPath: m.repoPath });
      this.refresh();
    } else if (m.type === 'open') {
      const uri = vscode.Uri.file(path.join(m.repoPath, m.path));
      const base = path.basename(m.path);
      try {
        if (m.mode === 'working') {
          await vscode.commands.executeCommand('git.openChange', uri).then(undefined, () =>
            vscode.commands.executeCommand('vscode.open', uri)
          );
        } else if (m.mode === 'vsmaster' && gitApi) {
          // a side that does not exist (file added/deleted on the branch)
          // must be an empty document, not a nonexistent git object
          const left = (await existsAtRef(m.repoPath, m.mergeBase, m.path))
            ? gitApi.toGitUri(uri, m.mergeBase)
            : emptyUri(uri);
          const right = fs.existsSync(uri.fsPath) ? uri : emptyUri(uri);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${base} (master ↔ branch)`);
        } else if (m.mode === 'commit' && gitApi) {
          const left = (await existsAtRef(m.repoPath, `${m.hash}^`, m.path))
            ? gitApi.toGitUri(uri, `${m.hash}^`)
            : emptyUri(uri);
          const right = (await existsAtRef(m.repoPath, m.hash, m.path))
            ? gitApi.toGitUri(uri, m.hash)
            : emptyUri(uri);
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
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    })
  );

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

  // every worktree of every known repo gets a row, even when it is not a
  // workspace folder (ci new creates worktrees without touching the workspace)
  const expandWorktrees = async (paths) => {
    const all = new Set(paths);
    for (const p of paths) {
      const out = await git(p, ['worktree', 'list', '--porcelain']);
      for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) {
          const wt = line.slice(9).trim();
          if (wt && fs.existsSync(wt)) all.add(wt);
        }
      }
    }
    return [...all];
  };

  const wireGitApi = async () => {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return false;
    gitApi = (await gitExt.activate()).getAPI(1);
    const sync = () =>
      expandWorktrees(gitApi.repositories.map((r) => r.rootUri.fsPath)).then((ps) => provider.setRepos(ps));
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
      ).then((rs) => expandWorktrees(rs.filter(Boolean))).then((ps) => provider.setRepos(ps));
    }
  });

  // worktrees outside the workspace get no git-extension change events;
  // a slow poll keeps their rows (and the land-readiness state) current
  const repoPoll = setInterval(() => {
    if (gitApi && gitApi.repositories.length) {
      expandWorktrees(gitApi.repositories.map((r) => r.rootUri.fsPath)).then((ps) => {
        if (ps.length !== provider.repos.length || ps.some((p) => !provider.repos.includes(p))) {
          provider.setRepos(ps);
        } else {
          scheduleRefresh();
        }
      });
    } else {
      scheduleRefresh();
    }
  }, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(repoPoll) });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(scheduleRefresh));
  context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => {
    if (t.name && t.name.startsWith('ci ')) scheduleRefresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('scmDiffStats')) provider.refresh();
  }));

  const agentPoll = setInterval(() => {
    const a = scanAgents(provider.repos);
    if (JSON.stringify(a) !== JSON.stringify(provider.agents)) {
      provider.agents = a;
      provider.push();
    }
  }, 7000);
  context.subscriptions.push({ dispose: () => clearInterval(agentPoll) });
}

function deactivate() {}

module.exports = { activate, deactivate };
