const APP_VERSION = 'v1.2';

const WEIGHTS = {
  financial: 0.35,
  audit: 0.25,
  compliance: 0.25,
  geo: 0.15,
};

const DIM_META = [
  { id: 'financial',  barId: 'barFinancial',  val1: 'valFinancial',  val2: 'valFinancial2',  label: 'Financial Health',  weight: 0.35 },
  { id: 'audit',      barId: 'barAudit',      val1: 'valAudit',      val2: 'valAudit2',      label: 'Audit History',     weight: 0.25 },
  { id: 'compliance', barId: 'barCompliance', val1: 'valCompliance', val2: 'valCompliance2', label: 'Compliance Status', weight: 0.25 },
  { id: 'geo',        barId: 'barGeo',        val1: 'valGeo',        val2: 'valGeo2',        label: 'Geo & ESG Risk',    weight: 0.15 },
];

const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'mistral';

// ── Lazy library loader (#1) ──────────────────────────────────────────────────
// mammoth / pdf.js / docx are only needed when the user uploads documents.
// Loading them on demand (not in <head>) lets the list page render instantly.

let _libsLoaded  = false;
let _libsPromise = null;

// Loads mammoth + pdf.js — needed at assessment start.
// docx is NOT included here; it's loaded separately on first export (see loadDocxLibrary).
function loadLibraries() {
  if (_libsLoaded)  return Promise.resolve();
  if (_libsPromise) return _libsPromise;

  const CDN = [
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  ];

  _libsPromise = Promise.all(CDN.map(src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src     = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  }))).then(() => {
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    _libsLoaded = true;
  });

  return _libsPromise;
}

// Loads the docx export library on demand (~500KB). Only called when the user exports a .docx.
let _docxLoaded  = false;
let _docxPromise = null;

function loadDocxLibrary() {
  if (_docxLoaded)  return Promise.resolve();
  if (_docxPromise) return _docxPromise;
  _docxPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src     = 'https://cdn.jsdelivr.net/npm/docx@7.8.2/build/index.js';
    s.onload  = () => { _docxLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load docx library'));
    document.head.appendChild(s);
  });
  return _docxPromise;
}

let currentAbortController = null;
let debounceTimer = null;

// App state
let uploadedFiles    = [];
let activeSourceDocs = [];
let supplierTabs     = [];
let currentTabIdx    = -1;
let lastRenderData   = null;
let currentEvidence  = null;  // evidence extracted from documents

// List page sort + search state
let sortKey        = 'date';   // 'date' | 'status' | 'concerns' | 'addressed'
let sortDir        = 'desc';   // 'asc' | 'desc'
let listSearchQuery = '';      // live filter by supplier name

// ── localStorage persistence ──────────────────────────────────────────────────

const LS_TABS   = 'srisk_tabs';
const LS_ACTIVE = 'srisk_activeTab';
const LS_RAWDOCS_PREFIX = 'srisk_rawdocs_';

function saveTabsToStorage() {
  try {
    // Strip rawDocTexts from the main blob — they're stored separately per tab ID.
    // This keeps the main serialization small (metadata only) even with many suppliers.
    const stripped = supplierTabs.map(({ rawDocTexts, ...rest }) => rest);
    localStorage.setItem(LS_TABS,   JSON.stringify(stripped));
    localStorage.setItem(LS_ACTIVE, String(currentTabIdx));
    supplierTabs.forEach(tab => {
      if (!tab.id) return;
      if (tab.rawDocTexts) {
        try { localStorage.setItem(LS_RAWDOCS_PREFIX + tab.id, JSON.stringify(tab.rawDocTexts)); } catch {}
      }
    });
  } catch {}
}

function loadTabsFromStorage() {
  try {
    const stored = localStorage.getItem(LS_TABS);
    if (!stored) return;
    const tabs = JSON.parse(stored);
    if (!Array.isArray(tabs) || !tabs.length) return;
    // Backfill fields added in later versions (spread tab first, then fill missing)
    const now = Date.now();
    supplierTabs = tabs.map((tab, i) => {
      let concernsCount = tab.concernsCount != null ? tab.concernsCount : 0;
      if (tab.concernsCount == null && tab.evidence) {
        try { concernsCount = buildConcernsReportForTab(tab).length; } catch {}
      }
      // Rehydrate rawDocTexts from its separate key (fall back to inline for old data)
      let rawDocTexts = tab.rawDocTexts || null;
      if (!rawDocTexts && tab.id) {
        try {
          const raw = localStorage.getItem(LS_RAWDOCS_PREFIX + tab.id);
          if (raw) rawDocTexts = JSON.parse(raw);
        } catch {}
      }
      return {
        addressedConcerns: {},
        ...tab,
        rawDocTexts,
        dateAdded:     tab.dateAdded != null ? tab.dateAdded : (now - (tabs.length - i) * 60000),
        concernsCount,
      };
    });
    renderSupplierList();
  } catch (e) {
    console.warn('[Storage] Failed to restore tabs:', e.message);
  }
}

function clearAllTabs() {
  if (!confirm('Clear all saved suppliers? This cannot be undone.')) return;
  supplierTabs.forEach(tab => {
    if (tab.id) try { localStorage.removeItem(LS_RAWDOCS_PREFIX + tab.id); } catch {}
  });
  supplierTabs  = [];
  currentTabIdx = -1;
  try { localStorage.removeItem(LS_TABS); localStorage.removeItem(LS_ACTIVE); } catch {}
  renderSupplierList();
}

// ── Fallback (rule-based) helpers ─────────────────────────────────────────────

function compositeRuleBased(f, a, c, g) {
  return Math.round(f * WEIGHTS.financial + a * WEIGHTS.audit + c * WEIGHTS.compliance + g * WEIGHTS.geo);
}

function explainRuleBased(score, f, a, c, g) {
  if (score >= 70) {
    if (f >= 80 && c >= 70) return 'Strong financials and solid compliance make this supplier low-risk and ready to onboard.';
    if (g < 60) return 'Strong financials and audit history offset moderate geo and ESG exposure.';
    return 'Healthy scores across all dimensions. This supplier presents minimal onboarding risk.';
  }
  if (score >= 40) {
    if (f >= 70 && (a < 55 || c < 55)) return 'Strong financials offset moderate compliance gaps. Address audit history before full approval.';
    if (g < 45) return 'Elevated geo and ESG risk drags the overall score. Mitigation controls recommended.';
    if (a < 50) return 'Audit history is the primary concern. Request recent third-party audit documentation.';
    return 'Mixed profile — some dimensions are acceptable, but gaps require standard due diligence review.';
  }
  if (a < 35 && g < 45) return 'High geo risk and poor audit history flag this supplier for deep review before any engagement.';
  if (c < 35) return 'Critical compliance failures identified. Reject unless supplier can demonstrate immediate remediation.';
  if (f < 35) return 'Severe financial instability poses a supply continuity risk. Enhanced due diligence required.';
  return 'Multiple high-risk dimensions detected. This supplier requires enhanced due diligence before consideration.';
}

// ── Tier / recommendation / confidence ───────────────────────────────────────

function tier(score) {
  if (score >= 70) return { label: 'Fast-track',      cls: 'tier-green' };
  if (score >= 40) return { label: 'Standard review',  cls: 'tier-amber' };
  return               { label: 'Enhanced DD',         cls: 'tier-red'   };
}

function recommendation(score) {
  if (score >= 70) return { label: 'Suggested: Approve',     cls: 'rec-approve'     };
  if (score >= 40) return { label: 'Suggested: Conditional', cls: 'rec-conditional' };
  return               { label: 'Suggested: Reject',     cls: 'rec-reject'      };
}

function confidence(f, a, c, g) {
  const vals = [f, a, c, g];
  const avg = vals.reduce((a, b) => a + b, 0) / 4;
  const variance = vals.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / 4;
  const stdDev = Math.sqrt(variance);
  if (stdDev < 10) return { label: 'Consistent profile', cls: 'conf-high' };
  if (stdDev > 22) return { label: 'Variable profile',   cls: 'conf-low'  };
  return               { label: 'Mixed profile',     cls: 'conf-mid'  };
}

// ── Ollama API ────────────────────────────────────────────────────────────────

async function askOllama(prompt, signal) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, keep_alive: '30m', options: { num_ctx: 8192 } }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data.response;
}

async function fetchAiScore(f, a, c, g, signal) {
  const prompt =
    `You are a supplier risk analyst scoring a supplier for procurement onboarding. ` +
    `Score this supplier based on these four dimensions, each already rated out of 100: ` +
    `Financial health: ${f}/100, Audit history: ${a}/100, Compliance status: ${c}/100, Geo & ESG risk: ${g}/100. ` +
    `\n\nCalculate the composite risk score using this weighting: ` +
    `Financial health 35%, Audit history 25%, Compliance status 25%, Geo & ESG risk 15%. ` +
    `\n\nCalibration examples: ` +
    `A supplier scoring 88/82/85/79 should score in the high 70s to high 80s overall. ` +
    `A supplier scoring 60-65 across most dimensions should score in the 50s to low 60s. ` +
    `A supplier scoring below 35 across most dimensions should score below 35 overall. ` +
    `\n\nOnly deviate from the weighted average if one dimension is 30+ points below the others. ` +
    `\n\nReturn ONLY valid JSON, no markdown: ` +
    `{"score": <number 0-100>, "financial": ${f}, "audit": ${a}, "compliance": ${c}, "geo": ${g}}.`;

  const raw = await askOllama(prompt, signal);
  const cleaned = raw.trim().replace(/```json|```/g, '').replace(/\\"/g, '"').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new Error('AI score response was not valid JSON'); }

  const clamp = (val, fallback) => {
    const n = Math.round(Number(val));
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
  };

  const fallbackScore = compositeRuleBased(f, a, c, g);
  let score = clamp(parsed.score, fallbackScore);

  const hasRedFlag = (Math.max(f, a, c, g) - Math.min(f, a, c, g)) >= 30;
  if (!hasRedFlag && Math.abs(score - fallbackScore) > 20) {
    score = Math.round((score + fallbackScore) / 2);
  }

  return {
    score,
    financial:  clamp(parsed.financial,  f),
    audit:      clamp(parsed.audit,      a),
    compliance: clamp(parsed.compliance, c),
    geo:        clamp(parsed.geo,        g),
  };
}

async function fetchAiExplain(f, a, c, g, score, tierLabel, signal) {
  let evidenceContext = '';
  if (currentEvidence) {
    const ev = currentEvidence;
    const fmt = (arr) => arr && arr.length ? arr.map(s => `"${s}"`).join('; ') : 'none found';
    evidenceContext =
      `\n\nSpecific evidence found in uploaded documents:\n` +
      `Financial — Strengths: ${fmt(ev.financial_strengths)}; Concerns: ${fmt(ev.financial_concerns)}\n` +
      `Audit — Strengths: ${fmt(ev.audit_strengths)}; Concerns: ${fmt(ev.audit_concerns)}\n` +
      `Compliance — Strengths: ${fmt(ev.compliance_strengths)}; Concerns: ${fmt(ev.compliance_concerns)}\n` +
      `Geo/ESG — Strengths: ${fmt(ev.geo_strengths)}; Concerns: ${fmt(ev.geo_concerns)}\n` +
      `\nReference the specific findings above in your explanation rather than making generic statements.`;
  }

  const prompt =
    `You are a supplier risk analyst. A supplier has been scored: ` +
    `Financial health: ${f}/100, Audit history: ${a}/100, Compliance status: ${c}/100, ` +
    `Geo & ESG risk: ${g}/100, Composite: ${score}/100, Risk tier: ${tierLabel}.` +
    evidenceContext +
    `\n\nWrite a single paragraph (2-3 sentences) explaining the key risk drivers for the SPOC's decision. ` +
    `Be specific, cite actual findings where available. No bullet points. Plain text only.`;

  return await askOllama(prompt, signal);
}

// ── Document text extraction ──────────────────────────────────────────────────

async function extractTextFromPdf(file) {
  const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n');
}

async function extractTextFromDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

// ── Boilerplate stripping ─────────────────────────────────────────────────────

function stripBoilerplate(text) {
  return text
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t) return true;
      if (/^page\s+\d+\s+of\s+\d+$/i.test(t)) return false;
      if (/^\d+\s*\/\s*\d+$/.test(t)) return false;
      if (/^confidential(\s*[-–—]\s*page\s+\d+.*)?$/i.test(t)) return false;
      if (/^proprietary\s+and\s+confidential$/i.test(t)) return false;
      if (/^internal\s+use\s+only$/i.test(t)) return false;
      if (/^draft$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

// ── RAG: chunking ─────────────────────────────────────────────────────────────

function isHeaderLine(line) {
  const t = line.trim();
  if (!t || t.length > 80) return false;
  if (/^[A-Z][A-Z\s\d&/()\-]{3,}$/.test(t)) return true;    // ALL CAPS line
  if (/^\d+(\.\d+)*\s+[A-Z]/.test(t)) return true;           // "3.2 Section Title"
  if (/^[A-Z][^.!?]{3,60}:\s*$/.test(t)) return true;        // "Title case line:"
  return false;
}

function chunkText(text, fileName, maxChunk = 750) {
  const lines = text.split('\n');
  const chunks = [];
  let current = [];
  let currentLen = 0;

  const flush = () => {
    const block = current.join('\n').trim();
    if (block.length > 40) chunks.push({ text: block, fileName });
    current = [];
    currentLen = 0;
  };

  for (const line of lines) {
    if (isHeaderLine(line) && current.length > 0) flush();
    current.push(line);
    currentLen += line.length + 1;
    if (currentLen > maxChunk) flush();
  }
  flush();
  return chunks;
}

// ── RAG: embeddings ───────────────────────────────────────────────────────────

const EMBED_URL        = 'http://localhost:11434/api/embeddings';
const EMBED_BATCH_URL  = 'http://localhost:11434/api/embed';
const EMBED_MODEL      = 'nomic-embed-text';
const OLLAMA_VERSION_URL = 'http://localhost:11434/api/version';

let _batchEmbedSupported = null; // null = unchecked, true/false after first check

async function checkBatchEmbedSupport() {
  if (_batchEmbedSupported !== null) return _batchEmbedSupported;
  try {
    const res  = await fetch(OLLAMA_VERSION_URL);
    const data = await res.json();
    // /api/embed (batch) was added in Ollama 0.1.33
    const match = (data.version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      const [, major, minor, patch] = match.map(Number);
      _batchEmbedSupported =
        major > 0 || minor > 1 || (minor === 1 && patch >= 33);
    } else {
      _batchEmbedSupported = false;
    }
  } catch {
    _batchEmbedSupported = false;
  }
  console.log(`[RAG] batch embed (/api/embed) supported: ${_batchEmbedSupported}`);
  return _batchEmbedSupported;
}

async function embedText(text, signal) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text, keep_alive: '30m' }),
    signal,
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

