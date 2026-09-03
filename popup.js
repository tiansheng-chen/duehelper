// Canvas host is user-configured via the options page and requested at runtime
// through optional_host_permissions. These get set at the start of load().
let apiHost = null;
let apiBase = null;

const DAYS_AHEAD = 21;
const TZ = "Australia/Sydney";
const ACTIONABLE_TYPES = new Set([
  "assignment",
  "quiz",
  "discussion_topic",
  "planner_note",
]);
async function getCanvasHost() {
  const { canvasHost } = await chrome.storage.sync.get("canvasHost");
  return canvasHost || null;
}

async function hasHostPermission(host) {
  return chrome.permissions.contains({ origins: [`https://${host}/*`] });
}

// 存的是"隐藏的课程 id 数组",空 / 未设置 = 全部显示。
// 语义特意选 hidden 而不是 shown,这样新学期的新课默认可见,不需要手动进设置勾选。
async function getHiddenIds() {
  const { hiddenCourseIds } = await chrome.storage.sync.get("hiddenCourseIds");
  return new Set(Array.isArray(hiddenCourseIds) ? hiddenCourseIds : []);
}

function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/\s*<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function paginatedGet(url, params) {
  const results = [];
  let target = url;
  if (params) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
      else u.searchParams.set(k, v);
    }
    target = u.toString();
  }

  while (target) {
    const resp = await fetch(target, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (resp.status === 401) {
      throw new Error("未登录 Canvas — 请先在 canvas.sydney.edu.au 登录后再试");
    }
    if (resp.status === 403 || resp.status === 404) return results;
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${target}`);
    const batch = await resp.json();
    results.push(...batch);
    target = nextLink(resp.headers.get("Link"));
  }
  return results;
}

function fetchCourses() {
  return paginatedGet(`${apiBase}/courses`, {
    enrollment_state: "active",
    "include[]": ["term", "total_scores"],
    per_page: 100,
  });
}

function fetchPlanner() {
  const now = new Date();
  const end = new Date(now.getTime() + DAYS_AHEAD * 86400 * 1000);
  return paginatedGet(`${apiBase}/planner/items`, {
    start_date: now.toISOString(),
    end_date: end.toISOString(),
    per_page: 50,
  });
}

function fetchCourseAssignments(courseId) {
  return paginatedGet(`${apiBase}/courses/${courseId}/assignments`, {
    "include[]": "submission",
    per_page: 100,
  });
}

function normalizePlanner(item) {
  const p = item.plannable || {};
  const due = p.due_at || p.todo_date || item.plannable_date;
  const subs = item.submissions;
  return {
    title: p.title || "(无标题)",
    courseId: item.course_id,
    type: item.plannable_type,
    due: due ? new Date(due) : null,
    submitted: !!(subs && subs.submitted),
    url: item.html_url,
  };
}

// 对齐 probe.py 的 classify():excused 直接排除,其余按 graded > pending > undated 顺序判断。
// 有 due_at 但未提交的这里返回 null —— 由 planner 那条线负责。
function classify(a, courseId) {
  const sub = a.submission || {};
  const state = sub.workflow_state;
  if (sub.excused) return null;

  const base = {
    title: a.name || "(无标题)",
    courseId,
    url: a.html_url,
    pointsPossible: a.points_possible,
  };

  if (state === "graded" && sub.score != null) {
    return {
      kind: "graded",
      ...base,
      score: sub.score,
      grade: sub.grade,
      gradedAt: sub.graded_at ? new Date(sub.graded_at) : null,
    };
  }
  if (sub.submitted_at) {
    return {
      kind: "pending",
      ...base,
      submittedAt: new Date(sub.submitted_at),
      needsReview: state === "pending_review",
      late: !!sub.late,
    };
  }
  if (!a.due_at) {
    return {
      kind: "undated",
      ...base,
      createdAt: a.created_at ? new Date(a.created_at) : null,
    };
  }
  return null;
}

const fmtDayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const fmtDayLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "2-digit",
  month: "short",
});
const fmtTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fmtSubmit = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "2-digit",
  month: "short",
});

function resolveUrl(url) {
  if (!url || !apiHost) return null;
  try {
    return new URL(url, `https://${apiHost}`).toString();
  } catch {
    return null;
  }
}

