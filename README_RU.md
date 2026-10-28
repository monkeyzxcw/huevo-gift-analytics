# HUEVO TERMINAL — GitHub + Render

## Deploy
1. Upload all files in this folder to the root of your GitHub repository. Ensure `app.py`, `Dockerfile`, `requirements.txt`, `render.yaml` and `static/index.html` are at the root/expected locations.
2. Render will redeploy from the connected GitHub repository.
3. Environment variables: `AUTO_CRAWL=true`, `AUTO_CRAWL_MINUTES=60`, `CRAWL_DELAY=3.0`, `MAX_PAGES=500`.
4. Open the service URL. The server starts an automatic scan after startup and repeats at the configured interval. You can also click “Обновить данные”.

## Important limitations
- The crawler uses ordinary HTTP requests with standard browser headers and a conservative delay. It does not bypass CAPTCHA, authentication, anti-bot controls, or access restrictions. If Huevo returns HTTP 403/418/429, the run stops and the status shows the error. A server-side 418 must be resolved by confirming an allowed API/data source with Huevo; a better UI cannot make blocked data available.
- Render Free may sleep, and its ephemeral filesystem can lose the SQLite database on redeploy/restart. Therefore this free deployment cannot guarantee continuous 24/7 collection or durable history. Use a persistent database/disk and always-on host if you need those guarantees.
- Average prices are averages of observed asking prices, not confirmed sale prices.
- No automatic purchasing is performed; lot links open Huevo.
