import html, pathlib

PROJECT = pathlib.Path(__file__).parent

MERMAID_INIT = ("%%{init: {'theme':'base','themeVariables':{"
  "'fontFamily':'Source Sans 3, Segoe UI, Helvetica, Arial, sans-serif','fontSize':'14px',"
  "'primaryColor':'#E6F1F1','primaryTextColor':'#14213D','primaryBorderColor':'#0E7C7B',"
  "'lineColor':'#3F4A5E','secondaryColor':'#F5EBD6','tertiaryColor':'#F3F6FA',"
  "'actorBkg':'#E6F1F1','actorBorder':'#0E7C7B','actorTextColor':'#14213D','actorLineColor':'#B9C2D0',"
  "'signalColor':'#14213D','signalTextColor':'#14213D',"
  "'noteBkgColor':'#FFF3DB','noteTextColor':'#14213D','noteBorderColor':'#B7791F',"
  "'labelBoxBkgColor':'#F3F6FA','labelBoxBorderColor':'#3F4A5E','labelTextColor':'#14213D','loopTextColor':'#14213D',"
  "'altBackground':'#F3F6FA','clusterBkg':'#F3F6FA','clusterBorder':'#B9C2D0','edgeLabelBackground':'#FFFFFF',"
  "'titleColor':'#14213D'}}}%%")

