# LinkedIn Job Outreach

## Chrome extension

The unpacked extension in [`extension/`](extension/) starts from the LinkedIn job detail page you already have open. It checks the job title and experience requirement, follows the job's company link, checks the company member count when LinkedIn shows it, and looks for connectable people using the `hiring` search with a `manager` fallback. It prepares notes from your template and keeps local sent history so the same contact is not approached again.

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `extension` folder.
2. Sign in to LinkedIn in Chrome and open a job URL such as `https://www.linkedin.com/jobs/view/123456/`.
3. Click the extension icon to open its side panel. Enter your name and HTTPS resume link, then choose a minimum company size, including **5,000+ members** if you want. The size filter applies when LinkedIn shows a count. The default note says “Senior Software Engineer – Frontend/Full Stack”; **More options** lets you change the note and other filters.
4. Click **Find contacts** to review the exact recipients and notes. Tick the people you approve, then click **Send selected**. The extension returns the tab to the job page afterward. The review expires after 15 minutes and is cleared if settings change.

The extension uses Chrome's existing LinkedIn session. It skips contacts whose visible role says intern or internship, and contacts without a readable role or profile URL. For job contacts, it checks the person and role again on the company people page before sending. Its settings and sent history remain in local extension storage. If a send result is uncertain, the contact is marked for review and sending stops to avoid an accidental duplicate. LinkedIn layout changes may require selector updates in [`extension/content.js`](extension/content.js).

### Post engagement outreach

Open a specific LinkedIn post URL (`/posts/...` or `/feed/update/...`) and click **Find contacts**. The extension reads visible commenters and people in the reactions dialog, then shows names, roles, profile links, and complete notes for review. Tick the people you approve and click **Send selected**. It visits each selected profile, checks the name and role again, and returns to the post afterward. It skips interns and profiles without a readable role or URL. The per job or post request limit also applies here; company, job title, experience, and resume filters apply only to jobs. The default post note does not include a resume link. LinkedIn may show only some commenters or reactors, so the preview is limited to people the page loads. This workflow has automated checks but still needs a read-only check against a real post before release.

The extension uses template notes. The Playwright script's optional Azure OpenAI personalization is not included because an API key in an unpacked client extension would be exposed.

The in-extension [privacy policy](extension/privacy.html) describes the local data. Before Chrome Web Store submission, host this policy at a public HTTPS URL, add that URL and a real support contact to the store listing, and check LinkedIn's current rules on automated invitations. Store reviewers can reject extensions that send messages without recipient and content confirmation; this extension now requires that review, but store approval and LinkedIn acceptance are not guaranteed.

Use the [publishing checklist](PUBLISHING.md) for live LinkedIn checks and store submission steps.

Run the extension's logic checks with `npm run test:extension`. After `npm install` and `npx playwright install chromium`, run `npm run test:extension-browser` to load the unpacked extension and check the job and post recipient review and send controls. The send check uses mocked LinkedIn data and sends no real requests.

## Original Playwright script

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
- Company-size filter defaults to 100+ members (`MIN_COMPANY_MEMBERS=100`).
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
