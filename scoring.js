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
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
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

// ── Combined extraction (scores + evidence) ───────────────────────────────────

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

  const sevMeta = {
    HIGH:   { cls: 'sev-high',   label: 'HIGH'   },
    MEDIUM: { cls: 'sev-medium', label: 'MEDIUM' },
    LOW:    { cls: 'sev-low',    label: 'LOW'    },
  };

  list.innerHTML = concerns.map(c => {
    const sm = sevMeta[c.severity];
    return `
      <div class="concern-row">
        <span class="sev-badge ${sm.cls}">${sm.label}</span>
        <div class="concern-body">
          <span class="concern-dim">${escHtml(c.dimension)}</span>
          <span class="concern-text">${escHtml(c.text)}</span>
        </div>
      </div>`;
  }).join('');
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
    const dotCls = { 'tier-green': 'dot-green', 'tier-amber': 'dot-amber', 'tier-red': 'dot-red' }[tab.tierCls] || 'dot-grey';
    const active = i === currentTabIdx ? ' active' : '';
    return `<button class="sup-tab${active}" data-idx="${i}">` +
      `<span class="sup-tab-dot ${dotCls}"></span>${escHtml(tab.name)}</button>`;
  }).join('');
  bar.querySelectorAll('.sup-tab').forEach(btn => {
    btn.addEventListener('click', () => loadTab(+btn.dataset.idx));
  });
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
  banner.textContent = tab.bannerText;
  banner.className   = 'decision-banner banner-' + tab.decision.toLowerCase();

  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => { document.getElementById(id).disabled = true; });
  document.getElementById('btnReset').classList.remove('hidden');
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
    supplierTabs.push(tabData);
    currentTabIdx = supplierTabs.length - 1;
  } else {
    supplierTabs[currentTabIdx] = tabData;
  }
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
  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => { document.getElementById(id).disabled = false; });
  document.getElementById('btnReset').classList.add('hidden');
  document.getElementById('uploadStatus').textContent = '';

  renderSourceDocs([]);
  setAiNotice(false);
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
  const beginBtn  = document.getElementById('beginBtn');
  const fileNames = uploadedFiles.map(f => f.name);
  beginBtn.disabled    = true;
  beginBtn.textContent = 'Extracting…';

  const parts = [];
  for (let i = 0; i < uploadedFiles.length; i++) {
    const file = uploadedFiles[i];
    const ext  = file.name.split('.').pop().toLowerCase();
    let text   = '';
    try {
      if (ext === 'pdf')       text = await extractTextFromPdf(file);
      else if (ext === 'docx') text = await extractTextFromDocx(file);
    } catch { /* skip unreadable */ }

    if (text.trim()) {
      const trimmed = text.trim();
      const chunk   = trimmed.length > 4000
        ? trimmed.slice(0, 2000) + '\n\n[... middle section omitted ...]\n\n' + trimmed.slice(-2000)
        : trimmed;
      parts.push(`=== DOCUMENT ${i + 1}: ${file.name} ===\n${chunk}`);
    }
  }

  goToMain();
  resetMainScreen();
  renderSourceDocs(fileNames);

  const statusEl = document.getElementById('uploadStatus');
  statusEl.textContent = `Reading ${fileNames.length} document${fileNames.length > 1 ? 's' : ''}…`;

  beginBtn.disabled    = false;
  beginBtn.textContent = 'Begin Assessment →';

  if (!parts.length) {
    statusEl.textContent = 'Could not read any documents — enter scores manually.';
    return;
  }

  statusEl.textContent = 'Extracting scores and evidence with AI…';
  const combinedText = parts.join('\n\n');

  let parsed;
  try {
    parsed = await extractScoresAndEvidence(combinedText);
  } catch (err) {
    console.warn('[Evidence extraction failed, falling back to scores-only]', err.message);
    // Fall back to scores-only extraction
    try {
      parsed = await extractScoresOnly(combinedText);
    } catch {
      statusEl.textContent = 'AI unavailable — enter scores manually.';
      return;
    }
  }

  const clamp = v => Math.min(100, Math.max(0, Math.round(Number(v))));
  const f = Number.isFinite(+parsed.financial)  ? clamp(parsed.financial)  : 50;
  const a = Number.isFinite(+parsed.audit)       ? clamp(parsed.audit)      : 50;
  const c = Number.isFinite(+parsed.compliance)  ? clamp(parsed.compliance) : 50;
  const g = Number.isFinite(+parsed.geo)         ? clamp(parsed.geo)        : 50;

  if (parsed.name && typeof parsed.name === 'string') {
    document.getElementById('supplierName').value = parsed.name.trim();
  }
  document.getElementById('financial').value  = f;
  document.getElementById('audit').value      = a;
  document.getElementById('compliance').value = c;
  document.getElementById('geo').value        = g;
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

  uploadedFiles = [];
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
  const signal = currentAbortController.signal;

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

  try {
    const scoreData = await fetchAiScore(f, a, c, g, signal);
    if (signal.aborted) return;

    const t = tier(scoreData.score);
    const explainText = await fetchAiExplain(f, a, c, g, scoreData.score, t.label, signal);
    if (signal.aborted) return;

    setAiNotice(false);
    renderCard({ name, score: scoreData.score, subScores: scoreData, explainText: explainText.trim(), f, a, c, g });

  } catch (err) {
    if (signal.aborted) return;
    console.warn('[AI] Falling back to rule-based:', err.message);
    const score       = compositeRuleBased(f, a, c, g);
    const explainText = explainRuleBased(score, f, a, c, g);
    setAiNotice(true);
    renderCard({ name, score, subScores: null, explainText, f, a, c, g });
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

  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => { document.getElementById(id).disabled = true; });
  document.getElementById('btnReset').classList.remove('hidden');

  appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs });

  const f = +document.getElementById('financial').value;
  const a = +document.getElementById('audit').value;
  const c = +document.getElementById('compliance').value;
  const g = +document.getElementById('geo').value;

  addOrUpdateTab({
    name:       name === '—' ? 'Unnamed' : name,
    score, tierCls, f, a, c, g,
    sourceDocs: [...activeSourceDocs],
    evidence:   currentEvidence ? { ...currentEvidence } : null,
    decision, notes: note, bannerText, fullTs,
    subScores:  lastRenderData ? lastRenderData.subScores : null,
    explainText: document.getElementById('explainText').textContent,
  });
}