FIGS = [
dict(id="actors", title="Who is involved",
claim="Seventeen actors, four of them people, in five layers. Everything inside the private cluster is invisible to the publisher; they talk only to Cowork.",
body="""Management version: an employee asks Cowork to publish. Cowork does the packaging and talks to one front door. Behind that door, the platform scans and decides. Static pages go straight to hosting. Python apps go through the same Azure DevOps pipeline and approval flow every other deployment in the organisation already uses. A colleague opens a link and signs in with their normal corporate account.""",
src="""flowchart TB
  subgraph people ["People"]
    PUB["Publisher<br/>an employee using Cowork"]
    APR["Approver<br/>member of the artifacts-approvers group"]
    VIEW["Viewer<br/>a colleague with the link"]
    PLAT["Platform team<br/>runs pipeline, policies, runtime image, skill"]
  end
  subgraph claude ["Claude side, operated by Anthropic"]
    COWORK["Cowork agent<br/>loads the publish-to-aks skill"]
    SANDBOX["Cowork sandbox<br/>runs upload.sh"]
    CONN["Connector service<br/>makes the MCP tool calls"]
  end
  subgraph edge ["Azure edge: the only public surface"]
    APPGW["Application Gateway WAF"]
    APIM["API Management<br/>MCP server, Entra validation, rate limits"]
    ENTRA["Entra ID"]
  end
  subgraph cicd ["Azure DevOps, your existing CI/CD"]
    ADO["Pipeline artifact-python-deploy<br/>gitleaks policy, Sonar advisory, Environment approval,<br/>kubectl apply via the AKS service connection"]
  end
  subgraph aks ["Private AKS cluster"]
    INTAKE["Intake API<br/>orchestrates every job"]
    SCAN["Scanner worker<br/>gitleaks, rule checks, import allowlist, verdict"]
    STATIC["Static gateway<br/>serves HTML artifacts"]
    DYN["Python runtime pods<br/>no network, no identity"]
    SHELL["Viewer shell<br/>Entra sign-in, audit log, iframe"]
  end
  BLOB[("Blob Storage<br/>intake, serving, job state<br/>Defender for Storage malware scan on upload")]

  PUB -->|"publish this internally"| COWORK
  COWORK -->|"tool call"| CONN
  COWORK -->|"runs script"| SANDBOX
  CONN -->|"HTTPS, Entra token"| APPGW
  SANDBOX -->|"HTTPS, one-time token"| APPGW
  APPGW --> APIM
  APIM -.->|"validates token"| ENTRA
  APIM --> INTAKE
  INTAKE -->|"queues scan"| SCAN
  INTAKE --> BLOB
  SCAN --> BLOB
  SCAN -->|"static: copy to serving"| STATIC
  SCAN -->|"python: trigger pipeline run"| ADO
  ADO -->|"after approval, applies manifests"| DYN
  APR -->|"approves in Azure DevOps"| ADO
  VIEW -->|"opens share link"| SHELL
  SHELL -.->|"sign-in"| ENTRA
  SHELL -->|"iframe"| STATIC
  SHELL -->|"iframe"| DYN
  PLAT -.->|"operates"| aks"""),

dict(id="publisher", title="What the publisher experiences",
claim="Four steps for a static artifact, five for a Python app. The publisher never leaves Cowork.",
body="""The employee's whole experience is a conversation. Cowork packages the work, uploads it, waits for the verdict, and either hands back a share link with an expiry date, names the people who need to approve, or fixes what the scanner flagged and tries again. Nobody opens a portal, a ticket, or a terminal.""",
src="""flowchart LR
  A["1. Ask Cowork<br/>publish this internally"] --> B["2. Cowork packages it<br/>manifest and preflight checks"]
  B --> C["3. Upload and scan<br/>about 30 seconds"]
  C -->|"static HTML"| D["4. Live<br/>share link and expiry date"]
  C -->|"Python app"| E["4. Waiting for approval<br/>Cowork names the approver group"]
  E -->|"approved"| D
  C -->|"findings"| F["Rejected<br/>Cowork fixes and resubmits, up to 3 times"]
  F --> C"""),

dict(id="publish", title="Behind the scenes: publish and scan",
claim="Two separate channels leave Claude's side: tool calls carry the user's Entra identity, the upload carries a one-time token. Neither carries a password.",
body="""The tool calls originate from Anthropic's connector service with the employee's Entra token, which APIM validates on every call. The upload comes from the Cowork sandbox, which has no identity of its own, so it presents a one-time token minted during the authenticated call. The artifact bytes never pass through the AI model. Malware scanning is done by Microsoft Defender for Storage the moment the upload lands in Blob; the rest of the checks run as a short-lived Kubernetes job per submission.""",
src="""sequenceDiagram
  autonumber
  actor Pub as Publisher
  participant CW as Cowork agent
  participant SB as Cowork sandbox
  participant AN as Anthropic connector service
  participant GW as App Gateway and APIM
  participant ID as Entra ID
  participant IN as Intake API
  participant SC as Scanner worker
  participant BL as Blob Storage

  Pub->>CW: publish this dashboard internally
  CW->>CW: load publish-to-aks skill, write manifest.json, run preflight.sh
  CW->>AN: tool beginPublish(manifest)
  AN->>GW: POST /v1/publish with Entra bearer token
  GW->>ID: validate token, audience, scope
  ID-->>GW: valid, user oid
  GW->>IN: forward with X-Publisher-Oid
  IN-->>CW: jobId, uploadUrl, one-time uploadToken
  Note over AN,GW: replies travel back through APIM and the connector service
  CW->>SB: run upload.sh dist/
  SB->>GW: PUT /v1/publish/{jobId}/upload, bearer uploadToken, zip body
  GW->>IN: stream body, 32 MiB cap
  IN->>BL: write intake/{jobId}.zip
  BL->>BL: Defender for Storage scans the upload on commit
  SB->>GW: POST /v1/publish/{jobId}/finalize with sha256
  GW->>IN: forward
  IN->>SC: queue message on Service Bus
  SC->>BL: read bundle
  SC->>SC: intake checks, gitleaks, HTML and JS rules, Python import allowlist
  SC->>BL: read Defender scan result tag, wait up to 60 s
  SC->>SC: policy.ts verdict
  SC->>BL: write findings and state
  loop every 10 s, up to 10 min
    CW->>AN: tool getPublishStatus(jobId)
    AN->>GW: GET /v1/publish/{jobId}
    GW->>IN: forward
    IN-->>CW: state, and findings or url
  end
  CW-->>Pub: share link and expiry, or findings to fix"""),

dict(id="deploy", title="Behind the scenes: going live",
claim="Static artifacts go live in seconds by copying files. Python artifacts ride your existing Azure DevOps pipeline: scan, human approval, then cluster admission policy, using the AKS service connection you already have.",
body="""The split is the heart of the design. A static artifact is data served from storage; nothing of it ever executes on the cluster, and nothing calls the Kubernetes API. A Python artifact executes on the cluster, so it goes through Azure DevOps like every other deployment: the pipeline fetches the bundle, runs gitleaks under your policy and Sonar as an advisory report, waits for a member of the approvers group to approve the Environment check, then applies the manifests with the AKS service connection. The cluster's own admission policy still refuses the pod unless its image, security settings and capabilities match what the platform team pinned.""",
src="""sequenceDiagram
  autonumber
  participant SC as Scanner worker
  participant BL as Blob Storage
  participant ST as Static gateway
  participant ADO as Azure DevOps pipeline
  actor APR as Approver
  participant K8 as Kubernetes API
  participant POL as Azure Policy and Pod Security
  participant POD as Python runtime pod
  participant IN as Intake API

  alt static HTML, seconds
    SC->>BL: copy bundle to serving/{id}/
    ST-->>ST: picks it up from the read-only mount
    SC->>IN: state = live, url = artifacts.corp.com/view/{id}
  else Python app, your normal deployment path
    SC->>ADO: trigger artifact-python-deploy with jobId, Entra token
    ADO->>BL: download bundle via the storage service connection
    ADO->>ADO: gitleaks under policy, Sonar scan attached as advisory report
    ADO->>IN: state = awaiting_approval, run link
    APR->>ADO: approve the Environment check, Entra group artifacts-approvers
    ADO->>K8: apply ConfigMap with app.py, Deployment, Service, HTTPRoute, TTL label, via the AKS service connection
    K8->>POL: admission review
    POL-->>K8: allowed only if image digest, security context and capabilities match policy
    K8->>POD: schedule on the untrusted node pool
    POD-->>ADO: rollout healthy on port 8080
    ADO->>IN: state = live
  end"""),

dict(id="viewer", title="What the viewer experiences",
claim="A colleague signs in once on the corporate domain. The artifact itself renders from a separate domain inside a sandboxed frame that the browser will not let navigate away.",
body="""The share link always points at the viewer shell on the corporate domain. The shell does the Entra sign-in, writes an audit entry, and embeds the artifact from the separate artifact domain. From that point the browser enforces the rules: no outbound requests, no forms posting anywhere, no popups, no leaving the frame, no downloads. A persistent banner above the frame reminds viewers never to type credentials into an artifact.""",
src="""sequenceDiagram
  autonumber
  actor V as Viewer, a colleague
  participant BR as Browser
  participant SH as Viewer shell on artifacts.corp.com
  participant ID as Entra ID
  participant AG as Artifact gateway on id.corp-artifacts.net

  V->>BR: opens artifacts.corp.com/view/{id}
  BR->>SH: GET /view/{id}
  SH->>ID: sign-in with MSAL
  ID-->>SH: viewer identity
  SH->>SH: audit log: viewer, artifact, time
  SH-->>BR: page with sandboxed iframe, frame-src pinned to corp-artifacts.net
  BR->>AG: GET /?t=short-lived token, inside the iframe
  AG->>AG: verify token, set __Host- cookie for this origin only
  AG-->>BR: artifact HTML with strict Content Security Policy
  Note over BR: blocked by the browser from here on: fetch to any host, forms posting anywhere, popups, navigating the frame away, downloads"""),

dict(id="states", title="The life of one publish job",
claim="Every job is in exactly one of nine states. The status tool reports the state and, when relevant, the findings or the approver group.",
body="""This is the view operations will live in. Three exits are terminal: rejected, failed, expired. For Python artifacts, awaiting_approval and deploying are reported by the Azure DevOps pipeline. Nothing lives forever; the TTL in the manifest (default 14 days, maximum 90) is enforced by a nightly garbage-collection pipeline.""",
src="""stateDiagram-v2
  [*] --> awaiting_upload : beginPublish
  awaiting_upload --> scanning : upload and finalize
  awaiting_upload --> expired : no upload within 10 min
  scanning --> rejected : any deny finding
  scanning --> deploying : static, verdict pass
  scanning --> awaiting_approval : python, verdict pass
  awaiting_approval --> deploying : approved in Azure DevOps
  awaiting_approval --> expired : approval check times out at 7 days
  deploying --> live : route healthy
  deploying --> failed : rollout error
  live --> expired : TTL reached, GC removes it
  rejected --> [*]
  failed --> [*]
  expired --> [*]"""),

dict(id="containment", title="If a bad artifact gets through the scanner",
claim="The scanner is a gate, not the wall. Each column lists what an attacker must defeat, outermost first, before anything of value is reachable.",
body="""This is the answer to the question management will ask: what happens when the scan misses something? For static artifacts, the browser's own security model does the containing. For Python artifacts, the cluster does: no network, no identity, no storage, a node pool shared with nothing else, and a human who said yes.""",
src="""flowchart TB
  subgraph s ["Static artifact: runs in the viewer's browser"]
    direction TB
    S1["Separate domain corp-artifacts.net<br/>no corporate cookies, no same-site access"] --> S2["One origin per artifact<br/>cannot touch another artifact's data"]
    S2 --> S3["Sandboxed iframe in the shell<br/>no popups, no top navigation, frame-src pinned"]
    S3 --> S4["Content Security Policy<br/>no fetch, XHR or WebSocket to any host"]
    S4 --> S5["Scanner rules<br/>no password fields, no external forms or scripts"]
  end
  subgraph d ["Python artifact: runs on the cluster"]
    direction TB
    D1["Human approval<br/>Azure DevOps Environment check, Entra approvers group"] --> D2["Dedicated tainted node pool<br/>nothing else is scheduled there"]
    D2 --> D3["NetworkPolicy deny-all egress<br/>no DNS, no internet, no IMDS, no cluster services"]
    D3 --> D4["No service-account token, no cloud identity<br/>app.py mounted read-only from a ConfigMap"]
    D4 --> D5["Restricted Pod Security and Azure Policy<br/>non-root, read-only root, no capabilities, pinned image"]
    D5 --> D6["Outside the mesh<br/>mesh workloads refuse plaintext callers"]
    D6 --> D7["Scanner rules<br/>import allowlist, no subprocess or sockets"]
  end"""),
]

