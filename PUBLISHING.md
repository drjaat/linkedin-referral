# Chrome Web Store release checks

The extension now requires a review of exact recipient profiles and note text before sending. This does not establish Chrome Web Store approval or permission to automate LinkedIn.

## Automated checks

```bash
npm ci
npm run test:extension
npx playwright install chromium
npm run test:extension-browser
```

The browser test loads the unpacked extension and uses mocked LinkedIn data to check the panel. It checks the job and post review flows: sending is disabled before review, only checked recipients are sent, the note sent matches the displayed note, changing settings invalidates the review, and local sent history can be cleared.

## Live manual checks before submission

Use your own account and only a recipient who has agreed to a test invitation.

1. Reload the unpacked extension. On two different LinkedIn job detail layouts, confirm **Find contacts** reads the correct job and company and returns to the original job page.
2. Check company people pages with a visible count and with no count. Confirm the size filter and its unavailable-count message match the selected setting.
3. Confirm intern and unreadable-role profiles are absent from the review list. Each listed person needs a name, role, and profile URL.
4. Confirm **Send selected** stays disabled until a recipient is checked. Check that changing any setting clears the review and disables sending.
5. For one consenting test recipient, inspect the full note and profile URL, select only that person, and send. Verify the LinkedIn invitation and the extension's sent history. Reopen the extension and confirm the contact is not offered again.
6. Test LinkedIn's email-verification dialog and an unavailable contact. Confirm neither is recorded as sent. If a result is uncertain, confirm the extension stops and marks that contact for manual review.
7. Check that **Clear sent history** asks for confirmation and removes only local history. It does not retract invitations from LinkedIn.
8. Open a specific post URL and use **Find contacts** without selecting anyone. Confirm that the commenters and reactors shown in the preview match their profile links and visible roles, and that interns are absent. Check posts with comments and reactions separately. The page may expose only a subset of engagers.
9. For a consenting post-engagement contact, review the full note, select that person, and verify that **Send selected** visits the intended profile, checks its name and role, sends only that note, and returns to the post. Confirm a changed role or unavailable Connect action is skipped.

## Store submission

- Upload [`dist/job-outreach-1.1.0.zip`](dist/job-outreach-1.1.0.zip) to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). The ZIP has `manifest.json` at its root and includes only extension runtime files.
- Register a developer account and pay Google's one-time registration fee if you have not done so. Complete the Listing, Privacy, and Distribution tabs, then select **Submit for Review**. Choose **Private** for a limited test or **Public** for a public listing; both go through policy review.
- Provide at least one genuine extension screenshot at 1280×800 or 640×400 pixels. Avoid publishing real contacts' personal information in the screenshot.
- Enter https://drjaat.github.io/linkedin-referral/privacy.html as the Chrome Web Store privacy policy URL, and add a real support contact to the listing. Keep [`docs/privacy.html`](docs/privacy.html) synchronized with [`extension/privacy.html`](extension/privacy.html) after future edits.
- Disclose the extension's LinkedIn page access, local settings and contact history, and invitation sending in the listing and privacy questionnaire. Explain the `tabs`, `storage`, `sidePanel`, `scripting`, and LinkedIn host permissions.
- Review LinkedIn's current terms for automated invitations and the Chrome Web Store's current spam and user-data policies. Store review and LinkedIn account enforcement remain separate decisions.
- Package only the files inside `extension/`, with `manifest.json` at the ZIP root. Keep `extension.pem`, `.env`, `.pw-state`, and `.linkedin-run-state.json` out of the upload.
