#!/usr/bin/env node
/**
 * WebAssign JSON Automation CLI
 * Supports both regular Google Chrome (AppleScript JS) and CDP Chrome (port 9222).
 *
 * Commands:
 *   node webassign-cli.mjs dump [--out schema.json] [--template answers.template.json] [--channel applescript|cdp]
 *   node webassign-cli.mjs fill <answers.json> [--dry-run] [--save] [--submit-question <N>] [--submit-all] [--channel applescript|cdp]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const URL_MATCH = 'webassign.net/web/Student/Assignment-Responses';

// ---------------------------------------------------------------------------
// 1. Browser Execution Transport (AppleScript for regular Chrome, or CDP 9222)
// ---------------------------------------------------------------------------

function execAppleScriptJs(jsCode) {
  const tmpJs = path.join(os.tmpdir(), `wa_inject_${process.pid}_${Date.now()}.js`);
  fs.writeFileSync(tmpJs, jsCode, 'utf8');
  try {
    const osa = `
set jsFile to POSIX file ${JSON.stringify(tmpJs)}
set jsCode to read jsFile as «class utf8»
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t) contains "${URL_MATCH}" then
        return execute t javascript jsCode
      end if
    end repeat
  end repeat
  error "No open WebAssign Assignment-Responses tab found in Google Chrome."
end tell
`;
    return execFileSync('osascript', ['-e', osa], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
  } finally {
    try { fs.unlinkSync(tmpJs); } catch {}
  }
}

async function execCdpJs(jsCode, port = Number(process.env.CDP_PORT || 9222)) {
  const res = await fetch(`http://localhost:${port}/json`);
  if (!res.ok) throw new Error(`CDP port ${port} unavailable (HTTP ${res.status})`);
  const tabs = await res.json();
  const tab = tabs.find(t => t.type === 'page' && t.url.includes(URL_MATCH));
  if (!tab) throw new Error(`No WebAssign tab found on CDP port ${port}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP Runtime.evaluate timeout')); }, 30000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: jsCode, returnByValue: true, awaitPromise: true }
      }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.text || JSON.stringify(msg.result.exceptionDetails)));
      } else {
        resolve(msg.result?.result?.value);
      }
    });
    ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Runs an async IIFE inside the page's MAIN world (so it can access window.WA,
 * window.MathJax, window.mathTypeEditor, window.mathTypeOverlay, etc.).
 * Works identically under AppleScript (isolated world -> <script> bridge) and CDP.
 */
