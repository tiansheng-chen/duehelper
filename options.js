const HOST_KEY = "canvasHost";
const HIDDEN_KEY = "hiddenCourseIds";

let apiBase = null; // set once we have a host + permission

// -------- storage / permission --------

async function getCanvasHost() {
  const { [HOST_KEY]: v } = await chrome.storage.sync.get(HOST_KEY);
  return v || null;
}

async function saveCanvasHost(host) {
  await chrome.storage.sync.set({ [HOST_KEY]: host });
}

async function hasHostPermission(host) {
  return chrome.permissions.contains({ origins: [`https://${host}/*`] });
}

async function getHiddenIds() {
  const { [HIDDEN_KEY]: v } = await chrome.storage.sync.get(HIDDEN_KEY);
  return new Set(Array.isArray(v) ? v : []);
}

async function saveHiddenIds(set) {
  await chrome.storage.sync.set({ [HIDDEN_KEY]: [...set] });
}

// -------- host validation --------

function sanitizeHost(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

// 简单的主机名校验:允许字母数字/破折号,至少一个点,顶级 >=2 字母
function isValidHost(host) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)
    && !host.startsWith("-") && !host.endsWith("-");
}

// -------- Canvas HTTP --------

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
      throw new Error("未登录 Canvas — 请先在该域名下登录后再回到这里");
    }
    if (resp.status === 403 || resp.status === 404) return results;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    results.push(...(await resp.json()));
    target = nextLink(resp.headers.get("Link"));
  }
  return results;
}

function fetchCourses() {
  return paginatedGet(`${apiBase}/courses`, {
    enrollment_state: "active",
    "include[]": ["term"],
    per_page: 100,
  });
}

// -------- UI helpers --------

function coursesEmpty(msg, isError = false) {
  const status = document.getElementById("courses-status");
  const list = document.getElementById("list");
  status.classList.toggle("error", isError);
  status.textContent = msg;
  list.textContent = "";
}

function updateCoursesCounter(total, hiddenCount) {
  const status = document.getElementById("courses-status");
  status.classList.remove("error");
  status.textContent = `共 ${total} 门课 · 显示 ${total - hiddenCount} · 隐藏 ${hiddenCount}`;
}

function setHostStatus(msg, kind) {
  const el = document.getElementById("host-status");
  el.classList.remove("error", "ok");
  if (kind) el.classList.add(kind);
  el.textContent = msg || "";
}

// -------- host section --------

async function handleSaveHost() {
  const input = document.getElementById("host-input");
  const saveBtn = document.getElementById("save-host");

  const host = sanitizeHost(input.value);
  if (!host) {
    setHostStatus("请输入域名", "error");
    return;
  }
  if (!isValidHost(host)) {
    setHostStatus("域名格式不正确", "error");
    return;
  }
  input.value = host; // reflect sanitized form back

  saveBtn.disabled = true;
  setHostStatus("等待授权…");
  try {
    const granted = await chrome.permissions.request({
      origins: [`https://${host}/*`],
    });
    if (!granted) {
      setHostStatus("授权被拒绝,未保存", "error");
      return;
    }
    const oldHost = await getCanvasHost();
    await saveCanvasHost(host);

    // 切换学校:老域名权限收回,老的 hiddenCourseIds 清空
    // (不同学校的 course id 会冲突,继续复用会导致新学校莫名有课被藏起来)
    if (oldHost && oldHost !== host) {
      await chrome.storage.sync.remove(HIDDEN_KEY);
      try {
        await chrome.permissions.remove({ origins: [`https://${oldHost}/*`] });
      } catch {
        /* 忽略,可能已经不存在 */
      }
    }

    setHostStatus(`已保存并授权 ${host}`, "ok");
    await loadCourses();
  } catch (e) {
    setHostStatus(e.message || String(e), "error");
  } finally {
    saveBtn.disabled = false;
  }
}

async function initHostSection() {
  const input = document.getElementById("host-input");
  const current = await getCanvasHost();
  if (current) input.value = current;

  document.getElementById("save-host").addEventListener("click", handleSaveHost);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSaveHost();
  });
}

// -------- course list --------

async function loadCourses() {
  const host = await getCanvasHost();
  if (!host) {
    coursesEmpty("请先在上方设置 Canvas 域名。");
    return;
  }
  if (!(await hasHostPermission(host))) {
    coursesEmpty(`尚未授权访问 ${host},请点击"保存并授权"。`, true);
    return;
  }
  apiBase = `https://${host}/api/v1`;
  coursesEmpty("加载课程…");

  try {
    const [coursesRaw, hiddenIds] = await Promise.all([
      fetchCourses(),
      getHiddenIds(),
    ]);

    const enriched = coursesRaw.map((c) => ({
      id: c.id,
      code: c.course_code || null,
      name: c.name || "?",
      term: (c.term && c.term.name) || "—",
      termEnd:
        c.term && c.term.end_at ? new Date(c.term.end_at).getTime() : null,
    }));

    // 按学期分组 —— 结束日期降序,无日期沉底;组内按名字
    const byTerm = new Map();
    for (const c of enriched) {
      if (!byTerm.has(c.term)) {
        byTerm.set(c.term, { name: c.term, end: c.termEnd, items: [] });
      }
      byTerm.get(c.term).items.push(c);
    }
    const groups = [...byTerm.values()].sort((a, b) => {
      if (a.end == null && b.end == null) return a.name.localeCompare(b.name);
      if (a.end == null) return 1;
      if (b.end == null) return -1;
      return b.end - a.end;
    });
    for (const g of groups) g.items.sort((a, b) => a.name.localeCompare(b.name));

    const hidden = new Set(hiddenIds);
    updateCoursesCounter(enriched.length, hidden.size);

    const list = document.getElementById("list");
    list.textContent = "";
    const statusEl = document.getElementById("courses-status");

    for (const g of groups) {
      const section = document.createElement("section");
      section.className = "term-group";

      const h = document.createElement("h2");
      h.className = "term-title";
      h.textContent = g.name;
      section.appendChild(h);

      for (const c of g.items) {
        const label = document.createElement("label");
        label.className = "course-row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !hidden.has(c.id);
        cb.addEventListener("change", async () => {
          const wasChecked = !hidden.has(c.id);
          if (cb.checked) hidden.delete(c.id);
          else hidden.add(c.id);
          try {
            await saveHiddenIds(hidden);
            updateCoursesCounter(enriched.length, hidden.size);
          } catch (e) {
            // 回滚 UI 和 Set
            if (wasChecked) hidden.delete(c.id);
            else hidden.add(c.id);
            cb.checked = wasChecked;
            statusEl.classList.add("error");
            statusEl.textContent = `保存失败:${e.message || e}`;
          }
        });

        const code = document.createElement("span");
        code.className = "code";
        code.textContent = c.code || "—";

        const name = document.createElement("span");
        name.className = "name";
        name.textContent = c.name;

        label.append(cb, code, name);
        section.appendChild(label);
      }
      list.appendChild(section);
    }
  } catch (e) {
    coursesEmpty(e.message || String(e), true);
  }
}

// -------- init --------

async function init() {
  await initHostSection();
  await loadCourses();
}

init();
