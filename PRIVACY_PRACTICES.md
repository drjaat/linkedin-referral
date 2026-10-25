# Chrome Web Store Privacy practices answers

Use these for the `1.1.0` extension package in `dist/job-outreach-1.1.0.zip`. Describe the actual uploaded package if it differs.

## Single purpose

Help the user find potential LinkedIn connections from the job or post they opened, review each recipient and message, and send connection requests only to recipients the user selects.

## Host permission justification

The extension needs access to LinkedIn job, company, post, and profile pages to read the currently opened job or post, identify visible potential contacts, verify their profile details, and send only the connection requests the user selects. It does not request access to other websites.

## Remote code use

Select **No** if the form asks whether the extension uses remote code. All executable JavaScript is packaged with the extension (`background.js`, `panel.js`, `core.js`, and `content.js`). The extension does not download or execute code from a remote server. LinkedIn pages provide data and UI controls, not executable extension code.

If the dashboard still requires a text explanation, enter: "No remote code is used. All executable JavaScript is included in the extension package. LinkedIn pages are read only as data sources and for the user-selected invitation workflow."

## `scripting` permission justification

The extension injects its packaged `content.js` into the active LinkedIn tab when its content script is unavailable after a page navigation or extension reload. This restores communication with the page so the user can preview contacts and send selected requests. No remote script is injected.

## `sidePanel` permission justification

The side panel provides the extension's interface for settings, the exact recipient and note preview, individual selection, and the Send selected action. It keeps the review visible while the LinkedIn tab navigates between the job or post, company page, and profiles.

## `storage` permission justification

Chrome local extension storage keeps the user's settings and local sent history. Sent history contains recipient names and profile URLs, a job/company or post identifier, time, and result to help avoid duplicate invitations. The user can clear this history in the side panel. The extension does not send this storage data to a developer server.

## `tabs` permission justification

The extension checks which LinkedIn tab the user has open, navigates that tab to the relevant company people page or selected profile, communicates with its content script, and returns it to the original job or post. It uses the active tab only for this user-initiated workflow.

## Data use certification and publisher email

The publisher must review the Chrome Web Store Developer Program Policies and complete the data use certification personally. The publisher must also enter a real contact email on the dashboard Settings page and complete the email verification link sent by Google. Do not invent an email or certify on the publisher's behalf.
