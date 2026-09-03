# DueHelper

A Chrome extension that pulls your Canvas LMS deadlines, pending submissions, and
grades into a single popup, so you don't have to click through course pages to find
out what's actually due.

Works with any institution's Canvas instance — you enter your own domain once.

---

## Why

Canvas has a planner, but it mixes lecture times and tutorial slots in with real
deadlines. In a typical week it showed me 22 items when only 6 were things I had to
submit. The other 16 were recurring calendar events for classes I was already
attending.

It also has no view for *"I submitted this, has it been marked yet?"* — that state
exists in the API but isn't surfaced anywhere in the UI. I found a quiz that had been
sitting ungraded for 13 days only because I went looking in the raw API response.

DueHelper filters the noise and adds the missing state.

## What it shows

| Section | Rule |
|---|---|
| **Upcoming** | Due in the next 21 days, not yet submitted. Grouped by day, colour-coded by urgency (≤3 days red, ≤7 orange, beyond that dim). |
| **Awaiting grading** | Submitted but not marked, with how long it's been waiting. Flags for *needs manual review* and *late*. |
| **Undated** | Published by the instructor with no due date set. |
| **Completed** | Graded, with score, percentage, and per-course running total. Collapsed by default. |

Excused assignments are excluded from all four.

Courses you don't care about — orientation modules, compliance training, student
portals — can be hidden from the settings page. New courses appearing in a later
semester are visible by default, so nothing gets silently dropped.

## Install

Not on the Chrome Web Store yet. To run it locally:

1. Clone or download this repo
2. Go to `chrome://extensions`, turn on **Developer mode**
3. Click **Load unpacked** and select the project folder
4. Click the extension icon → **打开设置**
5. Enter your Canvas domain (e.g. `canvas.sydney.edu.au`) and click **保存并授权** —
   Chrome will ask permission for that one domain
6. Make sure you're logged in to Canvas in the same browser profile

## How it works

The extension makes read-only requests to the Canvas REST API using the session
cookie you're already signed in with. There's no access token to generate, no OAuth
flow, and nothing to copy-paste.

```
GET /api/v1/courses?enrollment_state=active&include[]=term&include[]=total_scores
GET /api/v1/planner/items?start_date=…&end_date=…
GET /api/v1/courses/:id/assignments?include[]=submission
```

Notes on the implementation:

- **Pagination** — Canvas returns `Link: <…>; rel="next"`; the client follows it until
  absent. A 403/404 on one course returns partial results instead of failing the
  whole load (some institutions disable specific endpoints per course).
- **Timezone** — the API returns UTC. Day bucketing and the "N days from now" label
  are computed from timezone-formatted date keys rather than raw millisecond
  differences, so items near midnight don't land on the wrong day.
- **Concurrency** — the planner request and the per-course assignment requests all
  run in parallel; a typical load is one round trip deep, not N.
- **Host permissions** — declared as `optional_host_permissions`, so the extension
  requests access to nothing at install time. Permission for your specific Canvas
  domain is requested at runtime when you save it in settings.

### `probe.py`

Before writing any extension code I built a Python CLI against the same endpoints to
work out the API's actual behaviour — which fields exist, how pagination is
signalled, how submission states are represented. It's still in the repo as the
reference implementation: when the extension shows something unexpected, this is
what I check against.

```bash
pip install requests python-dotenv
echo "CANVAS_TOKEN=your_token" > .env
python probe.py            # print the four sections
python probe.py --courses  # list courses and IDs
```

It uses a personal access token (Canvas → Account → Settings → New Access Token) and
is hardcoded to one host, since it's a development tool rather than something meant
to be distributed.

## Privacy

No data leaves your browser. There is no backend, no analytics, and no third-party
service of any kind. Canvas responses are held in memory only while the popup is
open.

Two preferences are stored via `chrome.storage.sync`: the Canvas domain you entered,
and the IDs of courses you chose to hide. No assignment titles, grades, or personal
information are persisted.

Full policy: [privacy policy](https://tiansheng-chen.github.io/duehelper/)

## Project layout

```
manifest.json         MV3 manifest
popup.html/css/js     the main panel
options.html/css/js   domain setup + course visibility
probe.py              Python reference implementation
icon{16,48,128}.png
```

No build step, no dependencies, no framework — plain HTML/CSS/JS loaded directly by
Chrome.

## Licence

MIT

---

Not affiliated with, endorsed by, or sponsored by Instructure, Inc.
Canvas is a trademark of Instructure, Inc.