// 按 Sydney 本地日期算天数差,避免临近午夜的跨天误判
function daysUntilSydney(when) {
  const nowKey = fmtDayKey.format(new Date());
  const whenKey = fmtDayKey.format(when);
  const [ya, ma, da] = nowKey.split("-").map(Number);
  const [yb, mb, db] = whenKey.split("-").map(Number);
  return Math.round(
    (Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000,
  );
}

function relativeDay(due) {
  const d = daysUntilSydney(due);
  let text;
  if (d === 0) text = "今天";
  else if (d === 1) text = "明天";
  else if (d < 0) text = `${-d}天前`;
  else text = `${d}天后`;
  const urgency = d <= 3 ? "urgent" : d <= 7 ? "warn" : "calm";
  return { text, urgency };
}

function displayCourse(info) {
  return info?.code || info?.name || "—";
}

function fmtNum(n) {
  if (n == null) return "";
  return Number.isInteger(n) ? String(n) : String(n);
}

function makeBlock(title, count, { collapsible = false } = {}) {
  if (collapsible) {
    const details = document.createElement("details");
    details.className = "block";
    const summary = document.createElement("summary");
    summary.className = "block-title";
    summary.textContent = `${title}（${count}）`;
    details.appendChild(summary);
    return details;
  }
  const article = document.createElement("article");
  article.className = "block";
  const h = document.createElement("h2");
  h.className = "block-title";
  h.textContent = `${title}（${count}）`;
  article.appendChild(h);
  return article;
}

function emptyLine() {
  const p = document.createElement("div");
  p.className = "empty";
  p.textContent = "（无）";
  return p;
}

function makeTitle(text, url) {
  const href = resolveUrl(url);
  const el = document.createElement(href ? "a" : "span");
  el.className = "title";
  el.textContent = text;
  if (href) {
    el.href = href;
    el.target = "_blank";
    el.rel = "noopener";
  }
  return el;
}

function renderDeadlines(container, dated, courses) {
  const block = makeBlock(`未来 ${DAYS_AHEAD} 天`, dated.length);
  if (dated.length === 0) {
    block.appendChild(emptyLine());
    container.appendChild(block);
    return;
  }

  const byDay = new Map();
  for (const it of dated) {
    const key = fmtDayKey.format(it.due);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(it);
  }

  for (const items of byDay.values()) {
    const dayHeader = document.createElement("h3");
    dayHeader.className = "day-label";
    dayHeader.textContent = fmtDayLabel.format(items[0].due);
    block.appendChild(dayHeader);

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "row";

      const rel = relativeDay(it.due);
      const timeCell = document.createElement("span");
      timeCell.className = "deadline-cell";
      const relEl = document.createElement("span");
      relEl.className = `rel-time urgency-${rel.urgency}`;
      relEl.textContent = rel.text;
      const clock = document.createElement("span");
      clock.className = "clock";
      clock.textContent = fmtTime.format(it.due);
      timeCell.append(relEl, clock);

      const info = courses.get(it.courseId);
      const course = document.createElement("span");
      course.className = "course";
      course.textContent = displayCourse(info);
      if (info?.name) course.title = info.name;

      row.append(timeCell, course, makeTitle(it.title, it.url));
      block.appendChild(row);
    }
  }
  container.appendChild(block);
}

function renderPending(container, pending, courses) {
  const block = makeBlock("等待评分", pending.length);
  if (pending.length === 0) {
    block.appendChild(emptyLine());
    container.appendChild(block);
    return;
  }

  const now = Date.now();
  for (const it of pending) {
    const row = document.createElement("div");
    row.className = "pending-row";

    const days = Math.floor((now - it.submittedAt.getTime()) / 86400000);
    const date = document.createElement("span");
    date.className = "date";
    date.textContent = `${fmtSubmit.format(it.submittedAt)} · ${days}天前`;

    const info = courses.get(it.courseId);
    const course = document.createElement("span");
    course.className = "course";
    course.textContent = displayCourse(info);
    if (info?.name) course.title = info.name;

    const titleCell = document.createElement("span");
    titleCell.className = "title-cell";
    titleCell.appendChild(makeTitle(it.title, it.url));
    if (it.needsReview) {
      const flag = document.createElement("span");
      flag.className = "flag flag-review";
      flag.textContent = "需批改";
      titleCell.appendChild(flag);
    }
    if (it.late) {
      const flag = document.createElement("span");
      flag.className = "flag flag-late";
      flag.textContent = "迟交";
      titleCell.appendChild(flag);
    }

    row.append(date, course, titleCell);
    block.appendChild(row);
  }
  container.appendChild(block);
}

function renderUndated(container, undated, courses) {
  const block = makeBlock("待定", undated.length);
  if (undated.length === 0) {
    block.appendChild(emptyLine());
    container.appendChild(block);
    return;
  }

  for (const it of undated) {
    const row = document.createElement("div");
    row.className = "undated-row";

    const info = courses.get(it.courseId);
    const course = document.createElement("span");
    course.className = "course";
    course.textContent = displayCourse(info);
    if (info?.name) course.title = info.name;

    row.append(course, makeTitle(it.title, it.url));
    block.appendChild(row);
  }
  container.appendChild(block);
}

