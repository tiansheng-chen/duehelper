#!/usr/bin/env python3
"""
Canvas API 探针

四类状态:
  1. 未来 deadline      —— 有截止时间，未提交
  2. 待定               —— 已发布，无截止时间，未提交
  3. 等待评分            —— 已提交，未出分
  4. 已完成              —— 已评分，带得分

用法:
    python probe.py             # 正常输出
    python probe.py --courses   # 列出所有课程和 id，用来挑要排除哪些
"""

import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

load_dotenv()

BASE = "https://canvas.sydney.edu.au/api/v1"
LOCAL_TZ = ZoneInfo("Australia/Sydney")
DAYS_AHEAD = 21

ACTIONABLE_TYPES = {"assignment", "quiz", "discussion_topic", "planner_note"}

# ↓ 勾选框的状态。不填 = 全部显示；填了 id = 那门课不显示。
# 跑 `python probe.py --courses` 看所有课程和 id。
EXCLUDED_COURSE_IDS = {
    70874,   # Faculty of Engineering Orientation
    70610,   # Respect@Sydney 2026
    29374,   # Anti-Slavery Awareness
    15961,   # Computer Science Student Portal
    2806,    # Faculty of Engineering Student Portal
    68495,   # PG Connect
}

EPOCH = datetime.min.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------- HTTP

def get_token():
    token = os.environ.get("CANVAS_TOKEN")
    if not token:
        sys.exit("缺少 CANVAS_TOKEN 环境变量")
    return token


def next_link(link_header):
    if not link_header:
        return None
    for part in link_header.split(","):
        m = re.match(r'\s*<([^>]+)>\s*;\s*rel="next"', part)
        if m:
            return m.group(1)
    return None


def paginated_get(url, token, params=None, quiet=False):
    headers = {"Authorization": f"Bearer {token}"}
    results, page = [], 0

    while url:
        page += 1
        resp = requests.get(url, headers=headers, params=params, timeout=15)
        if resp.status_code == 401:
            sys.exit("401 — token 无效或已过期")
        if resp.status_code in (403, 404):
            return results          # 个别课程会关掉端点，跳过而不是整体崩掉
        resp.raise_for_status()

        batch = resp.json()
        results.extend(batch)
        if not quiet:
            print(f"  第 {page} 页: {len(batch)} 条", file=sys.stderr)

        url = next_link(resp.headers.get("Link"))
        params = None

    return results


def to_local(iso_str):
    if not iso_str:
        return None
    return datetime.fromisoformat(iso_str.replace("Z", "+00:00")).astimezone(LOCAL_TZ)


# ---------------------------------------------------------------- 取数

def fetch_courses(token):
    raw = paginated_get(
        f"{BASE}/courses",
        token,
        {
            "enrollment_state": "active",
            "include[]": ["term", "total_scores"],
            "per_page": 100,
        },
    )

    now = datetime.now(LOCAL_TZ)
    courses = []
    for c in raw:
        term = c.get("term") or {}
        end = to_local(term.get("end_at"))
        enrollment = (c.get("enrollments") or [{}])[0]

        courses.append({
            "id": c["id"],
            "name": c.get("name", "?"),
            "term": term.get("name", "—"),
            "term_dated": bool(term.get("end_at")),
            "expired": bool(end and end < now),
            "score": enrollment.get("computed_current_score"),
            "grade": enrollment.get("computed_current_grade"),
        })
    return courses


def fetch_course_assignments(course_id, token):
    """一次请求拿到作业 + 我的提交状态 + 得分。"""
    return paginated_get(
        f"{BASE}/courses/{course_id}/assignments",
        token,
        {"include[]": "submission", "per_page": 100},
        quiet=True,
    )


# ---------------------------------------------------------------- 分类

def classify(assignment, course_id):
    """返回 (类别, 数据)。类别为 None 表示这条不进任何区块。"""
    sub = assignment.get("submission") or {}
    state = sub.get("workflow_state")

    base = {
        "title": assignment.get("name") or "(无标题)",
        "course_id": course_id,
        "url": assignment.get("html_url"),
        "points_possible": assignment.get("points_possible"),
    }

    # 免修的不算在任何一类
    if sub.get("excused"):
        return None, None

    # 1. 已评分
    if state == "graded" and sub.get("score") is not None:
        return "graded", {
            **base,
            "score": sub["score"],
            "grade": sub.get("grade"),
            "graded_at": to_local(sub.get("graded_at")),
        }

    # 2. 已提交，等待评分
    if sub.get("submitted_at"):
        return "pending", {
            **base,
            "submitted_at": to_local(sub["submitted_at"]),
            "needs_review": state == "pending_review",
            "late": bool(sub.get("late")),
        }

    # 3. 已发布、无截止、未提交
    if not assignment.get("due_at"):
        return "undated", {
            **base,
            "created_at": to_local(assignment.get("created_at")),
        }

    # 有 due 且未提交 → 由 planner 那条线负责，这里不重复
    return None, None


def normalize_planner(item):
    plannable = item.get("plannable") or {}
    return {
        "title": plannable.get("title") or "(无标题)",
        "course_id": item.get("course_id"),
        "type": item.get("plannable_type"),
        "due": to_local(
            plannable.get("due_at")
            or plannable.get("todo_date")
            or item.get("plannable_date")
        ),
        "submitted": bool(item.get("submissions"))
        and (item.get("submissions") or {}).get("submitted", False),
    }


