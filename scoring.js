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

let currentAbortController = null;
let debounceTimer = null;

// App state
let uploadedFiles    = [];
let activeSourceDocs = [];
let supplierTabs     = [];
let currentTabIdx    = -1;
let lastRenderData   = null;
let currentEvidence  = null;  // evidence extracted from documents

// ── localStorage persistence ──────────────────────────────────────────────────

const LS_TABS   = 'srisk_tabs';
const LS_ACTIVE = 'srisk_activeTab';

function saveTabsToStorage() {
  try {
    localStorage.setItem(LS_TABS,   JSON.stringify(supplierTabs));
    localStorage.setItem(LS_ACTIVE, String(currentTabIdx));
  } catch {}
}

function loadTabsFromStorage() {
  try {
    const stored = localStorage.getItem(LS_TABS);
    if (!stored) return;
    const tabs = JSON.parse(stored);
    if (!Array.isArray(tabs) || !tabs.length) return;
    supplierTabs = tabs;
    const saved = parseInt(localStorage.getItem(LS_ACTIVE), 10);
    const idx   = Number.isFinite(saved) && saved >= 0 && saved < tabs.length ? saved : tabs.length - 1;
    // Show main screen directly — no fade needed on page load
    document.getElementById('landingPage').style.display = 'none';
    const main = document.getElementById('mainScreen');
    main.style.display = 'flex';
    main.style.opacity = '1';
    currentTabIdx = idx;
    renderTabs();
    loadTab(idx);
  } catch (e) {
    console.warn('[Storage] Failed to restore tabs:', e.message);
  }
}

function clearAllTabs() {
  if (!confirm('Clear all saved suppliers? This cannot be undone.')) return;
  supplierTabs  = [];
  currentTabIdx = -1;
  try { localStorage.removeItem(LS_TABS); localStorage.removeItem(LS_ACTIVE); } catch {}
  renderTabs();
  goToLanding();
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
  if (score >= 70) return { label: 'Approve',              cls: 'rec-approve'     };
  if (score >= 40) return { label: 'Conditional approval', cls: 'rec-conditional' };
  return               { label: 'Reject',               cls: 'rec-reject'      };
}

function confidence(f, a, c, g) {
  const vals = [f, a, c, g];
  const avg = vals.reduce((a, b) => a + b, 0) / 4;
  const variance = vals.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / 4;
  const stdDev = Math.sqrt(variance);
  if (stdDev < 10) return { label: 'High confidence',   cls: 'conf-high' };
  if (stdDev > 22) return { label: 'Low confidence',    cls: 'conf-low'  };
  return               { label: 'Medium confidence', cls: 'conf-mid'  };
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

  showLoader(`Building document chunks…`);
  const allChunks = [];
  for (const { text, fileName } of rawTexts) {
    const stripped = stripBoilerplate(text);
    allChunks.push(...chunkText(stripped, fileName));
  }
  console.log(`[RAG] total chunks: ${allChunks.length}`);

  showLoader(`Embedding ${allChunks.length} chunks…`);
  const t1 = performance.now();
  const index = await buildIndex(allChunks, signal);
  console.log(`[RAG] embedding done in ${((performance.now() - t1) / 1000).toFixed(1)}s`);

  showLoader('Extracting company name + all dimensions (parallel)…');
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
  noteEl.textContent = `Based on: ${fileNames.join(', ')}`;

  grid.innerHTML = DIM_META.map(dim => {
    const strengths = evidence[dim.id + '_strengths'] || [];
    const concerns  = evidence[dim.id + '_concerns']  || [];
    const score     = +document.getElementById(dim.id).value;
    const scoreColor = score >= 70 ? '#15803d' : score >= 40 ? '#b45309' : '#b91c1c';

    const listItems = (items, icon, cls) => {
      if (!items.length) {
        return `<li class="ev-empty">None found in documents</li>`;
      }
      return items.map(t => `<li class="${cls}">${icon} ${escHtml(t)}</li>`).join('');
    };

    return `
      <div class="ev-card" data-dim="${dim.id}">
        <div class="ev-card-header">
          <span class="ev-dim-label">${escHtml(dim.label)}</span>
          <span class="ev-score" style="color:${scoreColor}">${score}</span>
        </div>
        <div class="ev-section">
          <div class="ev-section-title ev-strengths-title">✓ Strengths found</div>
          <ul class="ev-list">${listItems(strengths, '', 'ev-strength')}</ul>
        </div>
        <div class="ev-section">
          <div class="ev-section-title ev-concerns-title">⚠ Concerns found</div>
          <ul class="ev-list">${listItems(concerns, '', 'ev-concern')}</ul>
        </div>
      </div>`;
  }).join('');
}