ROLES = [
 ("Publisher", "Any employee with Cowork and the connector", "Asks Cowork to publish. Fixes findings when asked. Receives the link and expiry.", "Whenever they have something to share"),
 ("Approver", "Members of the Entra group artifacts-approvers", "Opens the Azure DevOps run, reads the scan summary and Sonar report, approves or rejects the Environment check.", "Per Python artifact, within 7 days"),
 ("Viewer", "Anyone in the tenant who gets the link", "Opens the shell link, signs in, views the artifact.", "Any time until the TTL"),
 ("Platform team", "Owners of the pipeline repo", "Maintains the skill, the connector, the scanner image, the curated Python runtime, Azure Policy, the two Azure DevOps pipelines and the Environment check. Reviews pull requests to policy files.", "Runtime image on request; policy by PR"),
 ("Claude org Owner", "Claude Team or Enterprise owner", "Adds the custom connector once. Publishes the skill to the skills repo.", "Once, then on changes"),
 ("Azure identity admin", "Entra administrator", "Owns the two app registrations and the approvers group membership.", "Setup, then membership changes"),
]

GLANCE = [
 ("4", "human roles in the loop"),
 ("1", "public hostname, the APIM front door"),
 ("30 s", "about, from upload to live for a static artifact"),
 ("1", "human approval per Python app"),
 ("0", "container images built per artifact"),
 ("1", "open-source binary in the scanner, gitleaks"),
 ("14 d", "default TTL, 90 d maximum"),
]

