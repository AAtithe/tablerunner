# Table Runner: setting up named accounts

Last updated 1 November 2026. For admins. Staff guides:
[host-daily-routine.md](host-daily-routine.md) and
[manager-setting-the-reserve.md](manager-setting-the-reserve.md).

## What changed and why

Everyone now signs in to Table Runner as themselves, with their own email and password. The shared team password stopped working when the update was deployed, and the old admin password works only until you create your own admin account.

Why it matters:

- Leavers. Disabling one person ends their access at once. With a shared password, everyone had to learn a new one.
- Accountability. The Admin log records who changed a setting, a user or a site.
- The right access. A host gets a manager account for Broadcaster only. A group finance lead can get read-only access to every Open House site.

Your job as admin: give every person who uses Table Runner their own account, with the lowest role that lets them do their job.

## Roles and access

Every account has one role and an access list. The role says what the person can do; the access says where. Access is a whole client (every site it has now and adds later) or single sites. Admins see everything.

Give each person the lowest role that lets them do their job, most access first:

| Role | What they can do | Give to |
| --- | --- | --- |
| Admin | Every client and site, and everything in them. Settings, Users, Clients and sites, Email; creates other admins. | You and one deputy, at least two in all. |
| Client admin | Their clients only. Adds and edits those clients' sites and their settings. Manages users whose access lies wholly inside their clients. Cannot create admins, or add, archive or delete clients. | A group operations lead who looks after several sites. |
| Manager | Their sites only. Acknowledges alerts and marks tables closed in OpenTable. Runs releases and reconciliation. | Every host, and the general manager. |
| Viewer | Their sites only. Sees everything, changes nothing. | Finance and owners who only need to look. |

When unsure, start lower. Raising a role takes a minute; undoing a change made with too much access can take much longer. Hosts are managers because they must be able to act on alerts. A viewer sees a red alert but cannot acknowledge it or mark tables closed.

## First time: creating your own admin account

Table Runner was installed before named accounts existed, so you start with the old admin password. It works for one purpose only: letting you in to create your own admin account.

1. On the sign-in screen, choose Use the old admin password and sign in with it.
2. Open Admin, then the Users tab.
3. Add yourself: your name, your email, role admin. Choose Set a password now, and type a password of 10 characters or more. Email sending is not set up yet, so an invite cannot be sent.
4. Press Add user.
5. Sign out, then sign in with your own email and password.

The moment your admin account exists, the old admin password stops working, any session signed in with it ends, and its stored copy is deleted. Do steps 3 to 5 in one sitting.

While you are in Admin, open Clients and sites. Broadcaster sits under a client called Unassigned. Rename that client to Open House, so access can be given to the whole group later.

Table Runner never lets the last active admin be disabled or deleted. If no active admin is ever left all the same, the setup screen comes back. The setup code is in the Vercel logs, which only the Vercel team can see. It creates a new admin and keeps every client, site and user.

## Before inviting anyone: email sending

Set up email sending before you add the team. Invites and password resets are emailed through Postmark, and until sending works you would have to give everyone a password by hand. Only an admin can do this.

1. In Postmark, open Sender Signatures and verify the From address. Better, verify the whole domain by adding the DKIM and Return-Path records Postmark gives you.
2. Open the Postmark server used for Table Runner (the inbound one is fine), choose API Tokens and copy the Server API token.
3. In Table Runner, open Admin, then the Email tab. Paste the token, and fill in the From address and From name.
4. Set Address in emails to the public Table Runner address. If it points at an address behind Vercel's login, invite links will not open for staff.
5. Press Save, then Send me a test. Check it arrives, and not in junk.
6. Under What people receive, preview the invite and password reset emails exactly as staff will see them.

The token is stored encrypted. Until sending works, the Overview tab lists Email sending is not set up under Needs attention.

## Adding a user

1. Open Admin, then the Users tab. The Add a user form is under the list.
2. Name, and Email (their sign-in). Use their own work email, never a shared inbox: resets go there.
3. Role. The hint under the form says what the role can do.
4. Access. Tick a whole client to cover every site it has now and adds later, or tick single sites. Admins have access to everything and need no ticks.
5. How they get in:
    - Email an invite (recommended). They choose their own password from a link that works once and lasts 7 days.
    - Set a password now, 10 characters or more, and give it to them in person or by phone. Never by email or message.
6. Press Add user.

An invite is emailed before the user is saved. If Postmark refuses it, nothing is created and the message says what to fix in Postmark.

Example, a new host at Broadcaster: their name, their own work email, role manager, access ticked for Broadcaster only, Email an invite. They open the link, choose a password and are in. Then hand them the host guide.

## Looking after accounts

Everything below is on the Users tab, from the buttons on each person's row.

| Situation | What to do | What happens |
| --- | --- | --- |
| Invite not used, or expired | Resend invite | A new 7-day link goes out. Every earlier link for that person stops working. |
| Forgotten password | Send reset link, or they press Forgotten your password? themselves | A 1-hour link. Setting a new password signs out their other sessions. |
| New job, more or less access | Edit, change role or access, save | They are signed out at once and sign back in with the new access. Nobody else is affected. |
| Changed email address | Edit, change the email | Their old links stop working; they sign in with the new email. |
| Leaver, or on long leave | Disable | Signed out at once, cannot sign in. Enable brings them back with the same access. |
| Will never return | Delete | The sign-in is removed for good. Prefer Disable if there is any doubt. |
| Device lost or password seen by others | Send reset link | They set a new password, and every other session on their account ends. |

Check two places every week:

- Overview, under Needs attention: invites not yet accepted or expired, only one admin, email sending not set up, sites with no Postmark connection or still on the example floor plan. Each item has a button to fix it.
- Admin log: every client, site, user and settings change and who made it. Filter by type, or search for a name. A client admin sees only entries about their own clients.

## Rules and safeguards

Table Runner enforces these; you cannot switch them off:

- Nobody can disable, delete or change the role of their own account.
- The last active admin cannot be removed.
- A client admin cannot create admins, and manages only users whose access lies wholly inside their own clients.
- Ten failed sign-ins or reset requests from one address lock it out for 15 minutes.
- Sessions last 12 hours. Links work once. Stored passwords and links are hashes, never the real thing.

Our own rules on top:

- Keep at least two admins, so one absence never locks the business out. Overview flags it when there is only one.
- One person, one account. No shared logins, ever, including at the host stand.
- Lowest role that does the job. Hosts are managers, not admins.
- Disable a leaver on their last day, before they leave the building.

## Go-live checklist for Broadcaster

- [ ] Your own admin account created; old admin password no longer works
- [ ] A second admin added
- [ ] Unassigned client renamed to Open House
- [ ] Email sending set up, test received
- [ ] Every host invited as a manager on Broadcaster
- [ ] General manager and senior staff invited as client admin or manager, as their job needs
- [ ] Read-only people invited as viewer
- [ ] Overview shows no invites outstanding
- [ ] Host guide and manager guide handed out
