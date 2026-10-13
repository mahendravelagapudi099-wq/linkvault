/* LinkVault — AI-powered link manager (static build, all data in localStorage) */
'use strict';

const LS_LINKS = 'linkvault.links.v1';
const LS_SETTINGS = 'linkvault.settings.v1';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const CATEGORIES = ['Development', 'AI/ML', 'Design', 'DevOps', 'Data', 'Security', 'Mobile', 'Web', 'Productivity', 'Learning', 'News', 'Other'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- state ---------- */
function loadLinks() {
  try { return JSON.parse(localStorage.getItem(LS_LINKS)) || []; } catch { return []; }
}
function saveLinks(links) { localStorage.setItem(LS_LINKS, JSON.stringify(links)); }
function loadSettings() {
  try {
    const s = Object.assign({ geminiKey: '', tavilyKey: '', model: DEFAULT_MODEL }, JSON.parse(localStorage.getItem(LS_SETTINGS)) || {});
    // Migrate off the retired default: Google now recommends gemini-3.5-flash-lite / gemini-3.8-flash
    if (s.model === 'gemini-2.5-flash') s.model = DEFAULT_MODEL;
    return s;
  }
  catch { return { geminiKey: '', tavilyKey: '', model: DEFAULT_MODEL }; }
}
function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }

let links = loadLinks();
let settings = loadSettings();

/* ---------- pipeline ---------- */
function normalizeUrl(raw) {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const parsed = new URL(u);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported.');
  return parsed.toString();
}

function setStatus(html) { $('status').innerHTML = html; }
function step(msg) { setStatus(`<span class="step">${esc(msg)}</span>`); }

async function fetchMetadata(url) {
  const api = 'https://api.microlink.io?url=' + encodeURIComponent(url) + '&data.title&data.description&data.image&data.logo&data.author&data.publisher';
  const res = await fetch(api);
  if (!res.ok) throw new Error('Metadata service returned ' + res.status);
  const json = await res.json();
  if (json.status !== 'success') throw new Error('Metadata lookup failed');
  return json.data || {};
}

async function webSearch(query, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: 5, include_answer: true }),
  });
  if (!res.ok) throw new Error('Tavily returned ' + res.status);
  return res.json();
}

const ANALYSIS_PROMPT = (url, meta, searchCtx) => `Analyze this web link and return STRICT JSON only (no markdown fences, no commentary) with these keys:
{
  "summary": "2-3 sentence summary of what the page is about",
  "category": "exactly one of: ${CATEGORIES.join(', ')}",
  "tags": ["5-8 lowercase keyword tags"]
}
URL: ${url}
Title: ${meta.title || 'n/a'}
Description: ${meta.description || 'n/a'}
Publisher: ${meta.publisher || 'n/a'}
${searchCtx ? 'Web search context:\n' + searchCtx : ''}`;

async function analyzeWithGemini(url, meta, searchCtx, apiKey, model) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: ANALYSIS_PROMPT(url, meta, searchCtx) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error('Gemini API error ' + res.status + (err ? ': ' + err.slice(0, 160) : ''));
  }
  const json = await res.json();
  let text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