async function runInMainWorld(channel, asyncBodyCode, payloadObj = null) {
  const jobId = `waJob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payloadJson = JSON.stringify(payloadObj);

  const launcher = `(() => {
    const jobId = ${JSON.stringify(jobId)};
    delete document.documentElement.dataset[jobId + '_done'];
    delete document.documentElement.dataset[jobId + '_out'];
    const s = document.createElement('script');
    s.textContent = '(async (PAYLOAD) => {\\n' +
      '  let __res;\\n' +
      '  try {\\n' +
      '    __res = { ok: true, data: await (async (PAYLOAD) => {\\n' +
             ${JSON.stringify(asyncBodyCode)} +
      '\\n    })(PAYLOAD) };\\n' +
      '  } catch (e) {\\n' +
      '    __res = { ok: false, error: String(e && e.stack || e) };\\n' +
      '  }\\n' +
      '  document.documentElement.dataset[' + JSON.stringify(jobId + '_out') + '] = JSON.stringify(__res);\\n' +
      '  document.documentElement.dataset[' + JSON.stringify(jobId + '_done') + '] = "1";\\n' +
      '})(' + ${JSON.stringify(payloadJson)} + ');';
    document.documentElement.appendChild(s);
    s.remove();
    return jobId;
  })()`;

  if (channel === 'cdp') {
    await execCdpJs(launcher);
  } else {
    execAppleScriptJs(launcher);
  }

  const pollJs = `(() => {
    const done = document.documentElement.dataset[${JSON.stringify(jobId + '_done')}];
    if (done !== '1') return '';
    const out = document.documentElement.dataset[${JSON.stringify(jobId + '_out')}] || '';
    delete document.documentElement.dataset[${JSON.stringify(jobId + '_done')}];
    delete document.documentElement.dataset[${JSON.stringify(jobId + '_out')}];
    return out;
  })()`;

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const raw = channel === 'cdp' ? await execCdpJs(pollJs) : execAppleScriptJs(pollJs);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.data;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('Timed out waiting for WebAssign page script execution.');
}

// ---------------------------------------------------------------------------
// 2. In-Page Logic: Dump Schema
// ---------------------------------------------------------------------------

const DUMP_PAGE_SCRIPT = `
  const depEl = document.getElementById('deployment');
  const dep = depEl ? depEl.value : null;
  const assignment = dep && window.WA && WA.Assignment ? WA.Assignment.retrieve(dep) : null;
  if (!assignment) throw new Error('WA.Assignment instance not found on page');

  const questions = assignment.questions.map((q) => {
    if (q.requireCompleteInit) q.requireCompleteInit();
    const scoreEl = q.element.querySelector('.qScore, .points, [class*="score"]');
    const textSnippet = (q.element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 320);

    const boxes = (q.boxes || []).filter(Boolean).map((b) => {
      const entry = {
        boxNum: Number(b.boxNum),
        id: b.id,
        boxType: b.boxType,
        kind:
          b.boxType === 'A' && b.boxSettings && b.boxSettings.mathtype ? 'mathtype' :
          b.boxType === 'C' && b.boxSettings && b.boxSettings.pulldown ? 'pulldown' :
          b.boxType === 'C' ? 'radio' :
          b.boxType === 'S' ? 'checkbox' :
          b.boxType === 'N' ? 'numeric' :
          b.boxType === 'E' ? 'essay' : 'other',
        settings: b.boxSettings || {},
        currentValue: b._getBoxValue ? String(b._getBoxValue()) : '',
      };
      if (entry.kind === 'pulldown') {
        const sel = document.getElementById(b.id);
        entry.options = sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.text })) : [];
      } else if (entry.kind === 'radio' || entry.kind === 'checkbox') {
        const inputs = Array.from(q.element.querySelectorAll('input[name="' + b.id + '"]')).filter(el => el.type !== 'hidden');
        entry.choices = inputs.map((inp) => {
          const lbl = inp.id ? q.element.querySelector('label[for="' + inp.id + '"]') : null;
          return {
            value: inp.value,
            checked: inp.checked,
            label: lbl ? lbl.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140) : ''
          };
        });
      }
      return entry;
    });

    return {
      questionNumber: Number(q.viewPosition),
      position: Number(q.position),
      questionId: String(q.id),
      domId: q.element.id,
      scoreText: scoreEl ? scoreEl.innerText.replace(/\\s+/g, ' ').trim() : '',
      promptSnippet: textSnippet,
      boxes,
    };
  });

  return {
    title: document.title,
    url: location.href,
    deployment: dep,
    questionCount: questions.length,
    totalBoxes: questions.reduce((n, q) => n + q.boxes.length, 0),
    questions,
  };
