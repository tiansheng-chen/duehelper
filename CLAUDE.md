# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two parallel implementations of the **same** Canvas API classification logic. The extension (published name **DueHelper**) targets any Canvas LMS instance the user configures; `probe.py` is a personal script and stays hardcoded to `canvas.sydney.edu.au`.

- **`probe.py`** — Python CLI, the reference / source of truth. Uses a personal access token from `.env` (`CANVAS_TOKEN`) and prints four buckets to stdout. Host is hardcoded.
- **`popup.js` + `popup.html` + `popup.css` + `manifest.json`** — Chrome MV3 extension. Same buckets, rendered in a popup. No token: it runs against the browser's Canvas session cookie via `credentials: "include"`. Host is read from storage at load time.
- **`options.html` + `options.css` + `options.js`** — extension options page, opened as an embedded modal (`options_ui.open_in_tab: false`) from the popup's gear button (`chrome.runtime.openOptionsPage()`). Two jobs: (1) set the Canvas host and request runtime host permission for it; (2) toggle per-course visibility.

The four buckets, in both implementations:

1. **未来 deadline** — planner items in next 21 days, not submitted, `plannable_type` in `{assignment, quiz, discussion_topic, planner_note}`
2. **等待评分** — `submission.submitted_at` set but not yet graded
3. **待定** — no `due_at`, not submitted (assignment published without a deadline)
4. **已完成** — `submission.workflow_state === "graded"` and `score != null`

`excused` submissions are dropped from all four.

## Commands

```bash
# CLI
python probe.py              # print four buckets (needs .env with CANVAS_TOKEN)
python probe.py --courses    # list all courses + IDs, for editing EXCLUDED_COURSE_IDS

# Extension
# 1. chrome://extensions → enable Developer mode → "Load unpacked" → pick this folder
# 2. Open the popup → "打开设置" → enter your Canvas host and click "保存并授权"
#    (Chrome will prompt for permission to access that host)
# 3. Make sure you're logged in to that host in the same browser profile
# 4. Click the extension icon
```

No build step, no tests, no lint config. `probe.py` deps: `requests`, `python-dotenv`.

## Architecture notes

### Keep the two implementations aligned

The extension is a port of `probe.py`. When behavior differs, `probe.py` is the reference — verify against its output before assuming the extension is wrong. Key mirror points:

- **`classify(assignment, course_id)`** — same 4-way decision tree (`probe.py:142-184` ↔ `popup.js` `classify()`). Order matters: `excused` → `graded` → `pending` → `undated` → drop.
- **Course hiding** — `probe.py` uses a hardcoded `EXCLUDED_COURSE_IDS` set at `probe.py:37-44`. The extension reads from `chrome.storage.sync` under key **`hiddenCourseIds`** (a numeric-ID array), edited via the options page; the two are intentionally independent (the extension has no fixed default seed). Semantics store **hidden** IDs, not shown IDs — this is load-bearing: when a new course appears in Canvas (e.g. new semester), it is visible by default without the user having to touch settings. Empty or missing storage ⇒ nothing hidden.
- **Planner filter** — must match on `plannable_type`, non-null due, not submitted, and course not hidden.

### Pagination

Canvas returns `Link: <...>; rel="next"` headers. Both `paginatedGet` implementations parse it and follow until absent. 403/404 returns partial results (some course endpoints are disabled — don't fail the whole run).

### Timezone

All times are UTC in the API. Both implementations convert to **`Australia/Sydney`** for display and for day-bucketing:

- `probe.py` uses `zoneinfo.ZoneInfo`
- `popup.js` uses `Intl.DateTimeFormat` with `timeZone: "Australia/Sydney"`; `daysUntilSydney()` derives day-diffs from the formatted `YYYY-MM-DD` key rather than a raw ms subtraction (needed for correct "今天 / 明天 / N天后" near midnight).

### Extension-only concerns

- **Auth**: no token. `fetch(url, { credentials: "include" })` picks up the Canvas session cookie. The extension origin needs host permission for the target Canvas host in order for cookies to be attached from the popup context.
- **Host permission model**: `manifest.json` declares `optional_host_permissions: ["https://*/*"]` — nothing granted at install time. When the user saves a host in options, `chrome.permissions.request({ origins: [`https://<host>/*`] })` is called from the "保存并授权" button (must be a user-gesture handler). Only after `granted === true` does `canvasHost` get written to storage. On host change we call `chrome.permissions.remove` for the old host and clear `hiddenCourseIds` (numeric course IDs are per-installation, so keeping the old set would silently hide unrelated courses at the new school).
- **Storage keys** (`chrome.storage.sync`):
  - `canvasHost` — string like `"canvas.example.edu"`, no scheme, no path. Unset = onboarding state.
  - `hiddenCourseIds` — array of numeric course IDs. Empty/unset = nothing hidden. **Hidden**, not shown — see the alignment note above.
- **Onboarding / degraded state**: both popup and options handle three states before fetching — no host, host set but no permission (revoked externally), and ready. Popup renders an onboarding card with an "打开设置" button in the first two states; options page shows a hint in the courses section and lets the user fix it via the host form.
- **Popup ↔ options handoff**: options writes to `chrome.storage.sync`; popup re-reads on every open (`load()` calls `getCanvasHost()` and `getHiddenIds()` fresh). No `storage.onChanged` listener — popup is normally closed while the user is in options.
- **Concurrency**: `Promise.all` over all active course IDs for `/courses/:id/assignments` (mirrors `probe.py`'s `ThreadPoolExecutor(max_workers=8)`). Planner is fired in parallel with courses.
- **Course display**: extension shows `course_code` (e.g. `COMP5310`) rather than the full name, with the full name in a `title` tooltip. `probe.py` shows a truncated name — intentional divergence.
- **Urgency coloring** (extension only): time column colored by days-until — `≤3` urgent (red), `≤7` warn (orange), else calm (dim). Only the "未来 deadline" block uses this.
- **Graded block** is collapsed by default (`<details>` / `<summary>`).

### Styling

- Glassmorphism via `backdrop-filter` on `.block` cards over a fixed gradient body background. Popup itself is opaque — the blur only works on layers inside the popup, so the effect requires the body gradient underneath.
- All colors flow through CSS custom properties on `:root`, overridden inside `@media (prefers-color-scheme: light)`. Component rules never carry a media query.
- Entry animation is a one-shot 40ms-staggered fade (≤200ms total), gated by `prefers-reduced-motion`. No persistent animation, no glow, no colored shadow — the design brief is deliberately restrained.

## Files to leave alone unless asked

- **`probe.py`** — the reference implementation. Don't refactor it as a side effect of extension work.
- **`.env`** — gitignored, contains `CANVAS_TOKEN`. Never read or echo it.