// ── Concerns report ───────────────────────────────────────────────────────────

function getSeverity(dimScore) {
  if (dimScore < 40) return 'HIGH';
  if (dimScore < 65) return 'MEDIUM';
  return 'LOW';
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
          severity: getSeverity(score),
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

    const badge = document.createElement('span');
    badge.className   = `sev-badge ${sm.cls}`;
    badge.textContent = sm.label;

    const body = document.createElement('div');
    body.className = 'concern-body';
    body.innerHTML =
      `<span class="concern-dim">${escHtml(c.dimension)}</span>` +
      `<span class="concern-text">${escHtml(c.text)}</span>` +
      (done ? `<span class="concern-addressed-ts">Addressed ${escHtml(addressed[key].ts)}</span>` : '');

    let action;
    if (done) {
      action = document.createElement('span');
      action.className   = 'concern-addressed-check';
      action.textContent = '✓';
    } else {
      action = document.createElement('button');
      action.className   = 'mark-one-btn';
      action.type        = 'button';
      action.textContent = 'Mark addressed';
      action.addEventListener('click', () => markConcernAddressed(c, key));
    }

    row.append(badge, body, action);
    list.appendChild(row);
  });

  refreshConcernsBadge();
}

// ── Concerns letter export (.docx) ────────────────────────────────────────────

async function exportConcernsLetter(supplierName, concerns) {
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

function goToMain() {
  const landing = document.getElementById('landingPage');
  const main    = document.getElementById('mainScreen');
  landing.style.opacity = '0';
  setTimeout(() => {
    landing.style.display = 'none';
    landing.style.opacity = '';
    main.style.display    = 'flex';
    main.style.opacity    = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      main.style.opacity = '1';
    }));
  }, 300);
}

function goToLanding() {
  const landing = document.getElementById('landingPage');
  const main    = document.getElementById('mainScreen');
  main.style.opacity = '0';
  setTimeout(() => {
    main.style.display    = 'none';
    main.style.opacity    = '';
    landing.style.display = '';
    landing.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      landing.style.opacity = '1';
    }));
  }, 300);
}

// ── Inline upload panel ───────────────────────────────────────────────────────

function showInlineUpload() {
  document.getElementById('inlineUploadPanel').classList.remove('hidden');
  document.getElementById('mainScreen').querySelector('.layout').style.display = 'none';
}

function hideInlineUpload() {
  uploadedFiles = [];
  updateInlineChips();
  document.getElementById('inlineUploadPanel').classList.add('hidden');
  document.getElementById('mainScreen').querySelector('.layout').style.display = '';
}

function updateInlineChips() {
  const list     = document.getElementById('inlineFileChipList');
  const beginBtn = document.getElementById('inlineBeginBtn');

  if (!uploadedFiles.length) {
    list.classList.add('hidden');
    list.innerHTML = '';
    beginBtn.disabled = true;
    return;
  }

  list.classList.remove('hidden');
  list.innerHTML = uploadedFiles.map((f, i) =>
    `<span class="file-chip">${escHtml(f.name)}` +
    `<button class="file-chip-remove" data-idx="${i}" type="button" aria-label="Remove">×</button>` +
    `</span>`
  ).join('');

  list.querySelectorAll('.file-chip-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      uploadedFiles.splice(+btn.dataset.idx, 1);
      updateInlineChips();
    });
  });

  beginBtn.disabled = false;
}

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
  const bar = document.getElementById('supplierTabsBar');
  if (!supplierTabs.length) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.innerHTML = supplierTabs.map((tab, i) => {
    const dotCls    = { 'tier-green': 'dot-green', 'tier-amber': 'dot-amber', 'tier-red': 'dot-red' }[tab.tierCls] || 'dot-grey';
    const active    = i === currentTabIdx ? ' active' : '';
    const addrCount = Object.keys(tab.addressedConcerns || {}).length;
    const addrBadge = addrCount > 0
      ? `<span class="tab-addressed-badge" title="${addrCount} concern${addrCount > 1 ? 's' : ''} addressed">${addrCount}</span>` : '';
    return `<button class="sup-tab${active}" data-idx="${i}">` +
      `<span class="sup-tab-dot ${dotCls}"></span>${escHtml(tab.name)}${addrBadge}</button>`;
  }).join('') +
  `<button class="clear-tabs-btn no-print" id="btnClearAllTabs" type="button">Clear all</button>`;
  bar.querySelectorAll('.sup-tab').forEach(btn => {
    btn.addEventListener('click', () => loadTab(+btn.dataset.idx));
  });
  document.getElementById('btnClearAllTabs').addEventListener('click', clearAllTabs);
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

  renderCard({ name: tab.name, score: tab.score, subScores: tab.subScores, explainText: tab.explainText, f: tab.f, a: tab.a, c: tab.c, g: tab.g });

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

  renderTabs();
}