async function embedBatch(texts, signal) {
  const res = await fetch(EMBED_BATCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '30m' }),
    signal,
  });
  if (!res.ok) throw new Error(`Embed batch HTTP ${res.status}`);
  const data = await res.json();
  return data.embeddings; // number[][]
}

async function buildIndex(chunks, signal) {
  const useBatch = await checkBatchEmbedSupport();

  if (useBatch) {
    console.log(`[RAG] embedding ${chunks.length} chunks via batch /api/embed`);
    const embeddings = await embedBatch(chunks.map(c => c.text), signal);
    return chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));
  }

  console.log(`[RAG] embedding ${chunks.length} chunks sequentially (fallback)`);
  const index = [];
  for (const chunk of chunks) {
    const embedding = await embedText(chunk.text, signal);
    index.push({ ...chunk, embedding });
  }
  return index;
}

// ── RAG: retrieval ────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

function retrieveTopK(queryEmbedding, index, k = 3) {
  return index
    .map(item => ({ ...item, sim: cosineSimilarity(queryEmbedding, item.embedding) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
}

// ── RAG: per-dimension extraction ─────────────────────────────────────────────

const DIM_QUERIES = {
  financial:  'revenue profit loss debt credit rating cash flow financial statements accounts receivable',
  audit:      'audit findings non-conformances corrective actions third-party audit certification ISO',
  compliance: 'regulatory compliance certifications fines sanctions enforcement HSE permits licence',
  geo:        'country of operation ESG environmental sustainability human rights supply chain risk geopolitical',
};

async function extractDimWithRAG(dimId, dimLabel, index, signal) {
  const queryEmbedding = await embedText(DIM_QUERIES[dimId], signal);
  const topChunks = retrieveTopK(queryEmbedding, index, 4);
  const context = topChunks.map(c => `[${c.fileName}]\n${c.text}`).join('\n\n---\n\n');

  const prompt =
    `You are a supplier risk analyst. Using ONLY the excerpts below, assess the supplier's ${dimLabel}.\n\n` +
    `Return ONLY valid JSON, no markdown:\n` +
    `{"score":75,"strengths":["specific finding (filename)"],"concerns":["specific finding (filename)"]}\n\n` +
    `Rules:\n` +
    `- Score 0-100. Negative signals (fines, losses, failed audits) → low (<40). Positive signals → high (>70). No relevant data → 50.\n` +
    `- Each finding must quote or closely paraphrase text actually present in the excerpts.\n` +
    `- Include the filename in parentheses after each finding.\n` +
    `- Maximum 4 items each. Use [] if none found. Do NOT invent findings.\n\n` +
    `Excerpts:\n${context}`;

  console.log(`[RAG:${dimId}] estimated prompt tokens:`, Math.ceil(prompt.length / 4));
  const raw = await askOllama(prompt, signal);
  const cleaned = raw.trim().replace(/```json|```/g, '').replace(/\\"/g, '"').trim();
  return JSON.parse(cleaned);
}

async function extractNameWithRAG(index, signal) {
  const queryEmbedding = await embedText('company name supplier organization legal entity registered name', signal);
  const topChunks = retrieveTopK(queryEmbedding, index, 2);
  const context = topChunks.map(c => c.text).join('\n\n');
  const prompt =
    `From these document excerpts, extract the company or supplier name.\n` +
    `Return ONLY the company name as a plain string, nothing else. If not found, return: Unknown\n\n${context}`;
  const raw = await askOllama(prompt, signal);
  return raw.trim().replace(/^["']|["']$/g, '');
}

async function extractWithRAG(rawTexts, signal) {
  const t0 = performance.now();

  showLoader('Reading your documents…');
  const allChunks = [];
  for (const { text, fileName } of rawTexts) {
    const stripped = stripBoilerplate(text);
    allChunks.push(...chunkText(stripped, fileName));
  }
  console.log(`[RAG] total chunks: ${allChunks.length}`);

  showLoader('Identifying key information…');
  const t1 = performance.now();
  const index = await buildIndex(allChunks, signal);
  console.log(`[RAG] embedding done in ${((performance.now() - t1) / 1000).toFixed(1)}s`);

  showLoader('Analysing risk across 4 dimensions…');
  const t2 = performance.now();

  const dims = [
    { id: 'financial',  label: 'Financial Health'  },
    { id: 'audit',      label: 'Audit History'      },
    { id: 'compliance', label: 'Compliance Status'  },
    { id: 'geo',        label: 'Geo & ESG Risk'     },
  ];

  const [name, ...dimResults] = await Promise.all([
    extractNameWithRAG(index, signal),
    ...dims.map(({ id, label }) =>
      extractDimWithRAG(id, label, index, signal).catch(() => ({
        score: 50, strengths: [], concerns: [],
      }))
    ),
  ]);

  console.log(`[RAG] generation done in ${((performance.now() - t2) / 1000).toFixed(1)}s`);
  console.log(`[RAG] total assessment time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const result = { name };
  dims.forEach(({ id }, i) => {
    const dr = dimResults[i];
    result[id]                = Number.isFinite(dr.score) ? dr.score : 50;
    result[id + '_strengths'] = Array.isArray(dr.strengths) ? dr.strengths : [];
    result[id + '_concerns']  = Array.isArray(dr.concerns)  ? dr.concerns  : [];
  });

  return result;
}

// ── Combined extraction (scores + evidence) — fallback when embeddings unavailable ──

async function extractScoresAndEvidence(combinedText) {
  const prompt =
    `You are a supplier risk analyst extracting risk scores and evidence from supplier documents.\n\n` +
    `For each of the four risk dimensions, score 0-100 AND list specific evidence found in the documents.\n\n` +
    `Dimensions:\n` +
    `- financial: revenue, profit, debt, credit rating, cash flow, losses, insolvency, late filings\n` +
    `- audit: audit findings, non-conformances, corrective actions, third-party audits, certifications\n` +
    `- compliance: certifications held, regulatory compliance, fines, sanctions, enforcement actions, HSE\n` +
    `- geo: country of operation, ESG performance, environmental incidents, sustainability, human rights\n\n` +
    `Scoring rules:\n` +
    `- Negative signals (fines, losses, failed audits, sanctions) → score LOW (below 40)\n` +
    `- Positive signals (growth, clean audits, certifications, good ESG) → score HIGH (above 70)\n` +
    `- Missing dimension → 50\n\n` +
    `Evidence rules:\n` +
    `- Each item must quote or closely paraphrase text actually present in the documents\n` +
    `- Include the document filename in parentheses: e.g. "Revenue grew 15% to £42m (annual_report.pdf)"\n` +
    `- Use [] if no evidence found for a category — do NOT invent findings\n` +
    `- Maximum 4 items per strength/concern list\n\n` +
    `Return ONLY this JSON (no markdown, no backticks, no explanation):\n` +
    `{"name":"Company","financial":75,"audit":60,"compliance":85,"geo":70,` +
    `"financial_strengths":["finding (file.pdf)"],"financial_concerns":["finding (file.pdf)"],` +
    `"audit_strengths":[],"audit_concerns":["finding (file.pdf)"],` +
    `"compliance_strengths":["finding (file.pdf)"],"compliance_concerns":[],` +
    `"geo_strengths":[],"geo_concerns":["finding (file.pdf)"]}\n\n` +
    `Documents:\n${combinedText}`;

  const raw = await askOllama(prompt, null);
  const cleaned = raw.trim().replace(/```json|```/g, '').replace(/\\"/g, '"').trim();
  return JSON.parse(cleaned);
}

// ── Evidence panel rendering ──────────────────────────────────────────────────

function renderEvidencePanel(evidence, fileNames) {
  currentEvidence = evidence;

  const section  = document.getElementById('evidenceSection');
  const grid     = document.getElementById('evidenceGrid');
  const noteEl   = document.getElementById('evidenceNote');

  section.classList.remove('hidden');
  noteEl.innerHTML = 'Based on: ' + fileNames.map(n => `<span class="evidence-file-chip">${escHtml(n)}</span>`).join('');

  const tab       = currentTabIdx >= 0 ? supplierTabs[currentTabIdx] : null;
  const addressed = (tab && tab.addressedConcerns) || {};

  grid.innerHTML = '';
  grid.insertAdjacentHTML('beforeend', DIM_META.map(dim => {
    const strengths  = evidence[dim.id + '_strengths'] || [];
    const concerns   = evidence[dim.id + '_concerns']  || [];
    const baseScore  = +document.getElementById(dim.id).value;
    const dispScore  = tab && tab.addressedSubScores ? (tab.addressedSubScores[dim.id] ?? baseScore) : baseScore;
    const scoreColor = dispScore >= 70 ? '#15803d' : dispScore >= 40 ? '#b45309' : '#b91c1c';

    const strengthItems = strengths.length
      ? strengths.map(t => {
          const displayText = parseConcernSnippet(t);
          const srcFile     = parseConcernFileName(t);
          return `<li class="ev-strength">${escHtml(displayText)}` +
            (srcFile ? `<span class="concern-source-chip">📎 ${escHtml(srcFile)}</span>` : '') + `</li>`;
        }).join('')
      : `<li class="ev-empty">None found in documents</li>`;

    const concernItems = concerns.length
      ? concerns.map(t => {
          const key         = concernKey(t.trim());
          const done        = !!addressed[key];
          const displayText = parseConcernSnippet(t);
          const srcFile     = parseConcernFileName(t);
          const chipHtml    = srcFile ? `<span class="concern-source-chip">📎 ${escHtml(srcFile)}</span>` : '';
          if (done) {
            return `<li class="ev-concern">` +
              `<span class="ev-concern-addressed-wrap">` +
              `<button class="ev-concern-view-btn ev-concern-text-addressed" type="button" data-concern="${escHtml(t)}">${escHtml(displayText)}</button>` +
              chipHtml +
              `<span class="ev-concern-addressed-badge">✓ Addressed</span>` +
              `</span></li>`;
          }
          return `<li class="ev-concern"><button class="ev-concern-view-btn" type="button" data-concern="${escHtml(t)}">${escHtml(displayText)}</button>${chipHtml}</li>`;
        }).join('')
      : `<li class="ev-empty">None found in documents</li>`;

    return `
      <div class="ev-card" data-dim="${dim.id}">
        <div class="ev-card-header">
          <span class="ev-dim-label">${escHtml(dim.label)}</span>
          <span class="ev-score" style="color:${scoreColor}">${dispScore}</span>
        </div>
        <div class="ev-section">
          <div class="ev-section-title ev-strengths-title">✓ Strengths found</div>
          <ul class="ev-list">${strengthItems}</ul>
        </div>
        <div class="ev-section">
          <div class="ev-section-title ev-concerns-title">⚠ Concerns found</div>
          <ul class="ev-list">${concernItems}</ul>
        </div>
      </div>`;
  }).join(''));

  // Wire concern-view click handlers (open document viewer)
  grid.querySelectorAll('.ev-concern-view-btn').forEach(btn => {
    btn.addEventListener('click', () => openDocViewer(btn.dataset.concern, currentTabIdx));
  });
}

// ── Concerns report ───────────────────────────────────────────────────────────

function getSeverity(dimScore) {
  if (dimScore < 40) return 'HIGH';
  if (dimScore < 65) return 'MEDIUM';
  return 'LOW';
}

// Elevates severity based on the concern text content, overriding the dimension-score default.
function getSeverityFromText(text, dimScore) {
  const t = text.toLowerCase();
  const highSignals = ['fine', 'sanction', 'enforcement action', 'criminal', 'insolvency', 'prosecution', 'suspended operations', 'ceased operations', 'fatality', 'fatal incident'];
  const medSignals  = ['non-conformance', 'ncr', 'major finding', 'critical', 'overdue', 'lapsed', 'expired certification', 'warning letter', 'corrective action'];
  if (highSignals.some(s => t.includes(s))) return 'HIGH';
  if (medSignals.some(s => t.includes(s))) return 'MEDIUM';
  return getSeverity(dimScore);
}

function buildConcernsReport(evidence) {
  const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const concerns = [];

  DIM_META.forEach(dim => {
    const items = evidence[dim.id + '_concerns'] || [];
    const score = +document.getElementById(dim.id).value;
    items.forEach(text => {
      if (text && text.trim()) {
        concerns.push({
          dimension: dim.label,
          text: text.trim(),
          severity: getSeverityFromText(text.trim(), score),
          dimScore: score,
        });
      }
    });
  });

  // Deduplicate by normalised text
  const seen = new Set();
  const deduped = concerns.filter(c => {
    const key = c.text.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity] ||
    a.dimension.localeCompare(b.dimension)
  );

  return deduped;
}

function renderConcernsReport(concerns) {
  const section = document.getElementById('concernsSection');
  const list    = document.getElementById('concernsList');

  if (!concerns.length) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = '';

  const tab      = currentTabIdx >= 0 ? supplierTabs[currentTabIdx] : null;
  const addressed = (tab && tab.addressedConcerns) || {};

  const sevMeta = {
    HIGH:   { cls: 'sev-high',   label: 'HIGH'   },
    MEDIUM: { cls: 'sev-medium', label: 'MEDIUM' },
    LOW:    { cls: 'sev-low',    label: 'LOW'    },
  };

  concerns.forEach(c => {
    const sm   = sevMeta[c.severity];
    const key  = concernKey(c.text);
    const done = !!addressed[key];

    const row = document.createElement('div');
    row.className    = `concern-row${done ? ' addressed' : ''}`;
    row.dataset.key  = key;

    // Checkbox for bulk-select (only on unaddressed)
    if (!done) {
      const cb = document.createElement('input');
      cb.type      = 'checkbox';
      cb.className = 'concern-check';
      cb.dataset.key = key;
      cb.addEventListener('change', updateMarkSelectedBtn);
      row.appendChild(cb);
    }

    const badge = document.createElement('span');
    badge.className   = `sev-badge ${sm.cls}`;
    badge.textContent = sm.label;

    const displayText = parseConcernSnippet(c.text);
    const srcFile     = parseConcernFileName(c.text);
    const body = document.createElement('div');
    body.className = 'concern-body';
    body.innerHTML =
      `<span class="concern-dim">${escHtml(c.dimension)}</span>` +
      `<button class="concern-text concern-view-btn" type="button" data-concern="${escHtml(c.text)}">${escHtml(displayText)}</button>` +
      (srcFile ? `<span class="concern-source-chip">📎 ${escHtml(srcFile)}</span>` : '') +
      (done ? `<span class="concern-addressed-ts">Addressed ${escHtml(addressed[key].ts)}</span>` : '');
    body.querySelector('.concern-view-btn').addEventListener('click', e => {
      e.stopPropagation();
      openDocViewer(c.text, currentTabIdx);
    });

    if (done) {
      const check = document.createElement('span');
      check.className   = 'concern-addressed-check';
      check.textContent = '✓';
      row.append(badge, body, check);
    } else {
      row.append(badge, body);
    }
    list.appendChild(row);
  });

  updateMarkSelectedBtn();

  refreshConcernsBadge();
}

// ── Concerns letter export (.docx) ────────────────────────────────────────────

async function exportConcernsLetter(supplierName, concerns) {
  try {
    await loadDocxLibrary();
  } catch {
    alert('Word export library could not be loaded. Please check your internet connection and try again.');
    return;
  }
  if (typeof window.docx === 'undefined') {
    alert('Word export library not loaded. Please check your internet connection and try again.');
    return;
  }

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    AlignmentType, UnderlineType, BorderStyle,
  } = window.docx;

  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const body = [];

  // Title
  body.push(new Paragraph({
    text: 'Supplier Risk Assessment – Clarification Request',
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 200 },
  }));

  // Date + addressee
  body.push(new Paragraph({
    children: [new TextRun({ text: `Date: ${today}`, size: 22 })],
    spacing: { after: 120 },
  }));
  body.push(new Paragraph({
    children: [new TextRun({ text: `Addressed to: ${supplierName}`, size: 22 })],
    spacing: { after: 400 },
  }));

  // Opening
  body.push(new Paragraph({
    children: [new TextRun({
      text: `Dear ${supplierName} Team,`,
      size: 22,
    })],
    spacing: { after: 200 },
  }));

  body.push(new Paragraph({
    children: [new TextRun({
      text:
        `Following our risk assessment based on the documents you have provided, we have identified a number of items ` +
        `that require further clarification or supporting evidence. This document outlines our findings and the specific ` +
        `information we are requesting.`,
      size: 22,
    })],
    spacing: { after: 160 },
  }));

  body.push(new Paragraph({
    children: [new TextRun({
      text:
        `We appreciate your cooperation in addressing the points below. Our aim is to complete the assessment accurately ` +
        `and fairly, and we welcome any additional context you can provide.`,
      size: 22,
    })],
    spacing: { after: 400 },
  }));

  // Group concerns by severity
  const grouped = { HIGH: [], MEDIUM: [], LOW: [] };
  concerns.forEach(c => grouped[c.severity].push(c));

  const severityConfig = [
    { key: 'HIGH',   label: 'High Priority Concerns' },
    { key: 'MEDIUM', label: 'Medium Priority Concerns' },
    { key: 'LOW',    label: 'Low Priority / Informational Concerns' },
  ];

  let hasAny = false;
  severityConfig.forEach(({ key, label }) => {
    const items = grouped[key];
    if (!items.length) return;
    hasAny = true;

    body.push(new Paragraph({
      text: label,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 400, after: 160 },
    }));

    items.forEach(c => {
      // Source extraction: text typically ends with "(filename)"
      const srcMatch = c.text.match(/\(([^)]+)\)\s*$/);
      const sourceRef = srcMatch ? srcMatch[1] : 'submitted documentation';
      const issueText = srcMatch ? c.text.slice(0, c.text.lastIndexOf('(')).trim() : c.text;

      body.push(new Paragraph({
        children: [new TextRun({ text: c.dimension, bold: true, size: 22 })],
        spacing: { after: 80 },
      }));

      body.push(new Paragraph({
        children: [
          new TextRun({ text: 'Issue: ', bold: true, size: 22 }),
          new TextRun({ text: issueText, size: 22 }),
        ],
        spacing: { after: 60 },
        indent: { left: 360 },
      }));

      body.push(new Paragraph({
        children: [
          new TextRun({ text: 'Source: ', bold: true, size: 22 }),
          new TextRun({ text: sourceRef, italics: true, size: 22 }),
        ],
        spacing: { after: 60 },
        indent: { left: 360 },
      }));

      body.push(new Paragraph({
        children: [
          new TextRun({ text: 'Clarification requested: ', bold: true, size: 22 }),
          new TextRun({
            text: clarificationRequest(c.dimension, issueText),
            size: 22,
          }),
        ],
        spacing: { after: 240 },
        indent: { left: 360 },
      }));
    });
  });

  if (!hasAny) {
    body.push(new Paragraph({
      children: [new TextRun({ text: 'No concerns were identified in the current document set.', size: 22 })],
      spacing: { after: 200 },
    }));
  }

  // Closing
  body.push(new Paragraph({
    children: [new TextRun({
      text: `Please respond within 10 business days with any supporting documentation or clarifications. ` +
            `If you have questions about any of the items above, please contact our procurement team directly.`,
      size: 22,
    })],
    spacing: { before: 400, after: 280 },
  }));

  body.push(new Paragraph({
    children: [new TextRun({ text: 'Sincerely,', size: 22 })],
    spacing: { after: 160 },
  }));
  body.push(new Paragraph({
    children: [new TextRun({ text: 'Procurement Risk Team', size: 22, bold: true })],
    spacing: { after: 80 },
  }));

  const doc = new Document({
    sections: [{ children: body }],
  });

  const blob = await Packer.toBlob(doc);
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `${(supplierName || 'supplier').replace(/[^a-z0-9]/gi, '_')}_concerns_letter.docx`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

// Produce a relevant clarification request sentence based on dimension + issue text
function clarificationRequest(dimension, issueText) {
  const dim = dimension.toLowerCase();
  const text = issueText.toLowerCase();

  if (dim.includes('financial')) {
    if (text.includes('debt') || text.includes('loss') || text.includes('insolvency')) {
      return 'Please provide your most recent audited accounts, a current cash-flow statement, and any creditor arrangements in place.';
    }
    return 'Please provide your most recent audited financial statements and confirmation of current credit standing.';
  }
  if (dim.includes('audit')) {
    if (text.includes('non-conformance') || text.includes('ncr') || text.includes('finding')) {
      return 'Please provide evidence that this non-conformance has been formally closed, including the corrective action plan and closure sign-off.';
    }
    return 'Please provide your most recent third-party audit report and current certification status.';
  }
  if (dim.includes('compliance')) {
    if (text.includes('fine') || text.includes('sanction') || text.includes('enforcement')) {
      return 'Please provide details of the regulatory action taken, its current status, and steps taken to prevent recurrence.';
    }
    if (text.includes('expir') || text.includes('lapsed')) {
      return 'Please provide evidence of renewal or an updated certification that covers the current period.';
    }
    return 'Please provide current copies of all relevant certifications and any outstanding regulatory correspondence.';
  }
  if (dim.includes('geo') || dim.includes('esg')) {
    if (text.includes('sanction') || text.includes('high-risk') || text.includes('myanmar') || text.includes('russia')) {
      return 'Please provide details of your sanctions screening process and confirm that all operations in flagged jurisdictions comply with applicable regulations.';
    }
    if (text.includes('environmental') || text.includes('carbon') || text.includes('emission')) {
      return 'Please provide your most recent sustainability or ESG report and any incident response documentation.';
    }
    return 'Please provide your current ESG policy, most recent sustainability data, and any third-party ESG rating reports.';
  }
  return 'Please provide supporting documentation or a written response addressing this point.';
}

// ── Decision button state ─────────────────────────────────────────────────────

function setDecisionButtonsDisabled(disabled) {
  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => {
    document.getElementById(id).disabled = disabled;
  });
}

// ── Screen transitions ────────────────────────────────────────────────────────

// ── Page navigation ───────────────────────────────────────────────────────────

function goToList() {
  document.getElementById('mainScreen').style.display = 'none';
  document.getElementById('listPage').style.display   = '';
  currentTabIdx = -1;
  renderSupplierList();
}

function goToDetail(idx) {
  document.getElementById('listPage').style.display   = 'none';
  document.getElementById('mainScreen').style.display = 'flex';
  if (idx >= 0 && idx < supplierTabs.length) {
    loadTab(idx);
  }
}

// ── Reusable confirm modal ────────────────────────────────────────────────────

function confirmModal({ title, body, confirmLabel = 'Delete', icon = '⚠', onConfirm }) {
  const modal      = document.getElementById('confirmModal');
  const titleEl    = document.getElementById('confirmModalTitle');
  const bodyEl     = document.getElementById('confirmModalBody');
  const confirmBtn = document.getElementById('confirmModalConfirm');
  const cancelBtn  = document.getElementById('confirmModalCancel');
  const backdrop   = document.getElementById('confirmModalBackdrop');
  const iconEl     = document.getElementById('confirmModalIcon');

  titleEl.textContent    = title;
  bodyEl.textContent     = body;
  confirmBtn.textContent = confirmLabel;
  iconEl.textContent     = icon;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  cancelBtn.focus();

  function close() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', close);
    backdrop.removeEventListener('click', close);
    document.removeEventListener('keydown', handleKey);
  }

  function handleConfirm() {
    close();
    onConfirm();
  }

  function handleKey(e) {
    if (e.key === 'Escape') close();
  }

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', handleKey);
}

// ── Addressed-pill color ──────────────────────────────────────────────────────

function addressedPillStyle(addressed, total) {
  if (total <= 0 || addressed <= 0) return '';
  const ratio = Math.min(1, addressed / total);
  // Interpolate hue 0 (red) → 120 (green) through orange/yellow
  const hue = Math.round(ratio * 120);
  return `background:hsl(${hue},75%,93%);color:hsl(${hue},62%,28%);border-color:hsl(${hue},60%,82%);`;
}

// ── Supplier list actions ─────────────────────────────────────────────────────

function deleteSupplier(idx) {
  const tab = supplierTabs[idx];
  if (!tab) return;
  const name = tab.name || 'this supplier';
  confirmModal({
    title:         `Delete "${name}"?`,
    body:          `This will permanently remove all associated documents, evidence, and decision history. This cannot be undone.`,
    confirmLabel:  'Delete',
    icon:          '⚠',
    onConfirm() {
      const delTab = supplierTabs[idx];
      if (delTab && delTab.id) try { localStorage.removeItem(LS_RAWDOCS_PREFIX + delTab.id); } catch {}
      supplierTabs.splice(idx, 1);
      saveTabsToStorage();
      renderSupplierList();
    },
  });
}

function exportSupplierSummaryFromList(idx) {
  const tab = supplierTabs[idx];
  if (!tab) return;
  const t       = tier(tab.score || 0);
  const clrMap  = { 'tier-green': '#16a34a', 'tier-amber': '#d97706', 'tier-red': '#dc2626' };
  const clr     = clrMap[t.cls] || '#64748b';
  const dateStr = tab.dateAdded
    ? new Date(tab.dateAdded).toLocaleDateString([], { day: '2-digit', month: 'long', year: 'numeric' })
    : '—';
  const decisionBadge = { Approve: '#16a34a', Escalate: '#d97706', Reject: '#dc2626' }[tab.decision] || '#64748b';

  const win = window.open('', '_blank', 'width=820,height=700');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Supplier Summary – ${escHtml(tab.name || 'Unnamed')}</title>
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:48px;color:#1e293b;max-width:700px;margin:0 auto;}
      h1{font-size:22px;font-weight:700;margin-bottom:4px;}
      .meta{color:#64748b;font-size:13px;margin-bottom:32px;}
      .score-block{display:flex;align-items:baseline;gap:8px;margin-bottom:24px;}
      .score-num{font-size:56px;font-weight:800;color:${clr};}
      .score-label{font-size:18px;color:#64748b;}
      .tier{display:inline-block;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600;background:${clr}22;color:${clr};margin-bottom:24px;}
      table{width:100%;border-collapse:collapse;margin-bottom:24px;}
      th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;padding:8px 12px;border-bottom:2px solid #e2e8f0;}
      td{padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;}
      .bar{height:6px;border-radius:3px;background:#e2e8f0;margin-top:4px;}
      .bar-fill{height:6px;border-radius:3px;}
      .decision{display:inline-block;padding:3px 12px;border-radius:12px;font-size:13px;font-weight:600;background:${decisionBadge}22;color:${decisionBadge};}
      .explain{font-size:13px;color:#475569;line-height:1.6;border-left:3px solid #e2e8f0;padding-left:12px;margin-top:16px;}
      .footer{margin-top:40px;font-size:11px;color:#94a3b8;}
      @media print{body{padding:24px;}}
    </style></head><body>
    <h1>${escHtml(tab.name || 'Unnamed Supplier')}</h1>
    <div class="meta">Assessed ${dateStr} &nbsp;·&nbsp; Source: ${(tab.sourceDocs || []).map(escHtml).join(', ') || 'Manual entry'}</div>
    <div class="score-block"><span class="score-num">${tab.score || 0}</span><span class="score-label">/ 100</span></div>
    <div class="tier">${escHtml(t.label)}</div>
    <table>
      <tr><th>Dimension</th><th>Score</th><th style="width:40%">Weight</th></tr>
      ${[['Financial Health','f','35%'],['Audit History','a','25%'],['Compliance Status','c','25%'],['Geo & ESG Risk','g','15%']].map(([lbl,k,wt]) => {
        const v = tab[k] || 0;
        const bc = v >= 70 ? '#16a34a' : v >= 40 ? '#d97706' : '#dc2626';
        return `<tr><td>${lbl}</td><td><strong>${v}</strong></td><td><div class="bar"><div class="bar-fill" style="width:${v}%;background:${bc};"></div></div><small style="color:#94a3b8;">${wt} weight</small></td></tr>`;
      }).join('')}
    </table>
    ${tab.decision ? `<p>Decision: <span class="decision">${escHtml(tab.decision)}</span></p>` : ''}
    ${tab.notes ? `<p style="font-size:13px;color:#475569;margin-top:8px;"><strong>Notes:</strong> ${escHtml(tab.notes)}</p>` : ''}
    ${tab.explainText ? `<div class="explain">${escHtml(tab.explainText)}</div>` : ''}
    <div class="footer">Supplier Risk Scoring — generated ${new Date().toLocaleString()}</div>
    </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
}

function exportConcernsLetterForTab(idx) {
  const tab = supplierTabs[idx];
  if (!tab || !tab.evidence) {
    alert('No document evidence available for this supplier. Run a document assessment first.');
    return;
  }
  const concerns = buildConcernsReportForTab(tab);
  if (!concerns.length) {
    alert('No concerns found for this supplier.');
    return;
  }
  exportConcernsLetter(tab.name || 'Supplier', concerns);
}

// ── Status chart ──────────────────────────────────────────────────────────────

function renderStatusChart() {
  const el = document.getElementById('statusChart');
  if (!el) return;

  if (!supplierTabs.length) {
    el.classList.add('hidden');
    return;
  }

  const counts = { Approve: 0, Escalate: 0, Reject: 0, Pending: 0 };
  supplierTabs.forEach(tab => {
    const k = tab.decision || 'Pending';
    if (counts[k] !== undefined) counts[k]++;
    else counts.Pending++;
  });

  const total = supplierTabs.length;
  const segments = [
    { key: 'Approve',  label: 'Approved',  color: '#16a34a' },
    { key: 'Escalate', label: 'Escalated', color: '#d97706' },
    { key: 'Reject',   label: 'Rejected',  color: '#dc2626' },
    { key: 'Pending',  label: 'Pending',   color: '#94a3b8' },
  ];

  // SVG donut: r=40, cx=cy=50, stroke-width=20 → inner r=30
  const r = 40;
  const cx = 50;
  const cy = 50;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const paths = segments.map(seg => {
    const frac  = total > 0 ? counts[seg.key] / total : 0;
    const dash  = frac * circumference;
    const gap   = circumference - dash;
    const el    = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="20"` +
                  ` stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"` +
                  ` stroke-dashoffset="${(-offset).toFixed(2)}"` +
                  ` transform="rotate(-90 ${cx} ${cy})" />`;
    offset += dash;
    return el;
  }).join('');

  const legendRows = segments.map(seg => {
    const pct = total > 0 ? Math.round((counts[seg.key] / total) * 100) : 0;
    return `<div class="status-legend-row">` +
      `<span class="status-legend-dot" style="background:${seg.color}"></span>` +
      `<span class="status-legend-label">${seg.label}</span>` +
      `<span class="status-legend-count">${counts[seg.key]}</span>` +
      `<span class="status-legend-pct">${pct}%</span>` +
      `</div>`;
  }).join('');

  el.classList.remove('hidden');
  el.innerHTML =
    `<div class="status-chart-title">Supplier Status</div>` +
    `<svg class="status-chart-donut" width="100" height="116" viewBox="0 0 100 116">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f1f5f9" stroke-width="20"/>` +
    paths +
    `<text x="${cx}" y="${cy - 6}" text-anchor="middle" dominant-baseline="central" font-size="18" font-weight="700" fill="#1e293b">${total}</text>` +
    `<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="9" fill="#94a3b8" letter-spacing="0.04em">SUPPLIERS</text>` +
    `</svg>` +
    `<div class="status-chart-legend">${legendRows}</div>`;
}

// ── Supplier list rendering ───────────────────────────────────────────────────

function renderSupplierList() {
  const wrap       = document.getElementById('supplierListWrap');
  const emptyState = document.getElementById('listEmptyState');
  const toolbar    = document.getElementById('listToolbar');
  const countEl    = document.getElementById('listCount');
  if (!wrap) return;

  if (!supplierTabs.length) {
    wrap.innerHTML = '';
    emptyState.classList.remove('hidden');  // show empty state
    toolbar.style.visibility = 'hidden';
    return;
  }

  emptyState.classList.add('hidden');
  toolbar.style.visibility = '';
  countEl.textContent = `${supplierTabs.length} supplier${supplierTabs.length !== 1 ? 's' : ''}`;

  // Sort + search filter
  const statusOrder = { Approve: 0, Escalate: 1, null: 2, undefined: 2, Reject: 3 };
  const q = listSearchQuery.toLowerCase().trim();
  const sorted = supplierTabs
    .map((tab, i) => ({ ...tab, _origIdx: i }))
    .filter(tab => !q || (tab.name || '').toLowerCase().includes(q))
    .sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'date') {
        cmp = (b.dateAdded || 0) - (a.dateAdded || 0);
      } else if (sortKey === 'name') {
        cmp = (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
      } else if (sortKey === 'status') {
        cmp = (statusOrder[a.decision] ?? 2) - (statusOrder[b.decision] ?? 2);
      } else if (sortKey === 'concerns') {
        cmp = (b.concernsCount || 0) - (a.concernsCount || 0);
      } else if (sortKey === 'addressed') {
        cmp = Object.keys(b.addressedConcerns || {}).length
            - Object.keys(a.addressedConcerns || {}).length;
      }
      return sortDir === 'asc' ? -cmp : cmp;
    });

  if (!sorted.length && q) {
    wrap.innerHTML = `<div class="list-no-results">No suppliers match "<strong>${escHtml(q)}</strong>"</div>`;
    renderStatusChart();
    return;
  }

  wrap.innerHTML = sorted.map(tab => {
    const decision    = tab.decision || 'Pending';
    const decisionCls = { Approve: 'status-approved', Escalate: 'status-escalated',
                          Reject: 'status-rejected', Pending: 'status-pending' }[decision] || 'status-pending';
    const concerns  = tab.concernsCount || 0;
    const addressed = Object.keys(tab.addressedConcerns || {}).length;
    const addrStyle = addressedPillStyle(addressed, concerns);
    const dotCls    = { 'tier-green': 'dot-green', 'tier-amber': 'dot-amber',
                        'tier-red': 'dot-red' }[tab.tierCls] || 'dot-grey';
    const dateStr   = tab.dateAdded
      ? new Date(tab.dateAdded).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
      : '—';
    const hasConcerns = tab.evidence && (tab.concernsCount || 0) > 0;
    return `
      <div class="supplier-row" data-idx="${tab._origIdx}" role="button" tabindex="0">
        <div class="supplier-row-left">
          <span class="sup-tab-dot ${dotCls}"></span>
          <div class="supplier-row-info">
            <span class="supplier-row-name">${escHtml(tab.name || 'Unnamed')}</span>
            <span class="supplier-row-meta">Score ${tab.score || 0} &nbsp;·&nbsp; Added ${dateStr}</span>
          </div>
        </div>
        <div class="supplier-row-right">
          ${concerns  > 0 ? `<span class="concern-pill">${concerns} concern${concerns !== 1 ? 's' : ''}</span>` : ''}
          ${addressed > 0 ? `<span class="addressed-pill"${addrStyle ? ` style="${addrStyle}"` : ''}>${addressed} of ${concerns} addressed</span>` : ''}
          <span class="status-pill ${decisionCls}">${escHtml(decision)}</span>
          <span class="row-chevron">›</span>
          <div class="row-actions" role="presentation">
            <div class="row-export-wrap">
              <button class="row-export-btn" data-idx="${tab._origIdx}" type="button" title="Export options">⬇</button>
              <div class="row-export-menu hidden">
                <button class="row-export-item" data-action="pdf" data-idx="${tab._origIdx}" type="button">Summary PDF</button>
                <button class="row-export-item${hasConcerns ? '' : ' disabled'}" data-action="letter" data-idx="${tab._origIdx}" type="button">Concerns Letter (.docx)</button>
              </div>
            </div>
            <button class="row-delete-btn" data-idx="${tab._origIdx}" type="button" title="Delete supplier">✕</button>
          </div>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.supplier-row').forEach(row => {
    const open = () => goToDetail(+row.dataset.idx);
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  // Delete buttons
  wrap.querySelectorAll('.row-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteSupplier(+btn.dataset.idx);
    });
  });

  // Export toggle + items
  wrap.querySelectorAll('.row-export-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const isOpen = !menu.classList.contains('hidden');
      // Close all other menus first
      wrap.querySelectorAll('.row-export-menu').forEach(m => m.classList.add('hidden'));
      if (!isOpen) menu.classList.remove('hidden');
    });
  });

  wrap.querySelectorAll('.row-export-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.classList.contains('disabled')) return;
      const idx = +btn.dataset.idx;
      if (btn.dataset.action === 'pdf') exportSupplierSummaryFromList(idx);
      else exportConcernsLetterForTab(idx);
      btn.closest('.row-export-menu').classList.add('hidden');
    });
  });

  // Close export menus when clicking elsewhere
  document.addEventListener('click', closeAllExportMenus, { once: true });
  function closeAllExportMenus() {
    wrap.querySelectorAll('.row-export-menu').forEach(m => m.classList.add('hidden'));
  }

  // Sync sort button states
  document.querySelectorAll('.sort-btn').forEach(btn => {
    const isActive = btn.dataset.sort === sortKey;
    btn.classList.toggle('active', isActive);
    btn.classList.toggle('desc', isActive && sortDir === 'desc');
    btn.classList.toggle('asc',  isActive && sortDir === 'asc');
  });

  // Sync search input value
  const searchInput = document.getElementById('listSearch');
  if (searchInput && searchInput.value !== listSearchQuery) searchInput.value = listSearchQuery;

  renderStatusChart();
}

// ── Upload modal ──────────────────────────────────────────────────────────────

function showUploadModal() {
  uploadedFiles = [];
  updateModalChips();
  document.getElementById('uploadModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function hideUploadModal() {
  uploadedFiles = [];
  updateModalChips();
  document.getElementById('uploadModal').classList.add('hidden');
  document.body.style.overflow = '';
}

function updateModalChips() {
  const list     = document.getElementById('modalFileChipList');
  const beginBtn = document.getElementById('modalBeginBtn');
  if (!uploadedFiles.length) {
    list.classList.add('hidden');
    list.innerHTML = '';
    beginBtn.disabled = true;
    return;
  }
  list.classList.remove('hidden');
  list.innerHTML = uploadedFiles.map((f, i) =>
    `<span class="file-chip">` +
    `<span class="file-chip-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>` +
    `<button class="file-chip-remove" data-idx="${i}" type="button" aria-label="Remove">×</button>` +
    `</span>`
  ).join('');
  list.querySelectorAll('.file-chip-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      uploadedFiles.splice(+btn.dataset.idx, 1);
      updateModalChips();
    });
  });
  beginBtn.disabled = false;
}

// ── Concerns count (without DOM) ──────────────────────────────────────────────

function buildConcernsReportForTab(tab) {
  if (!tab || !tab.evidence) return [];
  const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const scores = { financial: tab.f || 0, audit: tab.a || 0, compliance: tab.c || 0, geo: tab.g || 0 };
  const concerns = [];
  DIM_META.forEach(dim => {
    const items = tab.evidence[dim.id + '_concerns'] || [];
    const score = scores[dim.id];
    items.forEach(text => {
      if (text && text.trim()) {
        concerns.push({ dimension: dim.label, text: text.trim(),
          severity: getSeverityFromText(text.trim(), score), dimScore: score });
      }
    });
  });
  const seen = new Set();
  return concerns
    .filter(c => { const k = c.text.toLowerCase().replace(/\s+/g, ' '); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.dimension.localeCompare(b.dimension));
}

// ── Inline upload panel ───────────────────────────────────────────────────────


// ── Source documents ──────────────────────────────────────────────────────────

function renderSourceDocs(fileNames) {
  activeSourceDocs = fileNames || [];
  const section = document.getElementById('sourceDocs');
  const chips   = document.getElementById('sourceDocChips');
  if (!activeSourceDocs.length) {
    section.classList.add('hidden');
    chips.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  chips.innerHTML = activeSourceDocs
    .map(n => `<span class="source-chip" title="${escHtml(n)}">${escHtml(n)}</span>`)
    .join('');
}

// ── Supplier tabs ─────────────────────────────────────────────────────────────

function renderTabs() {
  // Tab bar removed — list page is now the navigation surface.
  // Keep as a no-op so existing callers don't throw.
}

function loadTab(idx) {
  const tab = supplierTabs[idx];
  if (!tab) return;
  currentTabIdx = idx;

  if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
  clearTimeout(debounceTimer);

  document.getElementById('supplierName').value  = tab.name;
  document.getElementById('financial').value      = tab.f;
  document.getElementById('audit').value          = tab.a;
  document.getElementById('compliance').value     = tab.c;
  document.getElementById('geo').value            = tab.g;
  DIM_META.forEach((dim, i) => {
    document.getElementById(dim.val1).textContent = [tab.f, tab.a, tab.c, tab.g][i];
  });

  renderCard({
    name:        tab.name,
    score:       tab.addressedScore       ?? tab.score,
    subScores:   tab.addressedSubScores   ?? tab.subScores,
    explainText: tab.addressedExplainText ?? tab.explainText,
    f: tab.f, a: tab.a, c: tab.c, g: tab.g,
  });

  const banner = document.getElementById('decisionBanner');
  if (tab.decision) {
    banner.textContent = tab.bannerText || '';
    banner.className   = 'decision-banner banner-' + tab.decision.toLowerCase();
    setDecisionButtonsDisabled(true);
    document.getElementById('btnReset').classList.remove('hidden');
  } else {
    banner.textContent = '';
    banner.className   = 'decision-banner hidden';
    setDecisionButtonsDisabled(false);
    document.getElementById('btnReset').classList.add('hidden');
  }

  document.getElementById('spocNotes').value = tab.notes || '';
  document.getElementById('uploadStatus').textContent = '';

  renderSourceDocs(tab.sourceDocs || []);
  setSliderAiMode(tab.evidence ? true : false, (tab.sourceDocs || []).length);
  setAiNotice(false);

  // Restore evidence if this tab had it
  currentEvidence = tab.evidence || null;
  if (tab.evidence) {
    renderEvidencePanel(tab.evidence, tab.sourceDocs || []);
    renderConcernsReport(buildConcernsReport(tab.evidence));
  } else {
    document.getElementById('evidenceSection').classList.add('hidden');
    document.getElementById('concernsSection').classList.add('hidden');
  }

  renderScoreHistory(tab);
  renderTabs();
}

function addOrUpdateTab(tabData) {
  if (currentTabIdx === -1) {
    const newTab = {
      id:                Date.now().toString(),
      dateAdded:         Date.now(),
      addressedConcerns: {},
      concernsCount:     0,
      ...tabData,
    };
    supplierTabs.push(newTab);
    currentTabIdx = supplierTabs.length - 1;
  } else {
    supplierTabs[currentTabIdx] = { ...supplierTabs[currentTabIdx], ...tabData };
  }
  saveTabsToStorage();
}

function saveCurrentTab(data) {
  if (currentTabIdx < 0 || currentTabIdx >= supplierTabs.length) return;
  supplierTabs[currentTabIdx] = { ...supplierTabs[currentTabIdx], ...data };
  saveTabsToStorage();
}

function saveTabAt(idx, data) {
  if (idx < 0 || idx >= supplierTabs.length) return;
  supplierTabs[idx] = { ...supplierTabs[idx], ...data };
  saveTabsToStorage();
}

// ── Reset main screen ─────────────────────────────────────────────────────────

function resetMainScreen() {
  if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
  clearTimeout(debounceTimer);
  currentTabIdx   = -1;
  currentEvidence = null;

  document.getElementById('supplierName').value  = '';
  document.getElementById('financial').value      = 0;
  document.getElementById('audit').value          = 0;
  document.getElementById('compliance').value     = 0;
  document.getElementById('geo').value            = 0;
  DIM_META.forEach(dim => {
    document.getElementById(dim.val1).textContent = '0';
    document.getElementById(dim.val2).textContent = '';
  });

  document.getElementById('cardName').textContent       = '—';
  document.getElementById('compositeScore').textContent = '—';
  document.getElementById('tierBadge').textContent      = '—';
  document.getElementById('tierBadge').className        = 'tier-badge';
  document.getElementById('explainText').textContent    = '—';
  document.getElementById('recLabel').textContent       = '—';
  document.getElementById('recLabel').className         = 'rec-pill';
  document.getElementById('confidenceLabel').textContent = '';
  document.getElementById('confidenceLabel').className   = 'confidence-label';

  const _shtoggle = document.getElementById('scoreHistoryToggle');
  const _shlist   = document.getElementById('scoreHistoryList');
  if (_shtoggle) { _shtoggle.classList.add('hidden'); _shtoggle.setAttribute('aria-expanded', 'false'); }
  if (_shlist)   { _shlist.classList.add('hidden'); _shlist.innerHTML = ''; }

  const ring = document.getElementById('scoreRing');
  const circumference = 2 * Math.PI * 54;
  ring.style.strokeDasharray  = circumference;
  ring.style.strokeDashoffset = circumference;
  ring.style.stroke = '#e2e8f0';

  DIM_META.forEach(dim => setBar(dim.barId, 0));

  const banner = document.getElementById('decisionBanner');
  banner.className   = 'decision-banner hidden';
  banner.textContent = '';
  document.getElementById('spocNotes').value = '';
  setDecisionButtonsDisabled(false);
  document.getElementById('btnReset').classList.add('hidden');
  document.getElementById('uploadStatus').textContent = '';

  renderSourceDocs([]);
  setSliderAiMode(false);
  setAiNotice(false);
  hideLoader();
  document.getElementById('evidenceSection').classList.add('hidden');
  document.getElementById('concernsSection').classList.add('hidden');
  lastRenderData = null;
}

// ── Begin assessment (multi-doc) ──────────────────────────────────────────────

async function handleBeginAssessment() {
  const modalBeginBtn = document.getElementById('modalBeginBtn');

  const fileNames   = uploadedFiles.map(f => f.name);
  const filesForExt = [...uploadedFiles];
  uploadedFiles = [];

  // Load document libraries on demand — show status in the button (#1, #5)
  if (!_libsLoaded) {
    if (modalBeginBtn) { modalBeginBtn.disabled = true; modalBeginBtn.textContent = 'Loading libraries…'; }
    try {
      await loadLibraries();
    } catch {
      if (modalBeginBtn) { modalBeginBtn.disabled = false; modalBeginBtn.textContent = 'Begin Assessment →'; }
      alert('Could not load required libraries. Check your internet connection and try again.');
      return;
    }
  }

  if (modalBeginBtn) { modalBeginBtn.disabled = true; modalBeginBtn.textContent = 'Extracting…'; }

  // Close modal and navigate to detail view before any async work
  hideUploadModal();
  document.getElementById('listPage').style.display   = 'none';
  document.getElementById('mainScreen').style.display = 'flex';
  resetMainScreen();  // sets currentTabIdx = -1
  renderSourceDocs(fileNames);

  // Push a new tab synchronously so it's in the list immediately
  const placeholderName = fileNames.length > 0
    ? fileNames[0].replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'New Supplier'
    : 'New Supplier';
  supplierTabs.push({
    id:                Date.now().toString(),
    name:              placeholderName,
    score:             0,
    tierCls:           '',
    f: 0, a: 0, c: 0, g: 0,
    sourceDocs:        [...fileNames],
    evidence:          null,
    subScores:         null,
    explainText:       '',
    decision:          null,
    notes:             '',
    bannerText:        '',
    fullTs:            '',
    addressedConcerns: {},
    dateAdded:         Date.now(),
    concernsCount:     0,
  });
  currentTabIdx = supplierTabs.length - 1;
  saveTabsToStorage();
  const myTabIdx = currentTabIdx;

  const statusEl = document.getElementById('uploadStatus');
  if (modalBeginBtn) { modalBeginBtn.disabled = false; modalBeginBtn.textContent = 'Begin Assessment →'; }

  // Extract text from uploaded files
  const rawTexts = [];
  for (let i = 0; i < filesForExt.length; i++) {
    const file = filesForExt[i];
    const ext  = file.name.split('.').pop().toLowerCase();
    let text   = '';
    try {
      if (ext === 'pdf')       text = await extractTextFromPdf(file);
      else if (ext === 'docx') text = await extractTextFromDocx(file);
    } catch { /* skip unreadable */ }
    if (text.trim()) rawTexts.push({ text: text.trim(), fileName: file.name });
  }

  if (!rawTexts.length) {
    errorLoader('Could not read any documents — please check the file format and try again.');
    statusEl.textContent = 'Could not read any documents — enter scores manually.';
    // Placeholder tab stays; user can enter scores manually on it
    return;
  }

  showLoader(`Reading ${fileNames.length} document${fileNames.length > 1 ? 's' : ''}…`);
  statusEl.textContent = `Extracting scores and evidence with AI…`;

  let parsed;
  try {
    parsed = await extractWithRAG(rawTexts, null);
  } catch (ragErr) {
    console.warn('[RAG failed, trying full-text fallback]', ragErr.message);
    showLoader('RAG unavailable — trying full-text extraction…');
    const combinedText = rawTexts
      .map((r, i) => {
        const t = r.text;
        const chunk = t.length > 4000
          ? t.slice(0, 2000) + '\n\n[... middle omitted ...]\n\n' + t.slice(-2000)
          : t;
        return `=== DOCUMENT ${i + 1}: ${r.fileName} ===\n${chunk}`;
      })
      .join('\n\n');
    try {
      parsed = await extractScoresAndEvidence(combinedText);
    } catch (err) {
      console.warn('[Full-text extraction failed, falling back to scores-only]', err.message);
      showLoader('Full extraction failed — retrying with simplified scoring…');
      try {
        parsed = await extractScoresOnly(combinedText);
      } catch {
        errorLoader('AI unavailable — Ollama may not be running. Enter scores manually.');
        statusEl.textContent = 'AI unavailable — enter scores manually.';
        // Placeholder tab stays; user can enter scores manually on it
        return;
      }
    }
  }

  const clamp = v => Math.min(100, Math.max(0, Math.round(Number(v))));
  const f = Number.isFinite(+parsed.financial)  ? clamp(parsed.financial)  : 50;
  const a = Number.isFinite(+parsed.audit)       ? clamp(parsed.audit)      : 50;
  const c = Number.isFinite(+parsed.compliance)  ? clamp(parsed.compliance) : 50;
  const g = Number.isFinite(+parsed.geo)         ? clamp(parsed.geo)        : 50;

  const extractedName = (typeof parsed.name === 'string' && parsed.name.trim())
    ? parsed.name.trim()
    : placeholderName;

  document.getElementById('supplierName').value = extractedName;
  document.getElementById('financial').value    = f;
  document.getElementById('audit').value        = a;
  document.getElementById('compliance').value   = c;
  document.getElementById('geo').value          = g;
  DIM_META.forEach((dim, i) => {
    document.getElementById(dim.val1).textContent = [f, a, c, g][i];
  });

  // Render evidence panel if evidence arrays were returned
  const hasEvidence = ['financial_strengths','financial_concerns','audit_strengths','audit_concerns',
    'compliance_strengths','compliance_concerns','geo_strengths','geo_concerns']
    .some(k => Array.isArray(parsed[k]));

  if (hasEvidence) {
    renderEvidencePanel(parsed, fileNames);
    const concerns = buildConcernsReport(parsed);
    renderConcernsReport(concerns);
    statusEl.textContent =
      `Scores and evidence extracted from ${fileNames.length} document${fileNames.length > 1 ? 's' : ''}. Adjust sliders if needed.`;
  } else {
    statusEl.textContent =
      `Scores extracted from ${fileNames.length} document${fileNames.length > 1 ? 's' : ''}. Adjust sliders if needed.`;
  }

  hideLoader();
  setSliderAiMode(true, fileNames.length);

  const initialScore  = compositeRuleBased(f, a, c, g);
  const concernsCount = hasEvidence
    ? buildConcernsReportForTab({ evidence: parsed, f, a, c, g }).length
    : 0;

  const MAX_RAW_CHARS = 14000;
  saveTabAt(myTabIdx, {
    name:         extractedName,
    score:        initialScore,
    tierCls:      tier(initialScore).cls,
    f, a, c, g,
    sourceDocs:   [...fileNames],
    evidence:     currentEvidence ? { ...currentEvidence } : null,
    concernsCount,
    rawDocTexts:  rawTexts.map(({ text, fileName }) => ({
      fileName,
      text: text.length > MAX_RAW_CHARS
        ? text.slice(0, MAX_RAW_CHARS) + '\n\n[Document truncated — showing first ~4 pages]'
        : text,
    })),
  });

  currentTabIdx = myTabIdx;
  updateCard();
}

// Scores-only fallback (simpler JSON, more reliable)
async function extractScoresOnly(combinedText) {
  const prompt =
    `You are a supplier risk analyst. Read the supplier documents and return scores only.\n\n` +
    `Return ONLY valid JSON: {"name":"Company","financial":75,"audit":60,"compliance":85,"geo":70}\n\n` +
    `Documents:\n${combinedText}`;
  const raw     = await askOllama(prompt, null);
  const cleaned = raw.trim().replace(/```json|```/g, '').replace(/\\"/g, '"').trim();
  return JSON.parse(cleaned);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setLoading(on) {
  if (on) {
    document.getElementById('compositeScore').textContent = '…';
    document.getElementById('explainText').textContent    = 'Analysing with AI…';
  }
}

// ── Loading indicator ─────────────────────────────────────────────────────────

function showLoader(msg) {
  const el = document.getElementById('loadingIndicator');
  el.classList.remove('hidden', 'loading-error');
  document.getElementById('loadingText').textContent = msg;
}

function hideLoader() {
  document.getElementById('loadingIndicator').classList.add('hidden');
}

function errorLoader(msg) {
  const el = document.getElementById('loadingIndicator');
  el.classList.remove('hidden');
  el.classList.add('loading-error');
  document.getElementById('loadingText').textContent = msg;
}

function setSliderAiMode(on, docCount) {
  const panel = document.getElementById('sliderPanel');
  const bar   = document.getElementById('aiModeBar');
  const label = document.getElementById('aiModeLabel');
  if (!panel || !bar) return;
  if (on) {
    panel.classList.add('ai-assessed');
    bar.classList.remove('hidden');
    if (label && docCount != null) {
      label.textContent = `AI-assessed · ${docCount} document${docCount !== 1 ? 's' : ''}`;
    }
  } else {
    panel.classList.remove('ai-assessed');
    bar.classList.add('hidden');
  }
}

function setAiNotice(show) {
  let el = document.getElementById('aiNotice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'aiNotice';
    el.className = 'ai-notice hidden';
    document.querySelector('.explain-block').insertAdjacentElement('beforebegin', el);
  }
  el.textContent = show ? 'AI unavailable — using rule-based scoring' : '';
  el.classList.toggle('hidden', !show);
}

function showToast(message, linkText, linkFn, duration = 5000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="toast-msg">${escHtml(message)}</span>` +
    (linkText ? `<button class="toast-link" type="button">${escHtml(linkText)}</button>` : '');
  if (linkText && linkFn) {
    toast.querySelector('.toast-link').addEventListener('click', () => { linkFn(); toast.remove(); });
  }
  container.appendChild(toast);
  const dismiss = () => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s';
    setTimeout(() => toast.remove(), 220);
  };
  setTimeout(dismiss, duration);
}

function renderCard({ name, score, subScores, explainText, f, a, c, g }) {
  lastRenderData = { name, score, subScores, explainText, f, a, c, g };

  const safeScore = Number.isFinite(score) ? score : compositeRuleBased(f, a, c, g);
  const t    = tier(safeScore);
  const rec  = recommendation(safeScore);
  const conf = confidence(f, a, c, g);

  document.getElementById('cardName').textContent       = name;
  document.getElementById('compositeScore').textContent = safeScore;
  document.getElementById('tierBadge').textContent      = t.label;
  document.getElementById('tierBadge').className        = 'tier-badge ' + t.cls;
  document.getElementById('explainText').textContent    = explainText;
  document.getElementById('recLabel').textContent       = rec.label;
  document.getElementById('recLabel').className         = 'rec-pill ' + rec.cls;

  const confEl = document.getElementById('confidenceLabel');
  confEl.textContent = conf.label;
  confEl.className   = 'confidence-label ' + conf.cls;
  confEl.title       = 'Reflects how consistent the 4 dimension scores are. Variable = scores differ significantly across areas — examine each dimension individually.';

  updateActionButtons(t.cls);

  const displayVals = subScores
    ? [subScores.financial, subScores.audit, subScores.compliance, subScores.geo]
    : [f, a, c, g];

  DIM_META.forEach((dim, i) => {
    const v = displayVals[i];
    setBar(dim.barId, v);
    document.getElementById(dim.val1).textContent = v;
    document.getElementById(dim.val2).textContent = v;
  });

  const ring = document.getElementById('scoreRing');
  const circumference = 2 * Math.PI * 54;
  ring.style.strokeDasharray  = circumference;
  ring.style.strokeDashoffset = circumference * (1 - safeScore / 100);
  ring.style.stroke = safeScore >= 70 ? '#16a34a' : safeScore >= 40 ? '#d97706' : '#dc2626';
}

function setBar(id, value) {
  const fill = document.getElementById(id);
  fill.style.width      = value + '%';
  fill.style.background = value >= 70 ? '#16a34a' : value >= 40 ? '#d97706' : '#dc2626';
}

// ── Main update ───────────────────────────────────────────────────────────────

function updateCard() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runUpdate, 400);
}

async function runUpdate() {
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  const signal    = currentAbortController.signal;
  const myTabIdx  = currentTabIdx;  // lock in which tab this scoring run belongs to

  const name = document.getElementById('supplierName').value.trim() || 'Unnamed Supplier';
  const f = +document.getElementById('financial').value;
  const a = +document.getElementById('audit').value;
  const c = +document.getElementById('compliance').value;
  const g = +document.getElementById('geo').value;

  document.getElementById('cardName').textContent = name;
  DIM_META.forEach((dim, i) => {
    const v = [f, a, c, g][i];
    document.getElementById(dim.val1).textContent = v;
    document.getElementById(dim.val2).textContent = v;
  });

  const ring = document.getElementById('scoreRing');
  const circumference = 2 * Math.PI * 54;
  ring.style.strokeDasharray  = circumference;
  ring.style.strokeDashoffset = circumference;
  ring.style.stroke = '#e2e8f0';

  const quickScore = compositeRuleBased(f, a, c, g);
  const quickTier  = tier(quickScore);
  document.getElementById('tierBadge').textContent = quickTier.label;
  document.getElementById('tierBadge').className   = 'tier-badge ' + quickTier.cls;
  updateActionButtons(quickTier.cls);
  DIM_META.forEach((dim, i) => setBar(dim.barId, [f, a, c, g][i]));
  const quickRec = recommendation(quickScore);
  document.getElementById('recLabel').textContent = quickRec.label;
  document.getElementById('recLabel').className   = 'rec-pill ' + quickRec.cls;

  // If evidence is loaded and sliders changed, refresh the concerns report with new scores
  if (currentEvidence) {
    renderConcernsReport(buildConcernsReport(currentEvidence));
    // Refresh evidence score badges
    DIM_META.forEach(dim => {
      const scoreEl = document.querySelector(`.ev-card[data-dim="${dim.id}"] .ev-score`);
      if (scoreEl) {
        const v = +document.getElementById(dim.id).value;
        scoreEl.textContent = v;
        scoreEl.style.color = v >= 70 ? '#15803d' : v >= 40 ? '#b45309' : '#b91c1c';
      }
    });
  }

  setLoading(true);
  showLoader('Generating AI risk score…');

  try {
    const scoreData = await fetchAiScore(f, a, c, g, signal);
    if (signal.aborted) return;

    showLoader('Generating explanation…');
    const t = tier(scoreData.score);
    const explainText = await fetchAiExplain(f, a, c, g, scoreData.score, t.label, signal);
    if (signal.aborted) return;

    if (signal.aborted) return;
    hideLoader();
    setAiNotice(false);
    // Only render and save if the user hasn't navigated away from this tab
    if (currentTabIdx === myTabIdx) {
      renderCard({ name, score: scoreData.score, subScores: scoreData, explainText: explainText.trim(), f, a, c, g });
    }
    saveTabAt(myTabIdx, {
      name, score: scoreData.score,
      tierCls:    tier(scoreData.score).cls,
      subScores:  scoreData,
      explainText: explainText.trim(),
      f, a, c, g,
    });
    const _snapTrigger = (supplierTabs[myTabIdx]?.scoreHistory?.length ?? 0) === 0
      ? 'Initial assessment' : 'Score updated';
    pushScoreSnapshot(myTabIdx, {
      score: scoreData.score,
      subScores: { financial: scoreData.financial, audit: scoreData.audit, compliance: scoreData.compliance, geo: scoreData.geo },
      explainText: explainText.trim(),
      trigger: _snapTrigger,
    });
    if (currentTabIdx === myTabIdx) renderScoreHistory(supplierTabs[myTabIdx]);

  } catch (err) {
    if (signal.aborted) return;
    console.warn('[AI] Falling back to rule-based:', err.message);
    const score       = compositeRuleBased(f, a, c, g);
    const explainText = explainRuleBased(score, f, a, c, g);
    if (currentTabIdx === myTabIdx) {
      errorLoader('AI unavailable — showing rule-based score');
      setAiNotice(true);
      renderCard({ name, score, subScores: null, explainText, f, a, c, g });
    }
    saveTabAt(myTabIdx, { name, score, tierCls: tier(score).cls, subScores: null, explainText, f, a, c, g });
    const _fbTrigger = (supplierTabs[myTabIdx]?.scoreHistory?.length ?? 0) === 0
      ? 'Initial assessment (rule-based)' : 'Score updated (rule-based)';
    pushScoreSnapshot(myTabIdx, {
      score,
      subScores: { financial: f, audit: a, compliance: c, geo: g },
      explainText,
      trigger: _fbTrigger,
    });
    if (currentTabIdx === myTabIdx) renderScoreHistory(supplierTabs[myTabIdx]);
  }
}

// ── Action buttons ────────────────────────────────────────────────────────────

function updateActionButtons(tierCls) {
  const map = { 'tier-green': 'approve', 'tier-amber': 'escalate', 'tier-red': 'reject' };
  const suggested = map[tierCls];
  ['approve', 'escalate', 'reject'].forEach(action => {
    const btn = document.getElementById('btn' + action.charAt(0).toUpperCase() + action.slice(1));
    btn.classList.toggle('suggested', action === suggested);
  });
}

function recordDecision(decision) {
  const extraData = {};
  const name      = document.getElementById('cardName').textContent;
  const note      = document.getElementById('spocNotes').value.trim();
  const score     = +document.getElementById('compositeScore').textContent;
  const tierEl    = document.getElementById('tierBadge');
  const tierLabel = tierEl.textContent;
  const tierCls   = tierEl.className.replace('tier-badge', '').trim();

  const now     = new Date();
  const ts      = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
  const fullTs  = `${dateStr}, ${ts}`;

  const bannerText = `Decision recorded: ${decision} — Supplier ${name} — ${fullTs}${note ? ` — "${note}"` : ''}`;
  const banner = document.getElementById('decisionBanner');
  banner.textContent = bannerText;
  banner.className   = 'decision-banner banner-' + decision.toLowerCase();

  setDecisionButtonsDisabled(true);
  document.getElementById('btnReset').classList.remove('hidden');

  const currentTab = currentTabIdx >= 0 ? supplierTabs[currentTabIdx] : null;
  const addressedAtDecision = currentTab ? Object.values(currentTab.addressedConcerns || {}) : [];

  appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs,
    approvedBecause:    extraData.approvedBecause || null,
    approvalDocName:    extraData.approvalDocName || null,
    addressedConcerns:  addressedAtDecision,
    tabIdx:             currentTabIdx,
  });

  showToast(`${decision} recorded — ${fullTs}`, 'View record ↓', () => {
    const firstRow = document.getElementById('historyBody')?.firstElementChild;
    if (firstRow) {
      firstRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstRow.classList.add('h-row-highlight');
      setTimeout(() => firstRow.classList.remove('h-row-highlight'), 1600);
    }
  });

  const f = +document.getElementById('financial').value;
  const a = +document.getElementById('audit').value;
  const c = +document.getElementById('compliance').value;
  const g = +document.getElementById('geo').value;

  addOrUpdateTab({
    name:        name === '—' ? 'Unnamed' : name,
    score, tierCls, f, a, c, g,
    sourceDocs:  [...activeSourceDocs],
    evidence:    currentEvidence ? { ...currentEvidence } : null,
    decision, notes: note, bannerText, fullTs,
    approvedBecause: extraData.approvedBecause || null,
    approvalDocName: extraData.approvalDocName || null,
    subScores:   lastRenderData ? lastRenderData.subScores : null,
    explainText: document.getElementById('explainText').textContent,
  });

  // Record this decision as a score-history snapshot
  pushScoreSnapshot(currentTabIdx, {
    score,
    subScores: lastRenderData ? lastRenderData.subScores : null,
    explainText: document.getElementById('explainText').textContent,
    trigger: `Decision: ${decision}`,
  });
  renderScoreHistory(supplierTabs[currentTabIdx]);

  renderSupplierList();
}

function resetDecision() {
  const name = document.getElementById('cardName').textContent;
  confirmModal({
    title:        'Reset decision?',
    body:         `This will clear the recorded decision for "${name}" and re-open the approval options.`,
    confirmLabel: 'Reset',
    icon:         '↩',
    onConfirm() {
      const banner = document.getElementById('decisionBanner');
      banner.className   = 'decision-banner hidden';
      banner.textContent = '';
      document.getElementById('spocNotes').value = '';
      setDecisionButtonsDisabled(false);
      document.getElementById('btnReset').classList.add('hidden');
      updateCard();
    },
  });
}

// ── Per-concern addressed ─────────────────────────────────────────────────────

function concernKey(text) {
  return text.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 60);
}

// Recalculate dimension scores and composite after concerns are addressed.
// Returns { adjustedSubScores, newScore, oldScore, dimChanges } or null if no evidence.
function recalcScoreAfterAddressed(tab) {
  if (!tab || !tab.evidence) return null;

  const addressed  = tab.addressedConcerns || {};
  const baseScores = { financial: tab.f || 0, audit: tab.a || 0, compliance: tab.c || 0, geo: tab.g || 0 };
  const adjustedSubScores = {};
  const dimChanges = [];

  DIM_META.forEach(dim => {
    const concerns = (tab.evidence[dim.id + '_concerns'] || []).filter(t => t && t.trim());
    const base     = baseScores[dim.id];
    if (!concerns.length) {
      adjustedSubScores[dim.id] = base;
      return;
    }
    const addressedCount = concerns.filter(t => !!addressed[concernKey(t.trim())]).length;
    const ratio  = addressedCount / concerns.length;
    const boost  = Math.round(ratio * (100 - base) * 0.4);
    const adj    = Math.min(100, base + boost);
    adjustedSubScores[dim.id] = adj;
    if (boost > 0) dimChanges.push({ label: dim.label, base, adj, boost, addressedCount, total: concerns.length });
  });

  const oldScore = compositeRuleBased(tab.f || 0, tab.a || 0, tab.c || 0, tab.g || 0);
  const newScore = compositeRuleBased(
    adjustedSubScores.financial, adjustedSubScores.audit,
    adjustedSubScores.compliance, adjustedSubScores.geo,
  );

  return { adjustedSubScores, newScore, oldScore, dimChanges };
}

// Build a plain-text explanation summarising the score change due to addressed concerns.
function buildAddressedExplainText(tab, recalc, newlyAddressedTexts) {
  const { dimChanges, newScore, oldScore } = recalc;
  const totalAddressed = Object.keys(tab.addressedConcerns || {}).length;
  const parts = [];

  if (dimChanges.length) {
    const dimList = dimChanges.map(d => `${d.label} (${d.base}→${d.adj})`).join(', ');
    parts.push(
      `${totalAddressed} concern${totalAddressed !== 1 ? 's' : ''} addressed, ` +
      `improving ${dimList}.`
    );
  }
  if (newScore !== oldScore) {
    parts.push(`Composite score adjusted from ${oldScore} to ${newScore}.`);
  }
  if (newlyAddressedTexts && newlyAddressedTexts.length) {
    const snippet = parseConcernSnippet(newlyAddressedTexts[0]);
    parts.push(`Most recently addressed: "${snippet.length > 90 ? snippet.slice(0, 90) + '…' : snippet}".`);
  }

  return parts.length ? parts.join(' ') : (tab.explainText || '');
}


function refreshConcernsBadge() {
  const badge = document.getElementById('concernsAddressedBadge');
  if (!badge) return;
  const tab = currentTabIdx >= 0 ? supplierTabs[currentTabIdx] : null;
  const addrCount  = Object.keys((tab && tab.addressedConcerns) || {}).length;
  const totalRows  = document.querySelectorAll('.concern-row').length;
  if (addrCount > 0) {
    badge.textContent = `${addrCount} of ${totalRows} concern${totalRows !== 1 ? 's' : ''} marked as addressed`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function updateMarkSelectedBtn() {
  const btn     = document.getElementById('btnMarkSelected');
  const countEl = document.getElementById('markSelectedCount');
  const hintEl  = document.getElementById('markSelectedHint');
  if (!btn) return;
  const checked = document.querySelectorAll('.concern-check:checked').length;
  btn.disabled = checked === 0;
  countEl.textContent = checked > 0 ? `(${checked})` : '';
  if (hintEl) hintEl.style.display = checked > 0 ? '' : 'none';
}

function markSelectedConcernsAddressed() {
  if (currentTabIdx < 0) return;
  const checked = Array.from(document.querySelectorAll('.concern-check:checked'));
  if (!checked.length) return;

  // Gate behind the approval modal — reason + supporting document required
  showApprovalModal(({ approvedBecause, approvalDocName }) => {
    const now = new Date();
    const ts  = now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) +
                ', ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const tab     = supplierTabs[currentTabIdx];
    const updated = { ...(tab.addressedConcerns || {}) };
    const newlyAddressedTexts = [];

    checked.forEach(cb => {
      const key = cb.dataset.key;
      const row = cb.closest('.concern-row');
      if (!row || updated[key]) return;
      const text      = row.querySelector('.concern-text')?.textContent || '';
      const dimension = row.querySelector('.concern-dim')?.textContent  || '';
      const sev       = row.querySelector('.sev-badge')?.textContent    || 'LOW';
      updated[key]    = { ts, text, dimension, severity: sev, approvedBecause, approvalDocName };
      newlyAddressedTexts.push(text);
    });

    // Persist addressed map first so recalc can read it
    saveCurrentTab({ addressedConcerns: updated });

    // Recalculate score based on how many concerns are now addressed
    const updatedTab = supplierTabs[currentTabIdx];
    const recalc     = recalcScoreAfterAddressed(updatedTab);

    if (recalc) {
      const newExplain = buildAddressedExplainText(updatedTab, recalc, newlyAddressedTexts);
      saveCurrentTab({
        addressedScore:       recalc.newScore,
        addressedSubScores:   recalc.adjustedSubScores,
        addressedExplainText: newExplain,
      });

      // Snapshot: record what changed and why
      const triggerText = newlyAddressedTexts.length
        ? `Concern addressed: "${newlyAddressedTexts[0].length > 60 ? newlyAddressedTexts[0].slice(0, 60) + '…' : newlyAddressedTexts[0]}"`
        : 'Concern addressed';
      pushScoreSnapshot(currentTabIdx, { score: recalc.newScore, subScores: recalc.adjustedSubScores, explainText: newExplain, trigger: triggerText });

      // Update the card display without triggering a new AI call
      const finalTab = supplierTabs[currentTabIdx];
      renderCard({
        name:        document.getElementById('cardName').textContent,
        score:       recalc.newScore,
        subScores:   recalc.adjustedSubScores,
        explainText: newExplain,
        f: finalTab.f, a: finalTab.a, c: finalTab.c, g: finalTab.g,
      });
      renderScoreHistory(finalTab);
    }

    // Rebuild concerns list + evidence panel to reflect addressed state
    if (currentEvidence) {
      renderConcernsReport(buildConcernsReport(currentEvidence));
      renderEvidencePanel(currentEvidence, activeSourceDocs);
    }
    refreshConcernsBadge();
    renderSupplierList();
  });
}

// ── Score history ─────────────────────────────────────────────────────────────

function nowTs() {
  const now = new Date();
  return now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) +
         ', ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pushScoreSnapshot(idx, { score, subScores, explainText, trigger }) {
  if (idx < 0 || idx >= supplierTabs.length) return;
  const tab     = supplierTabs[idx];
  const history = Array.isArray(tab.scoreHistory) ? [...tab.scoreHistory] : [];
  // Skip only if score, explanation AND trigger are all identical to the last entry
  const last = history[history.length - 1];
  if (last && last.score === score && last.explainText === explainText && last.trigger === trigger) return;
  history.push({
    score,
    subScores: subScores || null,
    explainText: explainText || '—',
    ts:      nowTs(),
    trigger: trigger || 'Score updated',
  });
  supplierTabs[idx] = { ...supplierTabs[idx], scoreHistory: history };
  saveTabsToStorage();
}

function renderScoreHistory(tab) {
  const toggle  = document.getElementById('scoreHistoryToggle');
  const list    = document.getElementById('scoreHistoryList');
  const label   = document.getElementById('scoreHistoryLabel');
  if (!toggle || !list) return;

  const history = tab && Array.isArray(tab.scoreHistory) ? tab.scoreHistory : [];
  if (history.length < 1) {
    toggle.classList.add('hidden');
    list.classList.add('hidden');
    return;
  }

  label.textContent = `Score history (${history.length})`;
  toggle.classList.remove('hidden');

  // Render most-recent-first; mark the last entry as "current"
  const reversed = [...history].reverse();
  list.innerHTML = reversed.map((entry, i) => {
    const isCurrent = i === 0;
    const tierCls   = entry.score >= 70 ? '#16a34a' : entry.score >= 40 ? '#d97706' : '#dc2626';

    const dimRow = entry.subScores
      ? `<div class="sh-dim-row">` +
        DIM_META.map(d => {
          const v = entry.subScores[d.id] ?? '—';
          const c = typeof v === 'number' ? (v >= 70 ? '#16a34a' : v >= 40 ? '#d97706' : '#dc2626') : '#94a3b8';
          const wt = Math.round(d.weight * 100) + '%';
          return `<span class="sh-dim">` +
            `<span class="sh-dim-label">${d.label.split(' ')[0]} <span style="font-weight:400;opacity:.7">${wt}</span></span>` +
            `<span class="sh-dim-val" style="color:${c}">${v}</span>` +
            `</span>`;
        }).join('') +
        `</div>`
      : '';

    return `<div class="sh-entry${isCurrent ? ' sh-current' : ''}" role="listitem">` +
      `<div class="sh-entry-header">` +
      `<span class="sh-score-badge" style="color:${tierCls}">Score ${entry.score}</span>` +
      (isCurrent ? `<span class="sh-current-label">Current</span>` : '') +
      `<span class="sh-trigger">${escHtml(entry.trigger)}</span>` +
      `<span class="sh-ts">${escHtml(entry.ts)}</span>` +
      `</div>` +
      dimRow +
      `<p class="sh-explain">${escHtml(entry.explainText)}</p>` +
      `</div>`;
  }).join('');
}

// ── Decision history ──────────────────────────────────────────────────────────

function appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs, detail, approvedBecause, approvalDocName, addressedConcerns, tabIdx }) {
  document.getElementById('historyEmpty').classList.add('hidden');
  const table = document.getElementById('historyTable');
  table.classList.remove('hidden');

  const decisionCls = { Approve: 'dec-approve', Escalate: 'dec-escalate', Reject: 'dec-reject' }[decision] || '';
  const tbody = document.getElementById('historyBody');

  const hasDetail = detail || approvedBecause || approvalDocName || (addressedConcerns && addressedConcerns.length > 0);
  const tr = document.createElement('tr');
  if (hasDetail) tr.classList.add('h-expandable');
  tr.innerHTML =
    `<td class="h-name">${escHtml(name)}</td>` +
    `<td class="h-score">${score}</td>` +
    `<td><span class="tier-badge ${tierCls}">${escHtml(tierLabel)}</span></td>` +
    `<td><span class="history-decision ${decisionCls}">${escHtml(decision)}</span></td>` +
    `<td class="h-note">${note ? escHtml(note) : '<span class="h-empty">—</span>'}</td>` +
    `<td class="h-ts">${escHtml(fullTs)}${hasDetail ? ' <span class="h-expand-toggle" aria-hidden="true">▶</span>' : ''}</td>`;

  if (hasDetail) {
    const detailTr = document.createElement('tr');
    detailTr.className = 'h-detail-row hidden';

    let detailContent = '<div class="h-detail-content">';
    if (approvedBecause) {
      detailContent +=
        `<span class="h-detail-heading">Approved Because</span>` +
        `<p class="h-detail-text">${escHtml(approvedBecause)}</p>`;
    }
    if (approvalDocName) {
      detailContent +=
        `<span class="h-detail-heading" style="margin-top:8px">Supporting Document</span>` +
        `<p class="h-detail-text h-doc-ref">📎 ${escHtml(approvalDocName)}</p>`;
    }
    if (detail) {
      const sevCls = { HIGH: 'sev-high', MEDIUM: 'sev-medium', LOW: 'sev-low' }[detail.severity] || '';
      detailContent +=
        `<span class="h-detail-heading">Concerns Addressed</span>` +
        `<span class="concern-dim">${escHtml(detail.dimension)}</span>` +
        `<span class="sev-badge ${sevCls}">${escHtml(detail.severity)}</span>` +
        `<p class="h-detail-text">${escHtml(detail.text)}</p>`;
    }
    if (addressedConcerns && addressedConcerns.length > 0) {
      detailContent += `<div class="h-detail-concerns">` +
        `<span class="h-detail-heading">Concerns Addressed (${addressedConcerns.length})</span>`;
      addressedConcerns.forEach(c => {
        const sc = { HIGH: 'sev-high', MEDIUM: 'sev-medium', LOW: 'sev-low' }[c.severity] || '';
        detailContent +=
          `<div class="h-concern-item">` +
          `<span class="sev-badge ${sc}">${escHtml(c.severity || 'LOW')}</span>` +
          `<span class="concern-dim">${escHtml(c.dimension || '')}</span>` +
          `<button class="h-concern-link" type="button" data-concern="${escHtml(c.text)}" data-tabidx="${tabIdx ?? -1}">${escHtml(c.text)}</button>` +
          `</div>`;
      });
      detailContent += `</div>`;
    }
    detailContent += '</div>';
    detailTr.innerHTML = `<td colspan="6">${detailContent}</td>`;

    // Wire clickable concerns to document viewer
    detailTr.querySelectorAll('.h-concern-link').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const tidx = +btn.dataset.tabidx;
        openDocViewer(btn.dataset.concern, tidx >= 0 ? tidx : currentTabIdx);
      });
    });

    tr.addEventListener('click', () => {
      const isOpen = !detailTr.classList.contains('hidden');
      detailTr.classList.toggle('hidden');
      const arrow = tr.querySelector('.h-expand-toggle');
      if (arrow) arrow.textContent = isOpen ? '▶' : '▼';
    });

    tbody.insertBefore(detailTr, tbody.firstChild);
    tbody.insertBefore(tr, detailTr);
  } else {
    tbody.insertBefore(tr, tbody.firstChild);
  }
}

// ── Document viewer ───────────────────────────────────────────────────────────

function parseConcernFileName(concernText) {
  const m = concernText.match(/\(([^()]+\.(pdf|docx))\)\s*$/i);
  return m ? m[1] : null;
}

function parseConcernSnippet(concernText) {
  return concernText.replace(/\s*\([^()]+\.(pdf|docx)\)\s*$/i, '').trim();
}

function findSnippetIndex(snippet, rawText) {
  // Try matching the first 10 words with flexible whitespace
  const words = snippet.replace(/\s+/g, ' ').trim().split(/\s+/).slice(0, 10);
  if (!words.length) return -1;
  const pattern = words
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]{0,6}');
  try {
    const m = rawText.match(new RegExp(pattern, 'i'));
    return m ? m.index : -1;
  } catch { return -1; }
}

function openDocViewer(concernText, tabIdx) {
  const tidx = tabIdx ?? currentTabIdx;
  const tab  = tidx >= 0 && tidx < supplierTabs.length ? supplierTabs[tidx] : null;

  const fileName = parseConcernFileName(concernText);
  const snippet  = parseConcernSnippet(concernText);

  const rawDocs  = tab ? (tab.rawDocTexts || []) : [];
  const rawDoc   = fileName
    ? rawDocs.find(d => d.fileName === fileName) || rawDocs[0]
    : rawDocs[0];

  const modal    = document.getElementById('docViewerModal');
  const titleEl  = document.getElementById('docViewerTitle');
  const snippetEl = document.getElementById('docViewerSnippet');
  const bodyEl   = document.getElementById('docViewerBody');

  titleEl.textContent = fileName || (rawDoc ? rawDoc.fileName : 'Source Document');

  if (!rawDoc) {
    snippetEl.textContent = `"${snippet}"`;
    snippetEl.classList.remove('hidden');
    bodyEl.innerHTML =
      `<p style="color:#64748b;font-size:13px;">` +
      `Document text is not available for this supplier. ` +
      `Re-run the assessment to enable in-document viewing.` +
      `</p>`;
  } else {
    const rawText = rawDoc.text;
    const idx = findSnippetIndex(snippet, rawText);

    if (idx >= 0) {
      snippetEl.classList.add('hidden');
      // Find the actual match length using a smaller regex
      const firstWords = snippet.replace(/\s+/g, ' ').trim().split(/\s+/).slice(0, 6);
      const shortPat = firstWords
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]{0,6}');
      let matchLen = snippet.length;
      try {
        const m2 = rawText.slice(idx, idx + snippet.length + 80).match(new RegExp(shortPat, 'i'));
        if (m2) matchLen = m2[0].length;
      } catch { /* use default */ }

      const before  = escHtml(rawText.slice(0, idx));
      const matched = escHtml(rawText.slice(idx, idx + matchLen));
      const after   = escHtml(rawText.slice(idx + matchLen));
      bodyEl.innerHTML =
        `<pre class="doc-viewer-pre">${before}<mark class="doc-viewer-mark">${matched}</mark>${after}</pre>`;
      setTimeout(() => {
        const mark = bodyEl.querySelector('mark');
        if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 60);
    } else {
      snippetEl.textContent = `Cited passage: "${snippet}"`;
      snippetEl.classList.remove('hidden');
      bodyEl.innerHTML = `<pre class="doc-viewer-pre">${escHtml(rawText)}</pre>`;
    }
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDocViewer() {
  document.getElementById('docViewerModal').classList.add('hidden');
  document.body.style.overflow = '';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function initTooltips() {
  const tooltip = document.getElementById('tooltip');

  DIM_META.forEach((dim, i) => {
    const zone = document.getElementById(dim.barId).closest('.bar-hover-zone');
    if (!zone) return;

    zone.addEventListener('mouseenter', () => {
      const vals = {
        f: +document.getElementById('financial').value,
        a: +document.getElementById('audit').value,
        c: +document.getElementById('compliance').value,
        g: +document.getElementById('geo').value,
      };
      const dimVal   = [vals.f, vals.a, vals.c, vals.g][i];
      const contrib  = (dimVal * dim.weight).toFixed(1);
      const pctLabel = Math.round(dim.weight * 100) + '%';
      tooltip.textContent = `${dim.label}: ${dimVal} × ${pctLabel} = ${contrib} pts contributed to total score`;
      tooltip.classList.remove('hidden');
    });

    zone.addEventListener('mousemove', e => {
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY - 36) + 'px';
    });

    zone.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });
}

// ── Approval modal ────────────────────────────────────────────────────────────

let _approvalDocFile = null;

// onConfirm receives { approvedBecause, approvalDocName } when the reviewer confirms.
function showApprovalModal(onConfirm) {
  const modal    = document.getElementById('approvalModal');
  const titleEl  = document.getElementById('approvalModalTitle');
  const textarea = document.getElementById('approvedBecauseField');
  const docInput = document.getElementById('approvalDocInput');
  const docChip  = document.getElementById('approvalDocChip');
  const validMsg = document.getElementById('approvalValidationMsg');
  const backdrop = document.getElementById('approvalModalBackdrop');
  const cancelBtn  = document.getElementById('approvalModalCancel');
  const confirmBtn = document.getElementById('approvalModalConfirm');

  titleEl.textContent = 'Approve Concern(s)';

  // Reset state
  textarea.value = '';
  docInput.value = '';
  _approvalDocFile = null;
  docChip.classList.add('hidden');
  docChip.innerHTML = '';
  validMsg.classList.add('hidden');

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  textarea.focus();

  function close() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    _approvalDocFile = null;
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', close);
    backdrop.removeEventListener('click', close);
    document.removeEventListener('keydown', handleKey);
    docInput.removeEventListener('change', handleDocChange);
  }

  function handleDocChange() {
    const file = docInput.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'pdf' && ext !== 'docx') { docInput.value = ''; return; }
    _approvalDocFile = file;
    docChip.classList.remove('hidden');
    docChip.innerHTML =
      `<span>📎 ${escHtml(file.name)}</span>` +
      `<button class="approval-doc-chip-remove" type="button" aria-label="Remove">✕</button>`;
    docChip.querySelector('.approval-doc-chip-remove').addEventListener('click', () => {
      _approvalDocFile = null;
      docInput.value   = '';
      docChip.classList.add('hidden');
      docChip.innerHTML = '';
    });
  }

  function handleConfirm() {
    const reason  = textarea.value.trim();
    const docName = _approvalDocFile ? _approvalDocFile.name : null;
    if (!reason || !docName) { validMsg.classList.remove('hidden'); return; }
    validMsg.classList.add('hidden');
    close();
    onConfirm({ approvedBecause: reason, approvalDocName: docName });
  }

  function handleKey(e) { if (e.key === 'Escape') close(); }

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', handleKey);
  docInput.addEventListener('change', handleDocChange);
}

// ── Upload modal wiring ───────────────────────────────────────────────────────

function initUploadModal() {
  const input   = document.getElementById('modalDocUpload');
  const zone    = document.getElementById('modalDropZone');

  input.addEventListener('change', () => {
    Array.from(input.files).forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'pdf' || ext === 'docx') uploadedFiles.push(f);
    });
    input.value = '';
    updateModalChips();
  });

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'pdf' || ext === 'docx') uploadedFiles.push(f);
    });
    updateModalChips();
  });

  document.getElementById('modalBeginBtn').addEventListener('click', handleBeginAssessment);

  document.getElementById('uploadModalClose').addEventListener('click', hideUploadModal);
  document.getElementById('uploadModalBackdrop').addEventListener('click', hideUploadModal);

  document.getElementById('modalGoManual').addEventListener('click', () => {
    hideUploadModal();
    document.getElementById('listPage').style.display   = 'none';
    document.getElementById('mainScreen').style.display = 'flex';
    resetMainScreen();
    // Create a placeholder tab so manual edits are persisted
    supplierTabs.push({
      id: Date.now().toString(), name: 'New Supplier',
      score: 0, tierCls: '', f: 0, a: 0, c: 0, g: 0,
      sourceDocs: [], evidence: null, subScores: null, explainText: '',
      decision: null, notes: '', bannerText: '', fullTs: '',
      addressedConcerns: {}, dateAdded: Date.now(), concernsCount: 0,
    });
    currentTabIdx = supplierTabs.length - 1;
    saveTabsToStorage();
  });

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('uploadModal').classList.contains('hidden')) {
      hideUploadModal();
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Detail view: slider inputs
  ['supplierName', 'financial', 'audit', 'compliance', 'geo'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateCard);
  });

  // Detail view: decision buttons
  document.getElementById('btnApprove').addEventListener('click',  () => recordDecision('Approve'));
  document.getElementById('btnEscalate').addEventListener('click', () => recordDecision('Escalate'));
  document.getElementById('btnReject').addEventListener('click',   () => recordDecision('Reject'));
  document.getElementById('btnReset').addEventListener('click', resetDecision);
  document.getElementById('btnExport').addEventListener('click', () => window.print());

  // Score history toggle
  document.getElementById('scoreHistoryToggle').addEventListener('click', () => {
    const list   = document.getElementById('scoreHistoryList');
    const toggle = document.getElementById('scoreHistoryToggle');
    const arrow  = document.getElementById('scoreHistoryArrow');
    const open   = list.classList.toggle('hidden') === false;
    toggle.setAttribute('aria-expanded', String(open));
    arrow.style.transform = open ? 'rotate(90deg)' : '';
  });

  // Detail view: back to list
  document.getElementById('btnBackToList').addEventListener('click', () => {
    clearTimeout(debounceTimer);
    if (currentTabIdx >= 0) {
      saveCurrentTab({
        name: document.getElementById('supplierName').value.trim() || (supplierTabs[currentTabIdx] && supplierTabs[currentTabIdx].name),
        f: +document.getElementById('financial').value,
        a: +document.getElementById('audit').value,
        c: +document.getElementById('compliance').value,
        g: +document.getElementById('geo').value,
      });
    }
    goToList();
  });

  // List page: + New Supplier
  document.getElementById('btnNewSupplierGlobal').addEventListener('click', showUploadModal);

  // List page: live supplier search
  const listSearchEl = document.getElementById('listSearch');
  if (listSearchEl) {
    listSearchEl.addEventListener('input', () => {
      listSearchQuery = listSearchEl.value;
      renderSupplierList();
    });
    const listSearchClear = document.getElementById('listSearchClear');
    if (listSearchClear) {
      listSearchClear.addEventListener('click', () => {
        listSearchQuery = '';
        listSearchEl.value = '';
        listSearchEl.focus();
        renderSupplierList();
      });
    }
  }

  // List page: sort buttons
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortKey = key;
        sortDir = 'desc';
      }
      renderSupplierList();
    });
  });

  // Mark selected concerns as addressed
  document.getElementById('btnMarkSelected').addEventListener('click', markSelectedConcernsAddressed);

  // Export letter
  document.getElementById('btnExportLetter').addEventListener('click', () => {
    const name     = document.getElementById('cardName').textContent;
    const concerns = currentEvidence ? buildConcernsReport(currentEvidence) : [];
    if (!concerns.length) {
      alert('No concerns found to export. Upload supplier documents first.');
      return;
    }
    exportConcernsLetter(name === '—' ? 'Supplier' : name, concerns);
  });

  // Document viewer modal wiring
  document.getElementById('docViewerClose').addEventListener('click', closeDocViewer);
  document.getElementById('docViewerBackdrop').addEventListener('click', closeDocViewer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('docViewerModal').classList.contains('hidden')) {
      closeDocViewer();
    }
  });

  // App version label
  const verEl = document.getElementById('appVersion');
  if (verEl) verEl.textContent = APP_VERSION;

  initTooltips();
  initUploadModal();
  loadTabsFromStorage();

  if (window.location.protocol === 'https:') {
    const banner = document.createElement('div');
    banner.className = 'https-notice no-print';
    banner.innerHTML =
      '<strong>AI scoring unavailable</strong> — this app is served over HTTPS but Ollama runs on ' +
      '<code>http://localhost</code>, which browsers block as mixed content. ' +
      'To enable AI features, open <code>index.html</code> directly from your local file system or ' +
      'run a local HTTP server instead of using the GitHub Pages URL.';
    document.getElementById('mainScreen').insertBefore(
      banner,
      document.getElementById('mainScreen').firstElementChild,
    );
  }
});