function resetDecision() {
  const banner = document.getElementById('decisionBanner');
  banner.className   = 'decision-banner hidden';
  banner.textContent = '';
  document.getElementById('spocNotes').value = '';
  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => { document.getElementById(id).disabled = false; });
  document.getElementById('btnReset').classList.add('hidden');
  updateCard();
}

// ── Decision history ──────────────────────────────────────────────────────────

function appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs }) {
  document.getElementById('historyEmpty').classList.add('hidden');
  const table = document.getElementById('historyTable');
  table.classList.remove('hidden');

  const decisionCls = { Approve: 'dec-approve', Escalate: 'dec-escalate', Reject: 'dec-reject' }[decision] || '';
  const tbody = document.getElementById('historyBody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="h-name">${escHtml(name)}</td>
    <td class="h-score">${score}</td>
    <td><span class="tier-badge ${tierCls}">${escHtml(tierLabel)}</span></td>
    <td><span class="history-decision ${decisionCls}">${escHtml(decision)}</span></td>
    <td class="h-note">${note ? escHtml(note) : '<span class="h-empty">—</span>'}</td>
    <td class="h-ts">${escHtml(fullTs)}</td>`;
  tbody.insertBefore(tr, tbody.firstChild);
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

  document.getElementById('btnNewSupplier').addEventListener('click', () => {
    uploadedFiles = [];
    updateLandingChips();
    goToLanding();
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