function addOrUpdateTab(tabData) {
  if (currentTabIdx === -1) {
    if (!tabData.id) tabData.id = Date.now().toString();
    supplierTabs.push(tabData);
    currentTabIdx = supplierTabs.length - 1;
  } else {
    // Merge so fields not in tabData (e.g. concernsAddressed) are preserved
    supplierTabs[currentTabIdx] = { ...supplierTabs[currentTabIdx], ...tabData };
  }
  saveTabsToStorage();
  renderTabs();
}

function saveCurrentTab(data) {
  if (currentTabIdx < 0 || currentTabIdx >= supplierTabs.length) return;
  supplierTabs[currentTabIdx] = { ...supplierTabs[currentTabIdx], ...data };
  saveTabsToStorage();
  renderTabs();
}

function saveTabAt(idx, data) {
  if (idx < 0 || idx >= supplierTabs.length) return;
  supplierTabs[idx] = { ...supplierTabs[idx], ...data };
  saveTabsToStorage();
  renderTabs();
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
  setAiNotice(false);
  hideLoader();
  document.getElementById('evidenceSection').classList.add('hidden');
  document.getElementById('concernsSection').classList.add('hidden');
  lastRenderData = null;
}

// ── Landing page file chips ───────────────────────────────────────────────────

function updateLandingChips() {
  const list     = document.getElementById('fileChipList');
  const beginBtn = document.getElementById('beginBtn');

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
      updateLandingChips();
    });
  });

  beginBtn.disabled = false;
}

// ── Begin assessment (multi-doc) ──────────────────────────────────────────────

async function handleBeginAssessment() {
  const beginBtn       = document.getElementById('beginBtn');
  const inlineBeginBtn = document.getElementById('inlineBeginBtn');
  const fromInline     = !document.getElementById('inlineUploadPanel').classList.contains('hidden');

  const fileNames   = uploadedFiles.map(f => f.name);
  const filesForExt = [...uploadedFiles];  // snapshot before clearing
  uploadedFiles = [];  // clear global list immediately so chips reset

  [beginBtn, inlineBeginBtn].forEach(b => { b.disabled = true; b.textContent = 'Extracting…'; });

  // Transition screens before any async work
  if (fromInline) {
    document.getElementById('inlineUploadPanel').classList.add('hidden');
    document.getElementById('mainScreen').querySelector('.layout').style.display = '';
  } else {
    goToMain();
  }
  resetMainScreen();  // sets currentTabIdx = -1
  renderSourceDocs(fileNames);

  // Create the placeholder tab NOW — synchronously before any await — so that
  // supplierTabs.length increments immediately. This ensures "+ New supplier"
  // always shows the inline panel (not the landing page) from this point forward,
  // even if AI extraction later fails.
  const placeholderName = fileNames.length > 0
    ? fileNames[0].replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'New Supplier'
    : 'New Supplier';
  // Always push a brand-new tab entry — never merge into an existing one.
  // We bypass addOrUpdateTab's currentTabIdx conditional entirely so that even
  // if global state is stale, a new tab is guaranteed.
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
  });
  currentTabIdx = supplierTabs.length - 1;
  saveTabsToStorage();
  renderTabs();
  const myTabIdx = currentTabIdx;  // lock in: all saves for this assessment go here

  const statusEl = document.getElementById('uploadStatus');
  [beginBtn, inlineBeginBtn].forEach(b => { b.disabled = false; b.textContent = 'Begin Assessment →'; });

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

  // Update the placeholder tab with real extracted data.
  // Use saveTabAt(myTabIdx) instead of addOrUpdateTab so we always write to the
  // correct tab regardless of what currentTabIdx is now (user may have clicked
  // another tab during the long AI extraction).
  const initialScore = compositeRuleBased(f, a, c, g);
  saveTabAt(myTabIdx, {
    name:        extractedName,
    score:       initialScore,
    tierCls:     tier(initialScore).cls,
    f, a, c, g,
    sourceDocs:  [...fileNames],
    evidence:    currentEvidence ? { ...currentEvidence } : null,
  });

  // Ensure the newly assessed tab is the active one so updateCard saves correctly
  currentTabIdx = myTabIdx;
  renderTabs();

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

  appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs });

  const f = +document.getElementById('financial').value;
  const a = +document.getElementById('audit').value;
  const c = +document.getElementById('compliance').value;
  const g = +document.getElementById('geo').value;

  // Use addOrUpdateTab so the merge in that function preserves concernsAddressed etc.
  addOrUpdateTab({
    name:        name === '—' ? 'Unnamed' : name,
    score, tierCls, f, a, c, g,
    sourceDocs:  [...activeSourceDocs],
    evidence:    currentEvidence ? { ...currentEvidence } : null,
    decision, notes: note, bannerText, fullTs,
    subScores:   lastRenderData ? lastRenderData.subScores : null,
    explainText: document.getElementById('explainText').textContent,
  });
}

