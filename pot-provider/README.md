# CreatorFlow-AI PO-token provider

Vercel Functions cannot run the BgUtils PO-token server as a sidecar, so this directory
contains an always-on Docker deployment. The Python downloader calls it through
YOUTUBE_POT_PROVIDER_URL.

## Deploy
cd pot-provider
fly launch --no-deploy --copy-config --name <unique-name>
PW=$(openssl rand -hex 24)
fly secrets set POT_PROVIDER_PASSWORD="$PW"
fly deploy

Then set in Vercel:
YOUTUBE_POT_PROVIDER_URL=https://creatorflow:<PW>@<unique-name>.fly.dev

Use an always-on instance. The provider's /healthz endpoint is unauthenticated; /ping
and /get_pot require Basic auth. Never commit the password.

## Verify
python scripts/verify_pot_provider.py
python scripts/verify_pot_provider.py --download

If the provider works but YouTube still returns a bot check, the egress IP itself may
be flagged; try another region/host or an appropriate network route.
