# LinkedIn Playwright Automation

This script opens LinkedIn Jobs, filters relevant jobs, finds hiring contacts, and prepares/sends connection notes.

## 1) Setup

```bash
cp .env.example .env
npm install
npx playwright install chromium
```

## 2) Configure `.env`

- `DRY_RUN=true` keeps it safe (no send).
- Set `LINKEDIN_JOBS_URL` to your preferred job search URL.
- Tune `PROFILE_KEYWORDS` and `EXCLUDE_KEYWORDS`.
- Jobs pagination can use URL offsets (`start=0,25,50...`) via `USE_START_PAGINATION=true` and `JOBS_PAGE_SIZE=25`.
- Experience filter defaults to 5-9 years (`EXPERIENCE_FILTER_ENABLED`, `PREFERRED_MIN_YEARS`, `PREFERRED_MAX_YEARS`).
- Set `CANDIDATE_NAME` and `CANDIDATE_SIGNATURE`; use `{Signature}` in `NOTE_TEMPLATE`.
- Keep note length <= 300 chars.

## 3) Run

```bash
npm run dry-run
```

or

```bash
npm start
```

When the browser opens, log into LinkedIn if prompted.

## Notes

- LinkedIn UI changes frequently; selectors may need small updates.
- Respect LinkedIn terms and avoid aggressive request volume.