function resetDecision() {
  const banner = document.getElementById('decisionBanner');
  banner.className   = 'decision-banner hidden';
  banner.textContent = '';
  document.getElementById('spocNotes').value = '';
  setDecisionButtonsDisabled(false);
  document.getElementById('btnReset').classList.add('hidden');
  updateCard();
}

// ── Per-concern addressed ─────────────────────────────────────────────────────

function concernKey(text) {
  return text.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 60);
}

function markConcernAddressed(concern, key) {
  if (currentTabIdx < 0) return;
  const now = new Date();
  const ts  = now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) +
              ', ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const tab = supplierTabs[currentTabIdx];
  const updated = {
    ...(tab.addressedConcerns || {}),
    [key]: { ts, text: concern.text, dimension: concern.dimension, severity: concern.severity },
  };
  saveCurrentTab({ addressedConcerns: updated });

  // Update this concern's row in-place
  const row = document.querySelector(`.concern-row[data-key="${CSS.escape(key)}"]`);
  if (row) {
    row.classList.add('addressed');
    const btn = row.querySelector('.mark-one-btn');
    if (btn) {
      const check = document.createElement('span');
      check.className = 'concern-addressed-check';
      check.textContent = '✓';
      btn.replaceWith(check);
    }
    const body = row.querySelector('.concern-body');
    if (body && !body.querySelector('.concern-addressed-ts')) {
      const tsEl = document.createElement('span');
      tsEl.className   = 'concern-addressed-ts';
      tsEl.textContent = `Addressed ${ts}`;
      body.appendChild(tsEl);
    }
  }

  // Refresh summary badge
  refreshConcernsBadge();

  // Individual audit-trail entry with expandable detail
  appendHistory({
    name:      tab.name || '—',
    score:     tab.score || 0,
    tierLabel: document.getElementById('tierBadge').textContent,
    tierCls:   tab.tierCls || '',
    decision:  'Concern addressed',
    note:      concern.text,
    fullTs:    ts,
    detail:    { dimension: concern.dimension, severity: concern.severity, text: concern.text },
  });

  renderTabs(); // refresh addressed-count badge on the tab
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

// ── Decision history ──────────────────────────────────────────────────────────

function appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs, detail }) {
  document.getElementById('historyEmpty').classList.add('hidden');
  const table = document.getElementById('historyTable');
  table.classList.remove('hidden');

  const decisionCls = { Approve: 'dec-approve', Escalate: 'dec-escalate', Reject: 'dec-reject' }[decision] || '';
  const tbody = document.getElementById('historyBody');

  const tr = document.createElement('tr');
  if (detail) tr.classList.add('h-expandable');
  tr.innerHTML =
    `<td class="h-name">${escHtml(name)}</td>` +
    `<td class="h-score">${score}</td>` +
    `<td><span class="tier-badge ${tierCls}">${escHtml(tierLabel)}</span></td>` +
    `<td><span class="history-decision ${decisionCls}">${escHtml(decision)}</span></td>` +
    `<td class="h-note">${note ? escHtml(note) : '<span class="h-empty">—</span>'}</td>` +
    `<td class="h-ts">${escHtml(fullTs)}${detail ? ' <span class="h-expand-toggle" aria-hidden="true">▶</span>' : ''}</td>`;

  if (detail) {
    const sevCls = { HIGH: 'sev-high', MEDIUM: 'sev-medium', LOW: 'sev-low' }[detail.severity] || '';
    const detailTr = document.createElement('tr');
    detailTr.className = 'h-detail-row hidden';
    detailTr.innerHTML =
      `<td colspan="6"><div class="h-detail-content">` +
      `<span class="h-detail-heading">Concerns Addressed</span>` +
      `<span class="concern-dim">${escHtml(detail.dimension)}</span>` +
      `<span class="sev-badge ${sevCls}">${escHtml(detail.severity)}</span>` +
      `<p class="h-detail-text">${escHtml(detail.text)}</p>` +
      `</div></td>`;

    tr.addEventListener('click', () => {
      const isOpen = !detailTr.classList.contains('hidden');
      detailTr.classList.toggle('hidden');
      const arrow = tr.querySelector('.h-expand-toggle');
      if (arrow) arrow.textContent = isOpen ? '▶' : '▼';
    });

    // Insert main row first, detail row immediately after
    tbody.insertBefore(detailTr, tbody.firstChild);
    tbody.insertBefore(tr, detailTr);
  } else {
    tbody.insertBefore(tr, tbody.firstChild);
  }
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

// ── Upload (landing page) ─────────────────────────────────────────────────────

function initUpload() {
  const input    = document.getElementById('docUpload');
  const zone     = document.getElementById('landingDropZone');
  const beginBtn = document.getElementById('beginBtn');

  input.addEventListener('change', () => {
    Array.from(input.files).forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'pdf' || ext === 'docx') uploadedFiles.push(f);
    });
    input.value = '';
    updateLandingChips();
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
    updateLandingChips();
  });

  beginBtn.addEventListener('click', handleBeginAssessment);

  document.getElementById('goManual').addEventListener('click', () => {
    uploadedFiles = [];
    updateLandingChips();
    goToMain();
    resetMainScreen();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  ['supplierName', 'financial', 'audit', 'compliance', 'geo'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateCard);
  });

  document.getElementById('btnApprove').addEventListener('click',  () => recordDecision('Approve'));
  document.getElementById('btnEscalate').addEventListener('click', () => recordDecision('Escalate'));
  document.getElementById('btnReject').addEventListener('click',   () => recordDecision('Reject'));
  document.getElementById('btnReset').addEventListener('click', resetDecision);
  document.getElementById('btnExport').addEventListener('click', () => window.print());

  // + New supplier button
  document.getElementById('btnNewSupplier').addEventListener('click', () => {
    uploadedFiles = [];
    updateLandingChips();
    if (supplierTabs.length > 0) {
      showInlineUpload();
    } else {
      goToLanding();
    }
  });

  // Inline upload panel wiring
  const inlineInput  = document.getElementById('inlineDocUpload');
  const inlineZone   = document.getElementById('inlineDropZone');

  inlineInput.addEventListener('change', () => {
    Array.from(inlineInput.files).forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'pdf' || ext === 'docx') uploadedFiles.push(f);
    });
    inlineInput.value = '';
    updateInlineChips();
  });

  inlineZone.addEventListener('dragover',  e => { e.preventDefault(); inlineZone.classList.add('drag-over'); });
  inlineZone.addEventListener('dragleave', () => inlineZone.classList.remove('drag-over'));
  inlineZone.addEventListener('drop', e => {
    e.preventDefault();
    inlineZone.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'pdf' || ext === 'docx') uploadedFiles.push(f);
    });
    updateInlineChips();
  });

  document.getElementById('inlineBeginBtn').addEventListener('click', handleBeginAssessment);

  document.getElementById('inlineCancelBtn').addEventListener('click', hideInlineUpload);

  document.getElementById('inlineGoManual').addEventListener('click', () => {
    hideInlineUpload();
    resetMainScreen();
  });

  document.getElementById('btnExportLetter').addEventListener('click', () => {
    const name     = document.getElementById('cardName').textContent;
    const concerns = currentEvidence ? buildConcernsReport(currentEvidence) : [];
    if (!concerns.length) {
      alert('No concerns found to export. Upload supplier documents first.');
      return;
    }
    exportConcernsLetter(name === '—' ? 'Supplier' : name, concerns);
  });

  initTooltips();
  initUpload();
  loadTabsFromStorage();

  // Warn when served over HTTPS (e.g. GitHub Pages) — Ollama on http://localhost
  // is blocked as mixed content, so all AI calls will fall back to rule-based.
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