# ---------- DIAGRAMS.md ----------
md = ["# Publish-to-AKS walkthrough: diagrams", "",
      "Mermaid source for every figure. Paste a block into mermaid.live, Confluence, Azure DevOps wiki, or any Mermaid-capable renderer. Generated 2026-10-14 from the same source as the published walkthrough page.", ""]
for i, f in enumerate(FIGS, 1):
    md += [f"## Figure {i}. {f['title']}", "", f"*{f['claim']}*", "", f['body'], "", "```mermaid", f['src'], "```", ""]
md += ["## Who does what", "", "| Role | Who | Does | How often |", "|---|---|---|---|"]
for r in ROLES: md.append("| " + " | ".join(r) + " |")
(PROJECT / "DIAGRAMS.md").write_text("\n".join(md) + "\n")

# ---------- walkthrough.html ----------
e = html.escape
fig_html = []
for i, f in enumerate(FIGS, 1):
    fig_html.append(f"""
<section class="fig" id="{f['id']}">
  <header class="fig-head">
    <span class="eyebrow">Figure {i}</span>
    <h2>{e(f['title'])}</h2>
    <p class="claim">{e(f['claim'])}</p>
  </header>
  <p class="body">{e(f['body'])}</p>
  <figure>
    <div class="sheet"><pre class="mermaid">{e(MERMAID_INIT)}
{e(f['src'])}</pre></div>
    <figcaption>Figure {i}. {e(f['claim'])}</figcaption>
  </figure>
  <details class="src">
    <summary>Mermaid source <span class="hint">copy and paste into any Mermaid renderer</span></summary>
    <div class="src-wrap">
      <button class="copy" type="button" data-copy="src-{f['id']}">Copy</button>
      <pre id="src-{f['id']}"><code>{e(f['src'])}</code></pre>
    </div>
  </details>
</section>""")