async function addLink() {
  const input = $('urlInput');
  const btn = $('addBtn');
  let url;
  try { url = normalizeUrl(input.value); }
  catch { setStatus('<span class="err">⚠️ That doesn\'t look like a valid http(s) URL.</span>'); return; }

  const existing = links.find((l) => l.url === url);
  if (existing) { setStatus('<span class="ok">Already in your vault — opening its report.</span>'); openReport(existing.id); return; }

  const entry = {
    id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    url, addedAt: new Date().toISOString(),
    status: 'processing', title: url, meta: {}, analysis: null, error: null,
  };
  links.unshift(entry); saveLinks(links); render();
  input.value = '';
  btn.disabled = true;

  try {
    step('Fetching page metadata…');
    const meta = await fetchMetadata(url).catch((e) => ({ _error: e.message }));
    entry.meta = meta;
    entry.title = meta.title || url;
    entry.favicon = meta.logo?.url || ('https://www.google.com/s2/favicons?domain=' + new URL(url).hostname + '&sz=64');
    saveLinks(links); render();

    let searchCtx = '';
    if (settings.tavilyKey) {
      step('Searching the web for context…');
      try {
        const s = await webSearch(entry.title, settings.tavilyKey);
        const bits = [];
        if (s.answer) bits.push('Answer: ' + s.answer);
        (s.results || []).forEach((r) => bits.push(`- ${r.title}: ${r.content?.slice(0, 300)}`));
        searchCtx = bits.join('\n').slice(0, 3000);
      } catch (e) { searchCtx = ''; /* search is optional — continue without it */ }
    }

    if (!settings.geminiKey) {
      entry.status = 'metadata-only';
      entry.error = 'Saved with metadata only — add your Gemini API key in Settings for AI analysis.';
    } else {
      step('Analyzing with Gemini…');
      const analysis = await analyzeWithGemini(url, meta, searchCtx, settings.geminiKey, settings.model || DEFAULT_MODEL);
      entry.analysis = {
        summary: analysis.summary || '',
        category: CATEGORIES.includes(analysis.category) ? analysis.category : 'Other',
        tags: Array.isArray(analysis.tags) ? analysis.tags.map(String) : [],
      };
      entry.status = 'done';
    }
  } catch (e) {
    entry.status = 'error';
    entry.error = e.message || 'Analysis failed.';
  }
  saveLinks(links); render(); btn.disabled = false;

  if (entry.status === 'done') {
    setStatus('<span class="ok">✅ Report ready.</span>');
    openReport(entry.id);
  } else if (entry.status === 'metadata-only') {
    setStatus('<span class="err">⚠️ ' + esc(entry.error) + '</span>');
  } else if (entry.status === 'error') {
    setStatus('<span class="err">❌ ' + esc(entry.error) + ' <button class="btn small" onclick="reanalyze(\'' + entry.id + '\')">Retry</button></span>');
  }
}

async function reanalyze(id) {
  const entry = links.find((l) => l.id === id);
  if (!entry || !settings.geminiKey) { openSettings(); return; }
  entry.status = 'processing'; entry.error = null; saveLinks(links); render();
  setStatus('');
  try {
    step('Re-analyzing with Gemini…');
    const analysis = await analyzeWithGemini(entry.url, entry.meta || {}, '', settings.geminiKey, settings.model || DEFAULT_MODEL);
    entry.analysis = {
      summary: analysis.summary || '',
      category: CATEGORIES.includes(analysis.category) ? analysis.category : 'Other',
      tags: Array.isArray(analysis.tags) ? analysis.tags.map(String) : [],
    };
    entry.status = 'done';
  } catch (e) { entry.status = 'error'; entry.error = e.message; }
  saveLinks(links); render();
  if (entry.status === 'done') openReport(id);
}
window.reanalyze = reanalyze;

function deleteLink(id) {
  const entry = links.find((l) => l.id === id);
  if (!entry) return;
  if (!confirm('Delete "' + (entry.title || entry.url).slice(0, 60) + '" from your vault?')) return;
  links = links.filter((l) => l.id !== id);
  saveLinks(links); render(); closeModals();
}
window.deleteLink = deleteLink;

/* ---------- backup: export / import ---------- */
function exportVault() {
  const payload = JSON.stringify(
    { app: 'linkvault', version: 1, exportedAt: new Date().toISOString(), links },
    null, 2
  );
  const filename = 'linkvault-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  // Android app: hand the file to the native bridge (saves to Downloads)
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.exportVault === 'function') {
      window.AndroidBridge.exportVault(filename, payload);
      setStatus('<span class="ok">✅ Backup sent — check your Downloads.</span>');
      return;
    }
  } catch (e) { /* fall through to browser download */ }
  // Browser fallback: blob download
  try {
    const blob = new Blob([payload], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
    setStatus('<span class="ok">✅ Backup downloaded.</span>');
  } catch (e) {
    setStatus('<span class="err">⚠️ Export failed in this browser.</span>');
  }
}

