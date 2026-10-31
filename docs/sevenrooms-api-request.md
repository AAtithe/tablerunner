# SevenRooms API access request

| | |
| --- | --- |
| Status | Sent, awaiting reply |
| Sent | 31 October 2026 |
| From | Broadcaster General Manager, Tom Stanley (Williams, Stanley & Co.) copied |
| To | SevenRooms account manager for Broadcaster |
| Follow up | 7 November 2026, owner Tom Stanley |

The email does not name the other booking channel. If SevenRooms asks
which channels are being synced, or the API terms require the integration to
be described, answer accurately.

## Email

Subject: Broadcaster: API access for reservation sync

Hi [Name],

We take reservations through several booking channels besides SevenRooms. We
have built a service that writes those reservations straight into SevenRooms,
so the team no longer re-keys them. It is tested and ready, apart from the
connection to your API. Tom Stanley at Williams, Stanley & Co., copied in, is
running the build.

Please could you send us:

1. API credentials for Broadcaster: client ID, client secret and venue ID.
2. The API documentation.
3. A sandbox or test venue, if you have one.

We also need answers to four questions:

1. Can we create a reservation against a specific table, and is the request
   rejected if that table is already taken?
2. Can a reservation store the booking reference from the channel it came
   from, and can we search by that reference?
3. Can reservations be updated, cancelled and listed by date range through
   the API?
4. Can tables be blocked and released through the API?

If a short call with your integrations team would be quicker, we are happy to
do that.

Many thanks,

[GM name]
General Manager, Broadcaster
cc: Tom Stanley

## Answers received

Record each answer here with the date and who gave it. The answers to
questions 1, 2 and 4 decide the design of `SevenRoomsClient` in
`src/adapters/sevenrooms.js`.

| Question | Answer | Date | From |
| --- | --- | --- | --- |
| 1. Create against a specific table, rejected if taken | | | |
| 2. Store and search by channel booking reference | | | |
| 3. Update, cancel, list by date range | | | |
| 4. Block and release tables | | | |

## Received

- [ ] Client ID
- [ ] Client secret (enter on the Settings screen only, never in the repo)
- [ ] Venue ID
- [ ] API documentation
- [ ] Sandbox or test venue
