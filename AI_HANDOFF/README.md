# AI handoff — AMNYAM / Huevo Gift Analytics

1. Read PROJECT_CONTEXT.md for current architecture and merged QA work.
2. Read KNOWN_ISSUES.md for verified test evidence and owner-only live checks.
3. Read MASTER_PROMPT_RU.md for engineering and security rules.
4. Read HUEVO_MARKET_RESEARCH.md for historical Huevo HTML observations, not a guaranteed API contract.
5. Always re-check GitHub main, current PRs, latest Actions and Cloudflare deploy before changing code.

## Current state
- Main commit: 375336e1fe77cf3b3dbadd622a7e1b8def3ffb34.
- PR #38–#42 merged.
- Main E2E browser suite passed 36/36; snapshot suite passed 10 tests and validated the 474-lot snapshot.
- Cloudflare deploy succeeded; Worker version 9aec6a50-652f-4f5e-92b4-aeb181e6160f.
- HuevoDualScan v6 is a separate local Windows ZIP, py_compile -Werror and 10 offline tests passed.

## Authentication — critical
Exported Huevo cookies are not used. Market collection requires manual login in two visible local Chrome profiles. AMNYAM profile auth uses a server-verified signed huEVO launch and a separate `amnyam_session` cookie. Do not mix these mechanisms.

## Collection
Chrome #1 polls page 1; Chrome #2 scans the full catalogue, then drains multiple batches of up to 8 gift-instance records before the next 5-minute full scan. Eight is the batch size, not the entire interval. Progress is published to Cloudflare after each batch.

## Remaining live verification
Manual Huevo login/DOM in both Chrome windows, real D1 ingest, huEVO iframe Partitioned cookie and actual payment SDK are not proven by synthetic tests. Do not say otherwise.

Never store credentials, cookies, raw request headers, session data or Chrome profile contents in Git, logs or public JSON.