function importVault(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data) ? data : data.links;
      if (!Array.isArray(incoming)) throw new Error('not a linkvault backup');
      const seen = new Set(links.map((l) => l.url));
      let added = 0;
      for (const item of incoming) {
        if (!item || !item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        links.push({
          id: item.id || ('l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
          url: String(item.url),
          addedAt: item.addedAt || new Date().toISOString(),
          status: item.analysis ? 'done' : 'metadata-only',
          title: item.title || item.url,
          favicon: item.favicon || '',
          meta: item.meta || {},
          analysis: item.analysis ? {
            summary: String(item.analysis.summary || ''),
            category: CATEGORIES.includes(item.analysis.category) ? item.analysis.category : 'Other',
            tags: Array.isArray(item.analysis.tags) ? item.analysis.tags.map(String) : [],
          } : null,
          error: null,
        });
        added++;
      }
      saveLinks(links); render(); closeModals();
      setStatus('<span class="ok">✅ Imported ' + added + ' link' + (added === 1 ? '' : 's') + '.</span>');
    } catch (e) {
      setStatus('<span class="err">⚠️ That file is not a valid LinkVault backup.</span>');
    }
  };
  reader.onerror = () => setStatus('<span class="err">⚠️ Could not read that file.</span>');
  reader.readAsText(file);
}

/* ---------- relationships ---------- */
function relatedLinks(entry) {
  if (!entry.analysis) return [];
  const tags = new Set((entry.analysis.tags || []).map((t) => t.toLowerCase()));
  return links.filter((l) =>
    l.id !== entry.id && l.analysis &&
    (l.analysis.category === entry.analysis.category ||
      (l.analysis.tags || []).some((t) => tags.has(String(t).toLowerCase())))
  ).slice(0, 6);
}

/* ---------- rendering ---------- */
function badgeList(items) {
  return (items || []).map((t) => `<span class="badge">${esc(t)}</span>`).join('');
}