nav = "\n".join(f'<li><a href="#{f["id"]}"><span class="n">{i}</span>{e(f["title"])}</a></li>' for i, f in enumerate(FIGS, 1))
glance = "\n".join(f'<div class="tile"><div class="num">{e(n)}</div><div class="lab">{e(l)}</div></div>' for n, l in GLANCE)
roles = "\n".join("<tr>" + "".join(f"<td>{e(c)}</td>" for c in r) + "</tr>" for r in ROLES)

page = f"""<title>Publish-to-AKS Walkthrough</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400&display=swap">
<style>
:root {{
  --bg:#F6F8FB; --surface:#FFFFFF; --ink:#14213D; --muted:#5B6578; --line:#D8DEE8;
  --accent:#0E7C7B; --accent-ink:#0B5F5E; --amber:#B7791F; --paper:#FBFCFE; --paper-line:#D8DEE8;
  --code-bg:#EEF2F7; --code-ink:#1F2A44;
  --display:"Archivo","Segoe UI",Helvetica,Arial,sans-serif;
  --body:"Source Sans 3","Segoe UI",Helvetica,Arial,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg:#0F1521; --surface:#171E2C; --ink:#E6EAF2; --muted:#9AA5B8; --line:#2A3447;
    --accent:#3FB5B3; --accent-ink:#7FD3D1; --amber:#D9A441; --paper:#FBFCFE; --paper-line:#2A3447;
    --code-bg:#0B1018; --code-ink:#D5DBE6;
  }}
}}
:root[data-theme="dark"] {{
  --bg:#0F1521; --surface:#171E2C; --ink:#E6EAF2; --muted:#9AA5B8; --line:#2A3447;
  --accent:#3FB5B3; --accent-ink:#7FD3D1; --amber:#D9A441; --paper:#FBFCFE; --paper-line:#2A3447;
  --code-bg:#0B1018; --code-ink:#D5DBE6;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font-family:var(--body); font-size:17px; line-height:1.55; }}
a {{ color:var(--accent-ink); }}
a:focus-visible, button:focus-visible, summary:focus-visible {{ outline:2px solid var(--accent); outline-offset:2px; }}
.wrap {{ max-width:1120px; margin:0 auto; padding:40px 24px 80px; }}
.masthead {{ display:grid; gap:12px; max-width:72ch; margin-bottom:36px; }}
.eyebrow {{ font-family:var(--display); font-weight:600; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent-ink); }}
h1 {{ font-family:var(--display); font-weight:700; font-size:clamp(32px,4.5vw,46px); line-height:1.08; margin:0; text-wrap:balance; letter-spacing:-.01em; }}
.lede {{ font-size:19px; color:var(--muted); margin:0; max-width:62ch; }}
.glance {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); margin:0 0 40px; }}
.tile {{ background:var(--surface); padding:16px 16px 14px; display:grid; gap:4px; }}
.tile .num {{ font-family:var(--display); font-weight:700; font-size:28px; line-height:1; font-variant-numeric:tabular-nums; color:var(--ink); }}
.tile .lab {{ font-size:14px; color:var(--muted); line-height:1.3; }}
nav.toc {{ margin:0 0 48px; }}
nav.toc ol {{ list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:8px 24px; }}
nav.toc a {{ display:flex; gap:12px; align-items:baseline; text-decoration:none; color:var(--ink); padding:6px 0; border-bottom:1px solid var(--line); }}
nav.toc a:hover {{ color:var(--accent-ink); }}
nav.toc .n {{ font-family:var(--display); font-weight:600; font-size:13px; color:var(--accent-ink); min-width:1.4em; font-variant-numeric:tabular-nums; }}
.fig {{ display:grid; gap:16px; padding:40px 0; border-top:1px solid var(--line); }}
.fig-head {{ display:grid; gap:6px; max-width:72ch; }}
.fig h2 {{ font-family:var(--display); font-weight:600; font-size:28px; line-height:1.15; margin:0; text-wrap:balance; }}
.claim {{ margin:0; font-size:18px; font-weight:600; color:var(--ink); }}
.body {{ margin:0; max-width:72ch; color:var(--muted); }}
figure {{ margin:0; display:grid; gap:10px; }}
.sheet {{ background:var(--paper); border:1px solid var(--paper-line); padding:20px 16px; overflow-x:auto; }}
.sheet .mermaid {{ margin:0; font-family:var(--body); color:#14213D; min-height:80px; }}
.sheet svg {{ max-width:100%; height:auto; }}
figcaption {{ font-size:14px; color:var(--muted); }}
details.src {{ border:1px solid var(--line); background:var(--surface); }}
details.src summary {{ cursor:pointer; padding:10px 14px; font-family:var(--display); font-weight:600; font-size:14px; display:flex; gap:12px; align-items:baseline; }}
details.src summary .hint {{ font-family:var(--body); font-weight:400; color:var(--muted); }}
.src-wrap {{ position:relative; border-top:1px solid var(--line); }}
.src-wrap pre {{ margin:0; padding:16px 14px; background:var(--code-bg); color:var(--code-ink); font-family:var(--mono); font-size:13px; line-height:1.5; overflow-x:auto; }}
button.copy {{ position:absolute; top:8px; right:8px; font-family:var(--display); font-weight:600; font-size:12px; letter-spacing:.06em; text-transform:uppercase; padding:6px 10px; border:1px solid var(--line); background:var(--surface); color:var(--ink); cursor:pointer; }}
button.copy:hover {{ border-color:var(--accent); color:var(--accent-ink); }}
.roles {{ padding:40px 0 0; border-top:1px solid var(--line); display:grid; gap:16px; }}
.roles h2 {{ font-family:var(--display); font-weight:600; font-size:28px; margin:0; }}
.table-wrap {{ overflow-x:auto; border:1px solid var(--line); }}
table {{ border-collapse:collapse; width:100%; min-width:720px; background:var(--surface); font-size:15px; }}
th, td {{ text-align:left; vertical-align:top; padding:10px 12px; border-bottom:1px solid var(--line); }}
th {{ font-family:var(--display); font-weight:600; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); background:var(--bg); }}
tr:last-child td {{ border-bottom:0; }}
td:first-child {{ font-weight:600; white-space:nowrap; }}
.foot {{ margin-top:48px; padding-top:20px; border-top:1px solid var(--line); font-size:14px; color:var(--muted); max-width:72ch; }}
@media (prefers-reduced-motion: no-preference) {{ details.src summary {{ transition:color .15s; }} }}
</style>

<div class="wrap">
  <header class="masthead">
    <span class="eyebrow">Idea 2 · operations walkthrough · 2026-10-14</span>
    <h1>Publish-to-AKS Walkthrough</h1>
    <p class="lede">How an employee publishes a Cowork artifact to the internal cluster, who is involved, and what happens behind the scenes. Every diagram is Mermaid. Open the source under each one to copy it.</p>
  </header>

  <div class="glance" aria-label="At a glance">
{glance}
  </div>

  <nav class="toc" aria-label="Figures">
    <ol>
{nav}
      <li><a href="#roles"><span class="n">+</span>Who does what</a></li>
    </ol>
  </nav>

{''.join(fig_html)}

  <section class="roles" id="roles">
    <h2>Who does what</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Role</th><th>Who</th><th>Does</th><th>How often</th></tr></thead>
        <tbody>
{roles}
        </tbody>
      </table>
    </div>
  </section>

  <p class="foot">Source for every diagram is in <code>DIAGRAMS.md</code> next to <code>DESIGN.md</code> in the project folder. The design document holds the reasoning behind each decision shown here.</p>
</div>

<script>
document.querySelectorAll('button.copy').forEach(function (b) {{
  b.addEventListener('click', function () {{
    var pre = document.getElementById(b.getAttribute('data-copy'));
    var text = pre ? pre.textContent : '';
    var done = function () {{ b.textContent = 'Copied'; setTimeout(function () {{ b.textContent = 'Copy'; }}, 1600); }};
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      navigator.clipboard.writeText(text).then(done, function () {{ fallback(); }});
    }} else {{ fallback(); }}
    function fallback() {{
      var r = document.createRange(); r.selectNodeContents(pre);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      try {{ document.execCommand('copy'); done(); }} catch (err) {{ b.textContent = 'Select and copy'; }}
    }}
  }});
}});
</script>
"""
# Artifact body: no doctype/head/Mermaid script, the artifact host adds those and renders Mermaid natively.
(PROJECT / "walkthrough.artifact.html").write_text(page)

# Standalone: opens from disk or any web server, loads a pinned Mermaid from cdnjs.
standalone = (
    '<!doctype html>\n<html lang="en">\n<head>\n'
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.12.0/mermaid.min.js"></script>\n'
    '</head>\n<body>\n' + page +
    '\n<script>mermaid.initialize({startOnLoad:false}); mermaid.run({querySelector:"pre.mermaid"});</script>\n'
    '</body>\n</html>\n')
(PROJECT / "walkthrough.html").write_text(standalone)

print("DIAGRAMS.md:", len(md), "lines;",
      "walkthrough.artifact.html:", len(page), "chars;",
      "walkthrough.html:", len(standalone), "chars")
