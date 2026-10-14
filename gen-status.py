#!/usr/bin/env python3
"""Render STATUS.md (the single source of truth) into status.html for the daily standup.
Usage: python3 gen-status.py   -> writes status.html next to STATUS.md. No dependencies."""
import html, pathlib, re, datetime

ROOT = pathlib.Path(__file__).parent
src = (ROOT / "STATUS.md").read_text()
e = html.escape

def section(name):
    m = re.search(r"^## " + re.escape(name) + r".*?$\n(.*?)(?=^## |\Z)", src, re.S | re.M)
    return m.group(1).strip() if m else ""

def table(md):
    rows = [r for r in md.splitlines() if r.startswith("|")]
    if len(rows) < 2: return [], []
    head = [c.strip() for c in rows[0].strip("|").split("|")]
    body = [[c.strip() for c in r.strip("|").split("|")] for r in rows[2:]]
    return head, body

def inline(s):
    s = e(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return s

STATE_RE = re.compile(r"^(todo|doing|blocked|done)\b(.*)$", re.I)
def chip(s):
    m = STATE_RE.match(s.strip())
    if not m: return inline(s)
    st, rest = m.group(1).lower(), m.group(2).strip()
    return f'<span class="chip {st}">{st}</span>' + (f' <span class="when">{inline(rest)}</span>' if rest else "")

def render_table(md, state_cols=("State",)):
    head, body = table(md)
    if not head: return "<p class=\"muted\">none</p>"
    out = ["<div class=\"table-wrap\"><table><thead><tr>"]
    out += [f"<th>{e(h)}</th>" for h in head]
    out.append("</tr></thead><tbody>")
    for row in body:
        out.append("<tr>")
        for h, c in zip(head, row + [""] * (len(head) - len(row))):
            out.append(f"<td>{chip(c) if h in state_cols else inline(c)}</td>")
        out.append("</tr>")
    out.append("</tbody></table></div>")
    return "".join(out)

def bullets(md):
    items = [l[2:].strip() for l in md.splitlines() if l.startswith("- ")]
    return "<ul>" + "".join(f"<li>{inline(i)}</li>" for i in items) + "</ul>"

updated = re.search(r"^Updated: (.+)$", src, re.M)
updated = updated.group(1) if updated else ""

# counts
_, tasks = table(section("Tasks"))
_, items = table(section("Integration items"))
def count(rows, col=3):
    c = {"todo":0,"doing":0,"blocked":0,"done":0}
    for r in rows:
        m = STATE_RE.match(r[col].strip()) if len(r) > col else None
        if m: c[m.group(1).lower()] += 1
    return c
tc, ic = count(tasks), count(items)
_, ms = table(section("Milestones"))
mdone = sum(1 for r in ms if len(r) > 3 and r[3].strip().lower().startswith("done"))
daily = [l[2:].strip() for l in section("Daily log").splitlines() if l.startswith("- ")]
latest = daily[-1] if daily else ""

page = f"""<title>Publish-to-AKS Status</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400&display=swap">
<style>
:root {{ --bg:#F6F8FB; --surface:#FFFFFF; --ink:#14213D; --muted:#5B6578; --line:#D8DEE8; --accent:#0E7C7B; --accent-ink:#0B5F5E; --amber:#B7791F; --amber-bg:#FFF3DB; --teal-bg:#E6F1F1; --done-bg:#E3F3E8; --done-ink:#1F6B3A; --todo-bg:#EDF0F5; --code-bg:#EEF2F7;
  --display:"Archivo","Segoe UI",Helvetica,Arial,sans-serif; --body:"Source Sans 3","Segoe UI",Helvetica,Arial,sans-serif; --mono:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#0F1521; --surface:#171E2C; --ink:#E6EAF2; --muted:#9AA5B8; --line:#2A3447; --accent:#3FB5B3; --accent-ink:#7FD3D1; --amber:#D9A441; --amber-bg:#3A2E12; --teal-bg:#123535; --done-bg:#15321F; --done-ink:#8FD3A4; --todo-bg:#222B3B; --code-bg:#0B1018; }} }}
:root[data-theme="dark"] {{ --bg:#0F1521; --surface:#171E2C; --ink:#E6EAF2; --muted:#9AA5B8; --line:#2A3447; --accent:#3FB5B3; --accent-ink:#7FD3D1; --amber:#D9A441; --amber-bg:#3A2E12; --teal-bg:#123535; --done-bg:#15321F; --done-ink:#8FD3A4; --todo-bg:#222B3B; --code-bg:#0B1018; }}
* {{ box-sizing:border-box }} body {{ margin:0; background:var(--bg); color:var(--ink); font-family:var(--body); font-size:16px; line-height:1.5 }}
.wrap {{ max-width:1180px; margin:0 auto; padding:36px 24px 72px }}
.eyebrow {{ font-family:var(--display); font-weight:600; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent-ink) }}
h1 {{ font-family:var(--display); font-weight:700; font-size:clamp(28px,4vw,40px); margin:6px 0 4px; letter-spacing:-.01em }}
.updated {{ color:var(--muted); margin:0 0 20px }}
.latest {{ background:var(--surface); border-left:4px solid var(--accent); padding:12px 16px; margin:0 0 28px; font-size:17px }}
.glance {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); margin:0 0 32px }}
.tile {{ background:var(--surface); padding:14px 16px; display:grid; gap:2px }} .tile .num {{ font-family:var(--display); font-weight:700; font-size:26px; line-height:1; font-variant-numeric:tabular-nums }} .tile .lab {{ font-size:13px; color:var(--muted) }}
h2 {{ font-family:var(--display); font-weight:600; font-size:22px; margin:36px 0 10px }}
.table-wrap {{ overflow-x:auto; border:1px solid var(--line) }} table {{ border-collapse:collapse; width:100%; min-width:760px; background:var(--surface); font-size:14.5px }}
th,td {{ text-align:left; vertical-align:top; padding:9px 11px; border-bottom:1px solid var(--line) }} th {{ font-family:var(--display); font-weight:600; font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); background:var(--bg) }} tr:last-child td {{ border-bottom:0 }}
td:first-child {{ font-family:var(--mono); font-size:13px; white-space:nowrap }}
code {{ font-family:var(--mono); font-size:12.5px; background:var(--code-bg); padding:1px 5px; border-radius:3px }}
.chip {{ display:inline-block; font-family:var(--display); font-weight:600; font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; padding:3px 8px; border-radius:3px; background:var(--todo-bg); color:var(--muted) }}
.chip.doing {{ background:var(--teal-bg); color:var(--accent-ink) }} .chip.done {{ background:var(--done-bg); color:var(--done-ink) }} .chip.blocked {{ background:var(--amber-bg); color:var(--amber) }}
.when {{ color:var(--muted); font-size:13px }} ul {{ margin:0; padding-left:20px }} li {{ margin:4px 0 }} .muted {{ color:var(--muted) }}
.foot {{ margin-top:40px; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:13.5px }}
</style>
<div class="wrap">
  <div class="eyebrow">Idea 2 · daily standup view</div>
  <h1>Publish-to-AKS Status</h1>
  <p class="updated">Generated {e(datetime.date.today().isoformat())} from <code>STATUS.md</code> · {inline(updated)}</p>
  <div class="latest">{inline(latest)}</div>
  <div class="glance">
    <div class="tile"><div class="num">{mdone}/{len(ms)}</div><div class="lab">milestones passed</div></div>
    <div class="tile"><div class="num">{tc['done']}/{len(tasks)}</div><div class="lab">tasks done</div></div>
    <div class="tile"><div class="num">{tc['doing']}</div><div class="lab">tasks in progress</div></div>
    <div class="tile"><div class="num">{tc['blocked'] + ic['blocked']}</div><div class="lab">blocked</div></div>
    <div class="tile"><div class="num">{ic['done']}/{len(items)}</div><div class="lab">integrations landed</div></div>
  </div>
  <h2>Milestones</h2>{render_table(section("Milestones"))}
  <h2>Integration items (people, not agents)</h2>{render_table(section("Integration items"))}
  <h2>Tasks</h2>{render_table(section("Tasks"))}
  <h2>Scope</h2>{render_table(section("Scope (frozen 2026-10-14)"), state_cols=())}
  <h2>Decisions</h2>{bullets(section("Decisions log (append-only)"))}
  <h2>Daily log</h2>{bullets(section("Daily log (append-only, one line per day)"))}
  <p class="foot">This page is generated. Edit <code>STATUS.md</code> in the repo, run <code>python3 gen-status.py</code>, republish. Design and reasoning: <code>DESIGN.md</code>.</p>
</div>
"""
(ROOT / "status.html").write_text(page)
print("status.html written:", len(page), "chars; tasks", tc, "items", ic)
