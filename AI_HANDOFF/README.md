# AI handoff — AMNYAM / Huevo Gift Analytics

1. Read PROJECT_CONTEXT.md for current architecture and PR state.
2. Read KNOWN_ISSUES.md for verified fixes and remaining risks.
3. Read MASTER_PROMPT_RU.md for workflow/safety rules.
4. Read HUEVO_MARKET_RESEARCH.md for historical HTML observations, not a guaranteed API contract.
5. Always re-check GitHub main, latest PR and Actions before continuing.

Critical auth distinction: exported Huevo cookies are not used. Market collection requires manual login in two visible local Chrome profiles. AMNYAM profile uses a signed huEVO launch validated by Worker and a separate amnyam_session cookie. Never mix these mechanisms.

GitHub Actions tests and deploys. Cloudflare Worker cron only maintains D1. HuevoDualScan runs locally: Chrome #1 polls page 1; Chrome #2 scans the full catalogue and drains successive instance-enrichment batches.

PR #38: https://github.com/monkeyzxcw/huevo-gift-analytics/pull/38. Do not assume merged or deployed until latest checks and Cloudflare deploy are confirmed.

Never put credentials, raw request headers, session data or Chrome profile contents in Git, logs or public JSON.