function render() {
  const q = $('searchInput').value.trim().toLowerCase();
  const cat = $('categoryFilter').value;

  const cats = [...new Set(links.map((l) => l.analysis?.category).filter(Boolean))].sort();
  const sel = $('categoryFilter');
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${esc(c)}"${c === cat ? ' selected' : ''}>${esc(c)}</option>`).join('');

  const filtered = links.filter((l) => {
    if (cat && l.analysis?.category !== cat) return false;
    if (!q) return true;
    const hay = [l.title, l.url, l.analysis?.summary, l.analysis?.category, ...(l.analysis?.tags || [])]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });

  $('count').textContent = filtered.length === links.length
    ? `${links.length} saved` : `${filtered.length} of ${links.length}`;

  const lib = $('library');
  if (!filtered.length) {
    lib.innerHTML = `<div class="empty"><span class="big">🗝️</span>
      ${links.length ? 'No links match your search.' : 'Your vault is empty.<br>Paste a URL above and LinkVault will analyze it for you.'}</div>`;
    return;
  }
  lib.innerHTML = filtered.map((l) => {
    const a = l.analysis;
    const processing = l.status === 'processing';
    return `<article class="card${processing ? ' processing' : ''}">
      <div class="card-top">
        ${l.favicon ? `<img class="favicon" src="${esc(l.favicon)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
        <h3><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.url)}</a></h3>
      </div>
      <div class="url">${esc(l.url)}</div>
      ${processing ? '<div class="meta"><span class="spinner"></span>Analyzing…</div>' : ''}
      ${l.status === 'error' ? `<div class="meta" style="color:var(--bad)">⚠️ ${esc(l.error || 'Failed')}</div>` : ''}
      ${a ? `<div class="badges"><span class="badge cat">${esc(a.category)}</span>${badgeList(a.tags.slice(0, 4))}</div>
      <p class="summary">${esc(a.summary)}</p>` : ''}
      <div class="meta">${new Date(l.addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</div>
      <div class="card-actions">
        ${a ? `<button class="btn small" onclick="openReport('${l.id}')">📄 Report</button>` : ''}
        ${(l.status === 'error' || l.status === 'metadata-only') && settings.geminiKey ? `<button class="btn small" onclick="reanalyze('${l.id}')">🔁 Analyze</button>` : ''}
        <button class="btn small danger" onclick="deleteLink('${l.id}')">Delete</button>
      </div>
    </article>`;
  }).join('');
}

function openReport(id) {
  const l = links.find((x) => x.id === id);
  if (!l || !l.analysis) return;
  const a = l.analysis;
  const rel = relatedLinks(l);
  $('reportBody').innerHTML = `<div class="report">
    <h2><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.url)}</a></h2>
    <span class="url">${esc(l.url)}</span>
    <div class="badges"><span class="badge cat">${esc(a.category)}</span>${badgeList(a.tags)}</div>
    <section><h4>Summary</h4><p>${esc(a.summary)}</p></section>
    ${rel.length ? `<section><h4>Related in your vault</h4><ul class="rel">${rel.map((r) =>
      `<li><a href="#" onclick="openReport('${r.id}');return false;">${esc(r.title || r.url)}</a><div class="why">${esc(r.analysis.category)} · ${esc((r.analysis.tags || []).slice(0, 3).join(', '))}</div></li>`).join('')}</ul></section>` : ''}
    <div class="report-actions">
      <button class="btn small danger" onclick="deleteLink('${l.id}')">Delete</button>
    </div>
  </div>`;
  $('reportModal').hidden = false;
}
window.openReport = openReport;

/* ---------- modals & settings ---------- */
function closeModals() { document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)); }
function openSettings() {
  $('geminiKey').value = settings.geminiKey || '';
  $('tavilyKey').value = settings.tavilyKey || '';
  $('geminiModel').value = settings.model || DEFAULT_MODEL;
  $('settingsModal').hidden = false;
}

/* ---------- events ---------- */
$('addBtn').addEventListener('click', addLink);
$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLink(); });
$('searchInput').addEventListener('input', render);
$('categoryFilter').addEventListener('change', render);
$('settingsBtn').addEventListener('click', openSettings);
$('exportBtn').addEventListener('click', exportVault);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) importVault(e.target.files[0]);
  e.target.value = '';
});
$('saveSettings').addEventListener('click', () => {
  settings = {
    geminiKey: $('geminiKey').value.trim(),
    tavilyKey: $('tavilyKey').value.trim(),
    model: $('geminiModel').value.trim() || DEFAULT_MODEL,
  };
  saveSettings(settings); closeModals(); render();
  setStatus('<span class="ok">✅ Settings saved.</span>');
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

if (!settings.geminiKey) {
  setStatus('👋 Add your Gemini API key in <b>⚙️ Settings</b> to enable AI analysis.');
}
render();

/* ---------- PWA: service worker + share target ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Handle links shared from other apps (Web Share Target: ?url= / ?text=)
(function handleSharedLink() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('url') || params.get('text') || '';
  if (!raw) return;
  history.replaceState({}, '', location.pathname);
  const m = raw.match(/https?:\/\/[^\s]+/i);
  const candidate = m ? m[0] : raw;
  try {
    normalizeUrl(candidate);
    $('urlInput').value = candidate;
    setStatus('<span class="ok">📥 Shared link received — analyzing…</span>');
    addLink();
  } catch {
    $('urlInput').value = raw;
    setStatus('<span class="err">⚠️ The shared text isn\'t a valid URL — edit it above and retry.</span>');
  }
})();
