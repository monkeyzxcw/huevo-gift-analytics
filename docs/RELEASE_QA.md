# AMNYAM release and regression checklist

This checklist is the acceptance contract for changes that touch the dashboard, Worker API, D1 snapshot storage, or the local HuevoDualScan collector.

## Hard requirements

- Keep Huevo authentication manual in the two visible Chrome windows. Do not export session cookies, add server-side cookie login, or treat a copied cookie as proof of account access.
- Window A is the fast lane: page 1 / Live refresh approximately every 3 seconds. Do not reload the whole dashboard to refresh market data.
- Window B is the enrichment lane: traverse the complete catalogue, including paginated market results, on an approximately 5-minute cycle.
- Pause collection on CAPTCHA/challenge pages and on HTTP 418/429. Do not aggressively retry or attempt to bypass challenges.
- Keep alert delivery sound-only. Do not reintroduce browser Push, service-worker push subscriptions, or system Notification API prompts.
- Ingest endpoints must validate the Bearer token before parsing payloads or writing to D1. Keep request-size and content-encoding limits.
- Keep all market-derived text rendered as text, not executable HTML. Keep the restrictive Content Security Policy.

## Automated checks

Run these from the repository root:

```sh
npm ci
npm run check
npm run test:unit:worker
npm run test:e2e
```

The worker test suite includes API and D1-mock regression coverage. The browser suite covers dashboard behavior and signed launch/profile paths. Do not merge a change that breaks either job; fix the regression or document a deliberate contract change in the PR before updating tests.

## Browser acceptance pass

1. Open the dashboard and confirm the tab navigation and catalogue render without console errors.
2. Confirm Live data refreshes without a full-page reload and the UI does not issue overlapping fast polls.
3. Confirm the full catalogue enrichment remains a separate, slower update lane.
4. Configure a target price, enable sound explicitly, and verify the target alert. Reload and confirm the preference remains local.
5. Confirm no Push permission prompt or system notification is triggered.
6. Inspect the three “lots of the day” cards at desktop and narrow viewport widths: images must not cover the text or controls.
7. Check empty, stale, and error states. A failed poll must not silently replace a newer valid snapshot with empty data.
8. Test signed huEVO launch/profile behavior with a valid launch payload and invalid/tampered signature; never substitute a standalone app password.

## Deployment postflight

After a successful Cloudflare deployment, check the production Worker health endpoint and live-status endpoint, then open the dashboard in a normal browser. Verify that D1 schema readiness and ingest configuration are healthy, the latest poll/snapshot timestamp advances after the collector runs, and the lot count is non-zero when valid source data exists.

A successful GitHub Actions run is not proof that the production collector is currently connected: it only proves the tested code/deployment workflow completed. Report the deployment commit and the observed production health separately. If the production endpoint cannot be reached from the test environment, mark it **unverified** rather than claiming success.

## Collector operator pass

- Start both visible Chrome windows using the intended dedicated profiles.
- Sign into Huevo manually in each window as needed.
- Confirm window A is on market page 1 and its heartbeat/data timestamp advances.
- Confirm window B advances through multiple pages, returns to page 1 at the end, and publishes a complete snapshot.
- Confirm new listings appear without a manual dashboard reload.
- Confirm challenge responses pause the collector and are surfaced for the operator to handle manually.