# ---------------------------------------------------------------- 输出

def print_course_list(courses):
    print(f"\n{'':<4} {'ID':<8} {'学期':<22} 课程")
    print("-" * 92)
    for c in sorted(courses, key=lambda x: (not x["term_dated"], x["name"])):
        mark = "[ ]" if c["id"] in EXCLUDED_COURSE_IDS else "[x]"
        print(f"{mark:<4} {c['id']:<8} {c['term'][:20]:<22} {c['name'][:45]}")
    print("\n[x] = 会显示   [ ] = 已排除")
    print("改动请编辑脚本顶部的 EXCLUDED_COURSE_IDS\n")


def section(title, count):
    print(f"\n{'='*64}")
    print(f"{title}（{count} 条）")
    print("=" * 64)


def short(names, cid, width=16):
    return f"{names.get(cid, '—')[:width]:{width}}"


# ---------------------------------------------------------------- 主流程

def main():
    token = get_token()

    print("拉取课程列表...", file=sys.stderr)
    courses = fetch_courses(token)

    if "--courses" in sys.argv:
        print_course_list(courses)
        return

    # 唯一的过滤依据是勾选状态。没勾 = 全显示，不做任何自动判断。
    active = [c for c in courses if c["id"] not in EXCLUDED_COURSE_IDS]
    names = {c["id"]: c["name"] for c in active}
    print(f"  {len(active)}/{len(courses)} 门课纳入统计", file=sys.stderr)

    now_utc = datetime.now(timezone.utc)
    print("拉取 planner items...", file=sys.stderr)
    planner_raw = paginated_get(
        f"{BASE}/planner/items",
        token,
        {
            "start_date": now_utc.isoformat(),
            "end_date": (now_utc + timedelta(days=DAYS_AHEAD)).isoformat(),
            "per_page": 50,
        },
    )

    print(f"并行拉取 {len(active)} 门课的作业与成绩...", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(
            lambda c: (c["id"], fetch_course_assignments(c["id"], token)), active
        ))

    graded, pending, undated = [], [], []
    for course_id, assignments in results:
        for a in assignments:
            kind, item = classify(a, course_id)
            if kind == "graded":
                graded.append(item)
            elif kind == "pending":
                pending.append(item)
            elif kind == "undated":
                undated.append(item)

    dated = [
        it for it in (normalize_planner(i) for i in planner_raw)
        if it["due"]
        and not it["submitted"]
        and it["type"] in ACTIONABLE_TYPES
        and it["course_id"] in names
    ]
    dated.sort(key=lambda x: x["due"])

    # ---- 1. 未来 deadline ----
    section(f"未来 {DAYS_AHEAD} 天", len(dated))
    by_day = defaultdict(list)
    for it in dated:
        by_day[it["due"].date()].append(it)
    for day in sorted(by_day):
        print(f"\n{day:%a %d %b}")
        for it in by_day[day]:
            print(f"  {it['due']:%H:%M}  [{short(names, it['course_id'])}]  {it['title']}")
    if not dated:
        print("  （无）")

    # ---- 2. 待定 ----
    section("待定 — 已发布，未设截止", len(undated))
    for it in sorted(undated, key=lambda x: x["created_at"] or EPOCH, reverse=True):
        print(f"  [{short(names, it['course_id'])}]  {it['title']}")
    if not undated:
        print("  （无）")

    # ---- 3. 等待评分 ----
    section("等待评分 — 已提交，未出分", len(pending))
    today = datetime.now(LOCAL_TZ)
    for it in sorted(pending, key=lambda x: x["submitted_at"] or EPOCH, reverse=True):
        days = (today - it["submitted_at"]).days if it["submitted_at"] else "?"
        flags = ""
        if it["needs_review"]:
            flags += "  [需人工批改]"
        if it["late"]:
            flags += "  [迟交]"
        stamp = f"{it['submitted_at']:%d %b}" if it["submitted_at"] else "—"
        print(f"  {stamp} ({days}天前)  [{short(names, it['course_id'])}]  {it['title'][:34]}{flags}")
    if not pending:
        print("  （无）")

    # ---- 4. 已完成 ----
    section("已完成", len(graded))
    by_course = defaultdict(list)
    for it in graded:
        by_course[it["course_id"]].append(it)

    for c in active:
        items = by_course.get(c["id"])
        if not items:
            continue
        header = c["name"][:42]
        if c["score"] is not None:
            header += f"   —   当前总分 {c['score']}%"
            if c["grade"]:
                header += f" ({c['grade']})"
        print(f"\n{header}")
        for it in sorted(items, key=lambda x: x["graded_at"] or EPOCH):
            poss = it["points_possible"]
            score_str = f"{it['score']:g}/{poss:g}" if poss else f"{it['score']:g}"
            pct = f"  {it['score']/poss*100:5.1f}%" if poss else "         "
            print(f"  {score_str:>12}{pct}   {it['title'][:42]}")
    if not graded:
        print("  （无）")
    print()


if __name__ == "__main__":
    main()