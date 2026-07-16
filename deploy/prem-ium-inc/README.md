# prem-ium-inc changes (apply after the portal deploys)

These two files belong to the **separate `prem-ium-inc` repo** (the static marketing site auto-deployed
to Render). They are staged here so the live site isn't touched until you're ready. Apply them *after*
this portal PR is deployed, so `/api/portfolio` and `/s/:nameSlug` exist.

## 1. `portfolio-cards.html` → into `portfolio.html`
Replace the hardcoded card grid in the prem-ium-inc `portfolio.html` with this drop-in. It fetches the
portal's `/api/portfolio` on load, so the gallery auto-updates as Joseph's org gains repos (no manual
edits ever again). Each card links to the brand permanent link `/s/<business>`.

## 2. `render.yaml` → replaces the prem-ium-inc `render.yaml`
Adds a route so `prem-ium-inc.onrender.com/s/<business>` reaches the portal, which renders the site
live from its GitHub repo.

### Important: redirect vs proxy (Render static-site reality)
Render **static** sites cannot transparently reverse-proxy to another service. So the route is a
`redirect` (302): the emailed/shared link is on the brand domain, and after the click the browser lands
on the portal host and renders the live site. For a one-click link that's fine.

If you ever want the address bar to stay on `prem-ium-inc.onrender.com` the whole time, two options:
- Confirm whether your Render plan supports rewrite-to-external (some tiers/newer configs do); if so,
  change `type: redirect` → `type: rewrite` in `render.yaml` — everything else stays the same.
- Or move the marketing pages onto the portal web service (Option A) — true brand URLs, but the
  homepage then pays the free-tier cold-start.

`PUBLIC_SITE_BASE` in the portal env controls the base used in portfolio links and outreach emails:
- keep `https://prem-ium-inc.onrender.com` to use the brand link (with the redirect above), or
- set it to the portal host for the plain Option-B link with no redirect hop.