`;

// ---------------------------------------------------------------------------
// 3. In-Page Logic: Fill Answers (JSON -> MathType / Numeric / Radio / Select)
// ---------------------------------------------------------------------------

const FILL_PAGE_SCRIPT = `
  const { answers, dryRun, save, submitQuestion, submitAll } = PAYLOAD;
  const depEl = document.getElementById('deployment');
  const dep = depEl ? depEl.value : null;
  const assignment = dep && window.WA && WA.Assignment ? WA.Assignment.retrieve(dep) : null;
  if (!assignment) throw new Error('WA.Assignment instance not found on page');

  // Ensure all questions and boxes are initialized (even off-screen ones)
  const questionByNum = new Map();
  const boxById = new Map();
  for (const q of assignment.questions) {
    if (q.requireCompleteInit) q.requireCompleteInit();
    questionByNum.set(Number(q.viewPosition), q);
    for (const b of (q.boxes || [])) {
      if (b) boxById.set(b.id, { q, box: b });
    }
  }

  // ---- Helper: upgrade bare (...) before ^ or _ into \\left(...\\right) ----
  // Prevents MathJax from turning (1+x)^6 into <mo>(</mo>1+x<msup><mo>)</mo><mn>6</mn></msup>
  function autoGroupExponentParens(tex) {
    let out = '';
    const stack = [];
    for (let i = 0; i < tex.length; i++) {
      const ch = tex[i];
      if (ch === '(' && !tex.slice(Math.max(0, i - 5), i).endsWith('\\\\left')) {
        stack.push(out.length);
        out += '(';
      } else if (ch === ')' && stack.length > 0 && !tex.slice(Math.max(0, i - 6), i).endsWith('\\\\right')) {
        const openIdx = stack.pop();
        // Check if followed by ^ or _ (with optional spaces)
        let j = i + 1;
        while (j < tex.length && tex[j] === ' ') j++;
        if (tex[j] === '^' || tex[j] === '_') {
          out = out.slice(0, openIdx) + '\\\\left(' + out.slice(openIdx + 1) + '\\\\right)';
        } else {
          out += ')';
        }
      } else {
        out += ch;
      }
    }
    return out;
  }

  // ---- Helper: MathJax 2.7.9 TeX -> sanitized WebAssign MathML ----
  function texToMathMLAsync(rawTex) {
    const tex = autoGroupExponentParens(String(rawTex).trim());
    return new Promise((resolve, reject) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
      host.className = 'wa-math';
      host.textContent = '\\\\(' + tex + '\\\\)';
      document.body.appendChild(host);
      MathJax.Hub.Queue(['Typeset', MathJax.Hub, host], () => {
        try {
          const jax = MathJax.Hub.getAllJax(host)[0];
          if (!jax || !jax.root) throw new Error('MathJax failed to parse TeX: ' + tex);
          const mml = jax.root.toMathML('');
          host.remove();
          resolve(mml);
        } catch (err) {
          host.remove();
          reject(err);
        }
      });
    });
  }

  function sanitizeMathML(mml) {
    return mml
      .replace(/<!--[\\s\\S]*?-->/g, '')
      .replace(/<mo[^>]*>(?:&#x2061;|&#x2062;|&#x2063;|\\u2061|\\u2062|\\u2063)<\\/mo>/gi, '')
      .replace(/&#x2212;/gi, '-')
      .replace(/\\u2212/g, '-')
      .replace(/&#x2217;/gi, '*')
      .replace(/&#x0+([0-9a-fA-F]+);/g, (_, hex) => '&#x' + hex.toUpperCase() + ';')
      .replace(/\\s+display="[^"]*"/g, '')
      .replace(/\\s+class="[^"]*"/g, '')
      .replace(/\\s+stretchy="[^"]*"/g, '')
      .replace(/\\s+mathvariant="normal"/g, '')
      .replace(/>\\s+</g, '><')
      .trim();
  }

  function validateMathML(mml) {
    const allowlist = (window.mathTypeEditor && window.mathTypeEditor.MATHTYPE_ALLOWLIST) || [];
    let chk = mml;
    for (const item of allowlist) {
      chk = chk.replace(new RegExp('&#' + item + ';', 'g'), '');
    }
    return {
      invalidHex: chk.match(/&#[^;]+;/g) || [],
      invalidDollar: chk.match(/\\$/g) || [],
    };
  }

  function canonicalizeViaWiris(editorType, mml) {
    return new Promise((resolve) => {
      const ed = window.mathTypeEditor && window.mathTypeEditor[editorType];
      if (!ed || !ed.setMathMLWithCallback) return resolve(mml);
      const isOpen = !!document.querySelector('.mathtype.mtOpen') || !!(window.mathTypeOverlay && window.mathTypeOverlay.isActive());
      if (isOpen) return resolve(mml);
      ed.setMathMLWithCallback(mml, () => {
        const canonical = ed.getMathML() || mml;
        resolve(canonical);
      });
    });
  }

  // ---- Resolve user JSON into flat operations list ----
  // Supported JSON shapes:
  //   1) { "1": ["\\\\frac{\\\\pi}{8}"], "3": ["\\\\frac{\\\\pi}{8}", "0", ..., "x-axis", 2] }
  //   2) { "q1": [...], "q3": { "0": "...", "8": "x-axis" } }
  //   3) { "RA_4775996_2_0_4783275": "\\\\frac{\\\\pi}{8}", "RN_4776124_3_0_4783403": "1.2345" }
  const ops = [];
  for (const [key, val] of Object.entries(answers || {})) {
    if (key.startsWith('_')) continue; // allow metadata keys like "_comment", "_deployment"
    if (val === null || val === undefined) continue; // null = skip this question/box
    if (boxById.has(key)) {
      const { q, box } = boxById.get(key);
      ops.push({ q, box, rawValue: val });
      continue;
    }
    const qMatch = /^q?(\\d+)$/i.exec(key);
    if (qMatch) {
      const qNum = Number(qMatch[1]);
      const q = questionByNum.get(qNum);
      if (!q) {
        ops.push({ error: 'Question #' + qNum + ' not found on page', key });
        continue;
      }
      const boxes = (q.boxes || []).filter(Boolean);
      if (Array.isArray(val)) {
        val.forEach((itemVal, idx) => {
          if (itemVal === null || itemVal === undefined) return; // null = skip this box
          const box = boxes.find(b => Number(b.boxNum) === idx) || boxes[idx];
          if (!box) {
            ops.push({ error: 'Question #' + qNum + ' has no box index ' + idx, key });
          } else {
            ops.push({ q, box, rawValue: itemVal });
          }
        });
      } else if (val && typeof val === 'object' && !('latex' in val) && !('mathml' in val)) {
        for (const [boxKey, itemVal] of Object.entries(val)) {
          if (itemVal === null || itemVal === undefined) continue;
          const idx = Number(boxKey);
          const box = boxes.find(b => Number(b.boxNum) === idx || b.id === boxKey);
          if (!box) {
            ops.push({ error: 'Question #' + qNum + ' has no box ' + boxKey, key });
          } else {
            ops.push({ q, box, rawValue: itemVal });
          }
        }
      } else if (boxes.length === 1) {
        ops.push({ q, box: boxes[0], rawValue: val });
      } else {
        ops.push({ error: 'Question #' + qNum + ' has ' + boxes.length + ' boxes; provide an array or object map', key });
      }
    } else {
      ops.push({ error: 'Unrecognized target key: ' + key, key });
    }
  }

  function dispatchNativeEvent(el, type) {
    // MooTools 1.3.2 overrides window.Event; use document.createEvent for native DOM events!
    const ev = document.createEvent('Event');
    ev.initEvent(type, true, true);
    el.dispatchEvent(ev);
  }

  // ---- Execute operations ----
  const report = [];
  let touchedWiris = false;

  for (const op of ops) {
    if (op.error) {
      report.push({ status: 'error', key: op.key, error: op.error });
      continue;
    }
    const { q, box, rawValue } = op;
    const isMathType = box.boxType === 'A' && box.boxSettings && box.boxSettings.mathtype;
    const isPulldown = box.boxType === 'C' && box.boxSettings && box.boxSettings.pulldown;

    if (isMathType) {
      let mathml = '';
      if (typeof rawValue === 'object' && rawValue !== null && rawValue.mathml) {
        mathml = sanitizeMathML(String(rawValue.mathml));
      } else if (typeof rawValue === 'string' && rawValue.trim().startsWith('<math')) {
        mathml = sanitizeMathML(rawValue);
      } else {
        const latexStr = (typeof rawValue === 'object' && rawValue !== null && rawValue.latex) ? rawValue.latex : String(rawValue);
        const rawMml = await texToMathMLAsync(latexStr);
        mathml = sanitizeMathML(rawMml);
      }
      const editorType = (box.boxSettings && box.boxSettings.pad) || 'mt_calc';
      mathml = await canonicalizeViaWiris(editorType, mathml);
      touchedWiris = true;
      const check = validateMathML(mathml);

      if (!dryRun) {
        // Close any active editor before programmatic write
        if (window.mathTypeOverlay && window.mathTypeOverlay.isActive()) {
          await window.mathTypeOverlay.close({ restoreFocus: false });
        }
        const hiddenInput = document.getElementById(box.id);
        if (!hiddenInput) throw new Error('Hidden input missing for ' + box.id);
        hiddenInput.value = mathml;
        if (window.mathTypeOverlay && window.mathTypeOverlay.renderPreview) {
          window.mathTypeOverlay.renderPreview(box.id);
        }
        if (typeof window.warnInvalidMathTypeCharacters === 'function') {
          window.warnInvalidMathTypeCharacters(box.id);
        }
        box.updateResponseCache();
      }

      report.push({
        status: (check.invalidHex.length || check.invalidDollar.length) ? 'warning' : 'ok',
        question: Number(q.viewPosition),
        boxId: box.id,
        kind: 'mathtype',
        input: rawValue,
        mathml,
        validation: check,
        applied: !dryRun,
      });
    } else if (isPulldown) {
      const sel = document.getElementById(box.id);
      if (!sel) throw new Error('Select missing for ' + box.id);
      const targetStr = String(rawValue).trim();
      let matched = Array.from(sel.options).find(o => o.value === targetStr);
      if (!matched) {
        matched = Array.from(sel.options).find(o => o.text.trim().toLowerCase() === targetStr.toLowerCase());
      }
      if (!matched) {
        report.push({
          status: 'error',
          question: Number(q.viewPosition),
          boxId: box.id,
          kind: 'pulldown',
          input: rawValue,
          error: 'Option not found. Valid options: ' + Array.from(sel.options).map(o => o.value + ':' + o.text).join(', ')
        });
        continue;
      }
      if (!dryRun) {
        sel.value = matched.value;
        dispatchNativeEvent(sel, 'change');
        if (window.waHtmlPulldown && typeof window.waHtmlPulldown.refresh === 'function') {
          try { window.waHtmlPulldown.refresh(); } catch {}
        }
        box.updateResponseCache();
      }
      report.push({
        status: 'ok',
        question: Number(q.viewPosition),
        boxId: box.id,
        kind: 'pulldown',
        input: rawValue,
        resolvedValue: matched.value,
        resolvedText: matched.text,
        applied: !dryRun,
      });
    } else if (box.boxType === 'C') {
      const radios = Array.from(q.element.querySelectorAll('input[type="radio"][name="' + box.id + '"]'));
      const targetVal = String(rawValue).trim();
      const radio = radios.find(r => r.value === targetVal);
      if (!radio) {
        report.push({
          status: 'error',
          question: Number(q.viewPosition),
          boxId: box.id,
          kind: 'radio',
          input: rawValue,
          error: 'Radio value not found. Valid values: ' + radios.map(r => r.value).join(', ')
        });
        continue;
      }
      if (!dryRun) {
        radio.checked = true;
        dispatchNativeEvent(radio, 'click');
        dispatchNativeEvent(radio, 'change');
        box.updateResponseCache();
      }
      report.push({
        status: 'ok',
        question: Number(q.viewPosition),
        boxId: box.id,
        kind: 'radio',
        input: rawValue,
        resolvedValue: radio.value,
        applied: !dryRun,
      });
    } else if (box.boxType === 'S') {
      const vals = Array.isArray(rawValue) ? rawValue.map(String) : String(rawValue).split(',').map(s => s.trim());
      if (!dryRun) {
        box.setResponse(vals.join(','));
      }
      report.push({
        status: 'ok',
        question: Number(q.viewPosition),
        boxId: box.id,
        kind: 'checkbox',
        input: rawValue,
        resolvedValue: vals.join(','),
        applied: !dryRun,
      });
    } else {
      // RN_* numeric / plain text / essay
      const el = document.getElementById(box.id);
      const valStr = String(rawValue);
      if (!dryRun) {
        if (el) {
          el.value = valStr;
          dispatchNativeEvent(el, 'input');
          dispatchNativeEvent(el, 'change');
        } else {
          box.setResponse(valStr);
        }
        box.updateResponseCache();
      }
      report.push({
        status: 'ok',
        question: Number(q.viewPosition),
        boxId: box.id,
        kind: box.boxType === 'N' ? 'numeric' : 'text',
        input: rawValue,
        resolvedValue: valStr,
        applied: !dryRun,
      });
    }
  }

  // Reset shared WIRIS editor back to clean empty state
  if (touchedWiris && window.mathTypeEditor && window.mathTypeEditor.mt_calc) {
    await canonicalizeViaWiris('mt_calc', window.mathTypeEditor.MATHTYPE_DEFAULT);
  }

  let saveResult = null;
  let submitResult = null;

  if (!dryRun) {
    assignment.updateCache();
    if (assignment.updateChangedList) assignment.updateChangedList();
    if (assignment.updateDisplay) assignment.updateDisplay();

    if (save) {
      saveResult = await new Promise((resolve) => {
        assignment.saveAll(null, (err, res) => {
          resolve(err ? { ok: false, error: String(err) } : { ok: true, result: res });
        });
      });
    }
    if (submitQuestion != null) {
      const q = questionByNum.get(Number(submitQuestion));
      if (!q) throw new Error('submitQuestion #' + submitQuestion + ' not found');
      q.submit(true);
      submitResult = { submittedQuestion: Number(submitQuestion) };
    } else if (submitAll) {
      assignment.submitAll();
      submitResult = { submittedAll: true };
    }
  }

  return {
    dryRun: !!dryRun,
    deployment: dep,
    processed: report.length,
    okCount: report.filter(r => r.status === 'ok').length,
    warningCount: report.filter(r => r.status === 'warning').length,
    errorCount: report.filter(r => r.status === 'error').length,
    saveResult,
    submitResult,
    report,
  };
`;

// ---------------------------------------------------------------------------
// 4. CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[k] = true;
      } else {
        args[k] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function buildTemplate(schema) {
  const tpl = {
    _comment: `${schema.title} (dep=${schema.deployment}). Fill values below; null skips a box. MathType (RA_*) accepts LaTeX or <math>...</math>. Pulldown accepts option text or value.`,
    _deployment: schema.deployment,
  };
  for (const q of schema.questions) {
    const key = `q${q.questionNumber}`;
    if (q.boxes.length === 1) {
      const b = q.boxes[0];
      tpl[key] = b.currentValue ? null : '';
    } else {
      tpl[key] = q.boxes.map((b) => {
        if (b.kind === 'pulldown') return b.options.filter(o => o.value !== '').map(o => o.text).join(' | ');
        if (b.kind === 'radio') return `0..${b.choices.length - 1}`;
        return '';
      });
    }
  }
  return tpl;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const channel = args.channel || 'applescript';

  if (!cmd || cmd === 'help' || args.help) {
    console.log(`WebAssign JSON Automation CLI

Usage:
  node webassign-cli.mjs dump [--out schema.json] [--template answers.template.json] [--channel applescript|cdp]
  node webassign-cli.mjs fill <answers.json> [--dry-run] [--save] [--submit-question <N>] [--submit-all] [--channel applescript|cdp]
`);
    process.exit(0);
  }

  if (cmd === 'dump') {
    const schema = await runInMainWorld(channel, DUMP_PAGE_SCRIPT);
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(schema, null, 2), 'utf8');
      console.error(`Wrote schema to ${args.out}`);
    }
    if (args.template) {
      const tpl = buildTemplate(schema);
      fs.writeFileSync(args.template, JSON.stringify(tpl, null, 2), 'utf8');
      console.error(`Wrote answer template to ${args.template}`);
    }
    if (!args.out) {
      console.log(JSON.stringify(schema, null, 2));
    } else {
      console.log(JSON.stringify({
        title: schema.title,
        deployment: schema.deployment,
        questionCount: schema.questionCount,
        totalBoxes: schema.totalBoxes,
        out: args.out,
        template: args.template || null,
      }, null, 2));
    }
    return;
  }

  if (cmd === 'fill') {
    const jsonPath = args._[1];
    if (!jsonPath) throw new Error('Missing <answers.json> argument');
    const answers = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const result = await runInMainWorld(channel, FILL_PAGE_SCRIPT, {
      answers,
      dryRun: Boolean(args['dry-run']),
      save: Boolean(args.save),
      submitQuestion: args['submit-question'] ? Number(args['submit-question']) : null,
      submitAll: Boolean(args['submit-all']),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message || err);
  process.exit(1);
});
