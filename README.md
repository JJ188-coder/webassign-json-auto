# webassign-json-auto

JSON-driven CLI for inspecting and filling WebAssign assignment pages directly in your existing logged-in Chrome tab — zero external npm dependencies (uses Node.js 22+ built-in `fetch` / `WebSocket`).

## Features

- **Zero-restart browser reuse**: Works directly against your logged-in Chrome tab via either:
  - **macOS AppleScript JS** (`--channel applescript`, default) — enable **View → Developer → Allow JavaScript from Apple Events** in Chrome.
  - **Chrome DevTools Protocol** (`--channel cdp`) — connects to an existing Chrome instance running on `localhost:9222` (or `CDP_PORT`).
- **Full WebAssign widget coverage**:
  - `RA_*` (**WIRIS MathType / calcPad**): Accepts plain **LaTeX** (or raw MathML), converts via the page's own MathJax 2.7.9, auto-groups bare exponent parentheses like `(1+x)^6`, cleans non-allowlisted entities against `MATHTYPE_ALLOWLIST`, canonicalizes via `window.mathTypeEditor.mt_calc`, updates the hidden MathML field, renders the live SVG preview (`mathTypeOverlay.renderPreview`), and syncs `WA.Question.Box`.
  - `RN_*` (**Numeric / plain text**): Sets value, dispatches native DOM `input`/`change` events (safely avoiding MooTools 1.3.2's `window.Event` override), and syncs cache.
  - `RC_*` (**Pulldown `<select>`**): Matches by option value or visible text and refreshes `waHtmlPulldown`.
  - `RC_*` / `RS_*` (**Radio / Checkbox**): Selects matching choice(s) and syncs cache.
- **Safe by default**:
  - `--dry-run`: Converts LaTeX → MathML, validates against WebAssign's character allowlist, and verifies target box mapping without touching the page.
  - Default `fill`: Fills UI only without submitting.
  - `--save`: Triggers WebAssign's official AJAX draft save (`POST /web/Rest/Response/save`).
  - `--submit-question <N>` / `--submit-all`: Optional explicit submission.

## Quick Start

### 1. Export assignment schema & blank answers template

```bash
node webassign-cli.mjs dump \
  --out assignment-schema.json \
  --template answers.json
```

### 2. Edit `answers.json`

See [`examples/answers.example.json`](examples/answers.example.json). You can address boxes by:
- Question number (`"q3"` or `"3"`) with an array of values, single value (for 1-box questions), or index map (`{ "0": "...", "8": "x-axis" }`)
- Exact WebAssign box ID (`"RA_..."`, `"RN_..."`, `"RC_..."`)
- Use `null` to skip already-completed questions or individual boxes.

### 3. Validate (`--dry-run`), fill, and save draft

```bash
# Dry-run validation (no page mutation)
node webassign-cli.mjs fill answers.json --dry-run

# Fill into live Chrome tab + save draft to WebAssign server
node webassign-cli.mjs fill answers.json --save

# Use CDP channel instead of macOS AppleScript
node webassign-cli.mjs fill answers.json --save --channel cdp
```

### Optional: Submit

```bash
# Submit a single question
node webassign-cli.mjs fill answers.json --submit-question 3

# Submit entire assignment
node webassign-cli.mjs fill answers.json --submit-all
```
