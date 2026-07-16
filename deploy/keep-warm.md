# Keep-warm setup (free)

The portal is a free Render **web service**, which sleeps after ~15 min idle and takes ~50s to wake.
Pinging it every ~10 min keeps it awake 24/7 so `/s/:nameSlug` (and the prem-ium-inc `/s/*` link)
render instantly. One always-on service fits Render's 750 free instance-hours/month — do **not** keep
multiple free services warm this way.

## Recommended: cron-job.org (no repo permissions needed)
1. Sign up (free) at https://cron-job.org
2. Create a cron job:
   - URL: `https://prem-ium-inc-client-portal.onrender.com/healthz`
   - Schedule: every 10 minutes
   - Expected response: HTTP 200, body `ok`
3. Save. That's it — the portal stays warm.

## Alternative: GitHub Actions
A scheduled workflow can do the same, but adding it requires a token with `workflow` scope (the current
PAT doesn't have it, which is why it isn't committed under `.github/workflows/`). If you grant that
scope, add this as `.github/workflows/keepwarm.yml`:

```yaml
name: keep-warm
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch: {}
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping /healthz
        run: curl -fsS --max-time 90 "${{ vars.PORTAL_URL || 'https://prem-ium-inc-client-portal.onrender.com' }}/healthz" || echo "waking"
```