function renderGraded(container, graded, courses) {
  const block = makeBlock("已完成", graded.length, { collapsible: true });
  if (graded.length === 0) {
    block.appendChild(emptyLine());
    container.appendChild(block);
    return;
  }

  const byCourse = new Map();
  for (const it of graded) {
    if (!byCourse.has(it.courseId)) byCourse.set(it.courseId, []);
    byCourse.get(it.courseId).push(it);
  }

  // 保持 /courses API 的返回顺序
  for (const [cid, info] of courses) {
    const items = byCourse.get(cid);
    if (!items) continue;

    const header = document.createElement("h3");
    header.className = "course-header";
    header.textContent = info.name;
    if (info.score != null) {
      const totals = document.createElement("span");
      totals.className = "totals";
      let txt = `   —   当前总分 ${info.score}%`;
      if (info.grade) txt += ` (${info.grade})`;
      totals.textContent = txt;
      header.appendChild(totals);
    }
    block.appendChild(header);

    items.sort(
      (a, b) => (a.gradedAt?.getTime() || 0) - (b.gradedAt?.getTime() || 0),
    );

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "graded-row";

      const poss = it.pointsPossible;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = poss
        ? `${fmtNum(it.score)}/${fmtNum(poss)}`
        : fmtNum(it.score);

      const pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = poss ? `${((it.score / poss) * 100).toFixed(1)}%` : "";

      row.append(score, pct, makeTitle(it.title, it.url));
      block.appendChild(row);
    }
  }
  container.appendChild(block);
}

function renderOnboarding(container, message) {
  const wrap = document.createElement("div");
  wrap.className = "block onboarding";
  const p = document.createElement("p");
  p.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "打开设置";
  btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  wrap.append(p, btn);
  container.appendChild(wrap);
}

async function load() {
  const status = document.getElementById("status");
  const content = document.getElementById("content");
  status.textContent = "加载中…";
  content.textContent = "";

  const host = await getCanvasHost();
  if (!host) {
    status.textContent = "";
    renderOnboarding(content, "还没设置 Canvas 域名。填一下你所在学校的地址就能开始。");
    return;
  }
  if (!(await hasHostPermission(host))) {
    status.textContent = "";
    renderOnboarding(content, `尚未授权访问 ${host},请在设置里重新保存并授权。`);
    return;
  }
  apiHost = host;
  apiBase = `https://${host}/api/v1`;

  try {
    const plannerPromise = fetchPlanner();
    const [coursesRaw, hiddenIds] = await Promise.all([
      fetchCourses(),
      getHiddenIds(),
    ]);

    // Map<id, {name, score, grade}> —— 插入顺序 = API 顺序,方便"已完成"块按课程排列
    const courses = new Map();
    for (const c of coursesRaw) {
      if (hiddenIds.has(c.id)) continue;
      const enroll = (c.enrollments || [{}])[0] || {};
      courses.set(c.id, {
        name: c.name || "?",
        code: c.course_code || null,
        score: enroll.computed_current_score,
        grade: enroll.computed_current_grade,
      });
    }

    const activeIds = [...courses.keys()];
    const assignmentsPromise = Promise.all(
      activeIds.map(async (id) => [id, await fetchCourseAssignments(id)]),
    );

    const [plannerRaw, perCourse] = await Promise.all([
      plannerPromise,
      assignmentsPromise,
    ]);

    const dated = plannerRaw
      .map(normalizePlanner)
      .filter(
        (it) =>
          it.due &&
          !it.submitted &&
          ACTIONABLE_TYPES.has(it.type) &&
          courses.has(it.courseId),
      )
      .sort((a, b) => a.due - b.due);

    const pending = [];
    const undated = [];
    const graded = [];
    for (const [cid, assignments] of perCourse) {
      for (const a of assignments) {
        const r = classify(a, cid);
        if (!r) continue;
        if (r.kind === "pending") pending.push(r);
        else if (r.kind === "undated") undated.push(r);
        else if (r.kind === "graded") graded.push(r);
      }
    }
    pending.sort((a, b) => b.submittedAt - a.submittedAt);
    undated.sort(
      (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0),
    );

    status.textContent =
      `${courses.size} 门课 · 待办 ${dated.length} · 待评 ${pending.length}` +
      ` · 待定 ${undated.length} · 已评 ${graded.length}`;

    renderDeadlines(content, dated, courses);
    renderPending(content, pending, courses);
    renderUndated(content, undated, courses);
    renderGraded(content, graded, courses);
  } catch (e) {
    status.textContent = "";
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = e.message || String(e);
    content.appendChild(p);
  }
}

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("settings").addEventListener("click", () => {
  // 某些环境下(比如某些 Chromium 分支或早期版本)openOptionsPage 会 reject,
  // 手动降级到新开一个 tab 打开 options.html
  Promise.resolve(chrome.runtime.openOptionsPage()).catch(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  });
});
load();
