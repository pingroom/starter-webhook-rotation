# PingRoom webhook rotation starter

Rotate an incoming webhook used by a CI job or other service. Create a successor with the same supported settings, switch the service to its new URL, then explicitly retire the predecessor. Both credentials stay enabled during the migration.

This starter uses the official **PingRoom CLI 0.12.0**, pinned with a lockfile. It makes management requests only: no test pings, webhook triggers, or downstream deployments. Rules and state transitions live in application code.

## Try it offline

Requires Node.js 22 or newer on Linux/macOS. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm test
npm run demo
```

The demo runs the real pinned CLI against a localhost mock, simulates adoption, and removes its temporary secrets afterward. No PingRoom account or credentials are needed. GitHub Actions checks Node 22 and 24.

## Connect

```sh
npm ci
cp .env.example .env
npm run connect
```

Authorize the CLI with the account that **owns the room**, and grant that room plus `pingroom:webhooks:read` and `pingroom:webhooks:write`. Set `PINGROOM_ROOM` in `.env` to the uppercase 12-character code. Alternatively, set both `PINGROOM_ROOM` and `PINGROOM_TOKEN`; CI requires an explicit token. Pairing credentials stay in this project's ignored `.pingroom/` directory. Blank explicit tokens fail instead of falling back to saved credentials.

Creating a successor requires **Pro** and a spare slot. A room permits **four webhook records total**, including disabled ones. Disabling an existing credential remains available after Pro lapses. This starter never deletes records to make space.

CLI 0.12.0 cannot set emoji or haptic. The predecessor must use the default **🔗 emoji** with **no haptic override**. The starter copies title, message, icon, color, sound, action number, and cooldown; the successor gets a unique `rotation-…` name. Unsupported or malformed values fail before creation. Messages are limited to 120 characters.

## Rotate one credential

Use the app to identify the intended webhook. This command lists only IDs and enabled states:

```sh
npm run inventory
npm run plan -- PREDECESSOR_UUID
```

`plan` reads the configuration, saves the private baseline, and prints its hash. Keep that exact hash for the following commands. You can inspect `.rotation/journal.json` locally to review the settings, but it contains secret URLs: do not paste it into logs or tickets.

```sh
npm run stage -- PLAN_HASH
npm run export-url -- PLAN_HASH
```

The new credential is saved in `.rotation/successor-url.txt` with mode `0600`, never printed. Transfer its contents directly into the downstream service's secret store. Update every consumer of the predecessor, and confirm their adoption yourself. This starter does not update or test those services.

Only after that work is complete:

```sh
npm run adopt -- PLAN_HASH --downstream-updated
npm run retire -- PLAN_HASH
npm start
```

`adopt` records your confirmation locally. `retire` disables the exact predecessor and reads both records back; it reports `complete` only when the predecessor is disabled and the successor still matches. This verifies configuration, not notification delivery or downstream adoption. A disabled predecessor still consumes a slot; you can remove it later in the app.

## Recovery and cancellation

Each mutation is preceded by an atomic, durable journal entry. After an interruption:

```sh
npm start
npm run recover
```

`recover` only reads. An uncertain creation is matched by its reserved unique name, expected settings, and baseline IDs. An uncertain retirement completes only after the disabled predecessor and unchanged successor are observed. **An absent successor or still-enabled predecessor does not prove an in-flight request has settled.** The journal remains uncertain; the starter will not repeat POST/PUT, even after a server rejection. If recovery cannot establish the expected result, reconcile the recorded IDs in the app and resolve the operation manually before archiving the journal. Never remove an uncertain journal just to retry creation.

```sh
npm run cancel -- PLAN_HASH
```

Cancellation changes only the local journal and is allowed for a settled planned, staged, or adopted rotation. If a successor already exists, both credentials remain enabled and its private URL can still be exported. Complete any required cleanup in the app. Cancellation is refused while creation or retirement is uncertain.

A lock prevents concurrent commands in this checkout. After a hard crash, remove `.rotation/.lock` only once the old process has stopped; then use recovery. The journal is bound to the room and credential. Preserve those credentials through recovery. Once a rotation is complete or manually reconciled, archive `.rotation/` in private storage before starting a new one; keep old receipts and secrets out of Git.

## Adaptation and limits

Use `src/rotation.mjs` as the application workflow and `src/cli.mjs` as its transport. Add a downstream secret-store adapter where you currently transfer the exported URL, keeping adoption explicit until your own integration can establish it. Demo adoption is a placeholder; there is no deployment handler.

Run one administrator at a time. Preflight reads catch observed changes, but the API has no conditional compare-and-swap: another administrator can change a webhook between a read and write. The workflow does not promise zero downtime, delivery continuity, or automatic rollback. It does not delete records, clone custom emoji/haptic settings, or automatically retry uncertain mutations.

Webhook list responses include **every webhook secret in the room**. The wrapper captures them privately in memory, suppresses raw CLI responses and errors, and stores only the selected predecessor/successor URLs in the private journal. `.rotation/`, `.pingroom/`, and `.env` are ignored. Keep the directory and backups private; never upload the journal or URL export. Production commands use `https://api.pingroom.io` and an isolated CLI home; ambient webhook settings are not inherited.

[Official CLI documentation](https://github.com/pingroom/cli) · [MIT license](LICENSE)
