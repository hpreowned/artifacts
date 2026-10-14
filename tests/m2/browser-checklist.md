# Browser checklist: `static-fetch`, `static-navigate`, and the three 403 checks

Manual. Run once the static tier is live (`docs/M2-RUNBOOK.md` steps 1–26 done) and you have an Entra
account assigned to sign in to the viewer shell. Needs a real browser with DevTools — this is exactly
what `tests/m2/smoke.sh` and `tests/m2/cluster-negative.sh` cannot do (no sign-in flow, no renderer).

Prerequisite: publish `tests/corpus/static-fetch` and `tests/corpus/static-navigate` against the cluster
(`artifactctl publish --wait tests/corpus/static-fetch`, same for `static-navigate` — both reach `live`
per their `expected.json`; this is not a rejection test). Keep each artifact's shell URL
(`https://artifacts.corp.com/view/<artifactId>`) handy.

## 1. `static-fetch` — CSP blocks the exfiltration attempt

1. Open the `static-fetch` artifact's shell URL in a fresh tab.
2. Sign in with Entra if prompted.
3. Open DevTools → Console, before the page finishes loading if possible (the `fetch` call runs on
   load — `tests/corpus/static-fetch/index.html`'s script body).
4. **Check:** the console shows a CSP violation naming `connect-src`, in the shape:
   ```
   Refused to connect to 'https://attacker.example/...' because it violates the following Content Security Policy directive: "connect-src 'none'".
   ```
   (Chrome/Edge wording; Firefox reads "Content Security Policy: The page's settings blocked the loading
   of a resource at https://attacker.example/... (\"connect-src\")" — same meaning, different phrasing.)
   This message appears on **the artifact's own console** (the iframe's realm), because `connect-src` is
   enforced by the document that made the fetch call — the artifact page itself, not the shell.
5. **Check:** the chart still renders (the artifact is `live`, not `rejected` — `HTML-009` is `info`, not
   `deny`; containment, not detection, is the point per `DESIGN.md` §8).
6. **Check:** DevTools → Network shows no request to `attacker.example` actually left the browser (the
   request is blocked before it is sent, so it never appears as a failed/CORS entry — it does not appear
   at all).

## 2. `static-navigate` — the shell's `frame-src` blocks the navigation

1. Open the `static-navigate` artifact's shell URL. Sign in if prompted.
2. Open DevTools → Console. `DESIGN.md` §8 says this console shows "the shell's `frame-src` violation" but
   — like everything else in that section — it is a documented expectation, never actually observed
   (`DESIGN.md` §11: "Everything in §6 runs: **Not run.**"). Check the **top-level (shell) frame's**
   console first, using the context selector at the top of the Console panel; if nothing shows there,
   check the iframe's own console before concluding the block did not happen — browsers differ on which
   context attributes a CSP violation triggered by a child frame's self-navigation.
3. Wait ~1 second (`tests/corpus/static-navigate/index.html` fires `location.href = ...` after a 500 ms
   `setTimeout`).
4. **Check:** one of the two consoles from step 2 shows a CSP violation naming `frame-src`, pinned to the
   shell's own policy (`viewer-shell/README.md`):
   ```
   Refused to frame 'https://example.com/' because it violates the following Content Security Policy directive: "frame-src https://*.corp-artifacts.net".
   ```
   If neither console shows this and the frame still does not navigate (step 5 below), the block worked
   even if the message is harder to find than DESIGN.md assumed — note the actual console/location in
   your evidence for `STATUS.md` so the next person does not have to rediscover it.
5. **Check:** the frame does **not** navigate — the chart stays visible, the URL bar still shows the
   shell's own `artifacts.corp.com/view/<id>` address, not `example.com`.
6. **Check:** no new tab or window opened (the sandbox has no `allow-popups` and no
   `allow-top-navigation`, so even if `frame-src` somehow let this through, the navigation has nowhere
   to go but the frame itself).

## 3. Three 403 checks

Use the `static-ok` artifact (or any `live` bundle) for all three. The exact 403 page is
`static-gateway/README.md`'s rule 4 (no session) or rule 1 (bad host); confirm the `Content-Security-Policy`
header is present on the 403 response too — `static-gateway` applies the full header set before deciding
the status code.

1. **No cookie.** In a private/incognito window (no shell session), open the raw artifact origin directly:
   `https://<artifactId>.corp-artifacts.net/`. **Check:** this is a top-level load, so `Sec-Fetch-Dest:
   document` triggers a **302 to the shell**, not a bare 403 (`static-gateway/README.md` rule 2) — sign
   in there instead; the 403 itself is only reachable by a non-navigational request (step 2/3 below, or a
   `curl` without `Sec-Fetch-Dest: document`).
2. **Wrong artifact.** Sign in to the shell normally for artifact A, capture its session cookie is scoped
   by `__Host-` + `Path=/` to artifact A's own subdomain — cookies for `a.corp-artifacts.net` are never
   sent to `b.corp-artifacts.net` by the browser itself, so this check is really: open artifact B's shell
   URL in the **same signed-in session**, confirm you get artifact B's own fresh token/cookie flow (a new
   `?t=` round-trip), not an error — then, with DevTools Network open, confirm the request to
   `b.corp-artifacts.net` never carries artifact A's cookie. There is no cross-artifact cookie leak to
   demonstrate a 403 for; the 403 that matters here is reusing an **expired or forged** view token
   (`?t=` with a tampered payload) against the gateway directly — expect `403` with the "Open through the
   viewer" page from `static-gateway/README.md`'s rule 4.
3. **Direct top-level load redirects to the shell.** Same as check 1: open
   `https://<artifactId>.corp-artifacts.net/` as a **top-level navigation** (type it in the address bar,
   or click a plain link to it) with DevTools Network recording. **Check:** the first response is `302`
   to `https://artifacts.corp.com/view/<artifactId>`, and the browser's address bar ends up on that shell
   URL, never on the raw `corp-artifacts.net` origin as the final rendered page.

## Partitioned cookies — which browsers honour them

The gateway's session cookie is `SameSite=None; Partitioned` (CHIPS), not `Secure` alone
(`static-gateway/README.md` "Cookie"). This matters because the artifact origin
(`*.corp-artifacts.net`) is a third party from the shell's (`artifacts.corp.com`) point of view, and
browsers are actively restricting third-party cookies:

| Browser | `Partitioned` (CHIPS) support | What to expect here |
|---|---|---|
| Chrome / Edge (current stable) | Yes | Cookie is partitioned to the shell as top-level site; works even with third-party cookies blocked globally |
| Safari | Yes (Safari 18+) | Same as Chrome; older Safari versions that lack CHIPS will simply not persist the cookie across the iframe boundary if third-party cookies are off — test on a current version |
| Firefox | Partial / behind a setting in some versions (verify against the version in use; not pinned in this repo) | If the cookie does not stick, this is the first thing to check — not a gateway bug |

**Check:** in whichever browser you use for this checklist, confirm the artifact actually renders inside
the iframe (not just that the top-level checks above pass) — that is the real test of `Partitioned`
working. If it does not render in Firefox specifically, check that browser's version and
`network.cookie.cookieBehavior`/CHIPS flag before filing it as a repo bug.
