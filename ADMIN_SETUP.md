# Lead dashboard setup

Nothing in this file should be deployed until the local implementation has been reviewed and production deployment has been approved.

## Resources

- Worker: `wohnquartier-geseke-west` (existing name)
- D1 database: `wohnquartier-geseke-leads`
- D1 binding: `LEADS_DB`
- Secrets: `ADMIN_PASSWORD_HASH`, `AUTH_RATE_LIMIT_SECRET`

## Local verification

```powershell
node --test
node --check src/worker.js
node --check admin/admin.js
node --check script.js
npx wrangler d1 migrations apply wohnquartier-geseke-leads --local
npx wrangler dev
```

Run `node scripts/generate-admin-secret.mjs` to generate a strong initial password and the two secret values. Share the displayed password securely with the client and do not save the output in the repository.

For local Wrangler testing, put the generated secret values in `.dev.vars`; this file is ignored by Git and by static asset uploads:

```dotenv
ADMIN_PASSWORD_HASH="pbkdf2-sha256$..."
AUTH_RATE_LIMIT_SECRET="..."
```

## Production steps (only after explicit approval)

1. Authenticate Wrangler with the Cloudflare account that owns the existing Worker.
2. Run `npx wrangler d1 create wohnquartier-geseke-leads`.
3. Replace the zero placeholder `database_id` in `wrangler.jsonc` with the returned ID.
4. Review the generated configuration diff.
5. Run `npx wrangler d1 migrations apply wohnquartier-geseke-leads --remote`.
6. Configure `ADMIN_PASSWORD_HASH` and `AUTH_RATE_LIMIT_SECRET` as encrypted Worker secrets in the Cloudflare dashboard. Do not use plaintext Wrangler `vars`.
7. Confirm the existing custom domain and Worker name remain unchanged.
8. Deploy the reviewed Worker and static assets.
9. Submit one clearly labelled technical test through the public form.
10. Verify primary/CC routing, one D1 record, authentication, status changes, filters, logout, and automatic polling in an already-open dashboard.

The FormSubmit endpoint and CC must remain:

- Primary: `alexander.laumeier@sparkasse-geseke.de`
- CC: `immobilien@sparkasse-geseke.de`

The webhook requires no repository credential. FormSubmit does not document a webhook signature, so the Worker validates input, limits payload size, rate-limits authentication, and deduplicates identical deliveries.
