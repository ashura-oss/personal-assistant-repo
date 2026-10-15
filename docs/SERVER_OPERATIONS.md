# Still server operations

This is a deployment package and operator runbook for a single Linux server process behind Caddy. It does not provision a host, configure a cloud account, or prove a Linux/GCP deployment. No live host, OAuth registration, provider, key, or production data was used to write or test it. Confirm the actual Ubuntu release, Node version, native addon install, systemd behavior, TLS, and graceful shutdown on the selected host before treating it as production-ready.

## Runtime boundary

The release archive contains the compiled server, its direct Node entrypoint and npm lockfile, the exported web app, deployment templates, and this runbook. It excludes source maps, source trees, tests, caches, dependencies, environment files, databases, vault keys, media, and user workspaces. The release manifest hashes packaged files; the adjacent SHA-256 file detects accidental or malicious archive changes only when compared with a separately trusted digest. Neither file authenticates who published a release.

Each release gets a new real directory, for example `/opt/still/releases/2026-10-15-a1b2c3d`. Do not configure `/opt/still/current` or another symlink as the service working directory. Install Linux dependencies from the release lockfile in a separate unprivileged build directory with `npm ci --omit=dev`, smoke-test them, and then copy them into the new release before activation. Make the release root-owned and read-only to the service account before activation. Never replace or modify files in a release while its process is running.

The target package is intended for Node.js 24.x. The package manifest records the packager's local Node version and OS; it does not prove the selected Linux host has a compatible runtime. Windows `node_modules` must never be copied to Linux. `better-sqlite3` is a native addon: install it on the target Linux distribution and architecture, then prove it can open an in-memory database before activation. Linux import/addon, systemd, Caddy, HTTPS, SIGTERM drain, and mobile browser checks remain unverified until run on the actual target.

The service binds only to `127.0.0.1`. Caddy proxies the whole canonical HTTPS origin to `127.0.0.1:8787`; it must preserve the original Host and request URI. Keep the default access logging disabled so OAuth callback query strings are not recorded. Do not add path rewrites, a public static-file bypass, CORS policy, proxy retries, or another listener. The app itself serves both the API and exported web shell, and enforces its canonical origin.

`/healthz` is a host/origin-checked HTTP admission check. It does not prove that a user is authenticated, OAuth is configured, a provider is reachable, or a model is usable. The `status` CLI reports local enrollment state, not server or provider health. Do not poll provider endpoints as a health check. Usage and costs remain unknown when the provider does not report them; this deployment adds no AI quotas.

Only one Still application may own a persistent database on a local host at a time. The process holds an operating-system SQLite lock in the adjacent `<database>.owner.sqlite` sidecar for its lifetime. The sidecar is persistent coordination state, not a stale PID file: never delete, replace, restore over, or manually edit it to clear ownership. Do not place the database on a network/shared filesystem; cross-host locking is not guaranteed. Local CLI `status`, `enroll`, and `reset-password` use the same ownership guard and therefore require the server to be stopped. For live service state, use the authenticated app/API and systemd status instead. Stop the service and confirm its process group is empty before running a CLI command.

## Media cleanup and derived documents

When a committed workspace snapshot removes its last reference to Still-owned audio, the snapshot change and a private durable cleanup intent are recorded in the same database transaction. Reads of media covered by a pending intent are denied. The intent is marked complete only after its exact active holders are closed, the owned file is removed, the containing directory is synchronized where supported, and the completion record commits. A failed step leaves the intent pending for an exact retry; do not manually delete intent rows or media files to clear it.

At process startup, before runtime actors are created, the host performs a bounded metadata pass over pending cleanup intents. A private one-use startup capability is bound to the live ownership handle, exact kernel, database path, and host process identity; it cannot be recreated after the startup phase is sealed. Recovery validates the current owner and workspace epoch, capture/media rows, authoritative snapshot references, and the exact durable async-command journal lineage before deriving any filesystem path. Valid work from an earlier process can be completed, including an older workspace epoch when ownership and lineage still match. Missing owners, changed epochs without valid proof, malformed rows, or ambiguous journal history are left pending for inspection. The recovery code retires only exact prior-process holders for that pending media; it never performs an orphan-file sweep. If closing an owned descriptor fails, the exact descriptor remains owned and is retried before startup can seal or release the database owner. This behavior does not establish a public note-delete or cleanup-retry UI contract.

Markdown documents mirrored to private files are derived projections. A mirror failure marks that path dirty for a later retry and does not add an error activity or another canonical workspace write. The durable workspace snapshot remains authoritative. Cold-start recovery and exact journal-lineage behavior have automated local tests; physical cleanup, directory synchronization, descriptor-close retry, and graceful shutdown still require verification on the selected Linux host.

The browser-consent and policy/occurrence foundation records standing consent and keeps actual provider cost known only when reported. A shared fair timer engine supports backoff, `Retry-After`, rollback, and drain behavior. These foundations are not yet wired into the host's scheduled provider operations, and account-sync policy behavior has not been verified end to end. The browser reply workflow now lets a person explicitly derive an editable source-bound copy without another AI request, edit To/Cc/body and the reviewed draft/send operation, save it, approve the fresh revision, and separately execute the approved action. Exact command IDs are retained for receipt inspection after uncertain outcomes; unsaved edits survive reopening, and the current child revision can be reopened from its superseded parent. The immutable parent and fresh-source checks remain enforced. Accepted remote-draft promotion to send is still incomplete, so the complete reply lifecycle does not yet include sending an already accepted remote draft.

## Prepare the host and first release

Use an Ubuntu host with a supported Node.js 24.x runtime, `npm`, `tar`, Caddy, and the media tools needed by the enabled features (`/usr/bin/ffmpeg` and `/usr/bin/ffprobe`). Check `node --version`, `npm --version`, and the tool paths on that host; the packager does not prove them. Use an interactive administrator session. Restrict inbound firewall access to SSH and TCP 80/443; do not expose port 8787. Point the chosen DNS name to the host before enabling Caddy TLS. These are operator actions; this repository does not run them.

Create separate private paths owned by the service account `still:still`, mode `0700`:

- `/var/lib/still/data` for the SQLite database and its live sidecars.
- `/var/lib/still/keys` for the vault root key, outside both the database directory and public static tree.

For a first setup, create the non-login account and fixed release parent explicitly:

```sh
sudo useradd --system --home-dir /var/lib/still --shell /usr/sbin/nologin still
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin still-build
sudo install -d -o root -g root -m 0755 /opt/still/releases
sudo install -d -o root -g root -m 0700 /etc/still
sudo install -d -o root -g root -m 0755 /var/tmp/still-build
```

Create `/etc/still/still.env` as `root:root`, mode `0600`, from `deploy/still.env.example`. Set `STILL_ORIGIN` to the exact canonical HTTPS origin with no trailing slash. Keep `STILL_DATA_DIR` and `STILL_VAULT_KEY_FILE` as absolute non-symlink paths. Optional OAuth client IDs and secrets must be supplied as complete pairs and stay in this root-only server file; never put a client secret in the browser app. Do not put secrets in command arguments, shell history, or exported environment variables.

Build an archive on a trusted packaging machine with `node scripts/package-server.mjs --release-id <unique-release-id>`. The command runs the guarded production PWA export and release server build, copies only the allowlisted files, creates `release-manifest.json`, verifies the temporary USTAR archive, and only then publishes the `.tar.gz` and adjacent `.sha256` file. Verify it with `node scripts/verify-server-package.mjs <archive> --expected-sha256 <digest>` using a digest delivered over a separate trusted channel. The verifier reads the archive without extracting it and checks entry types, paths, hashes, required files, and exported web references. This is integrity checking, not signature verification.

On the host, compare the archive digest using the separately trusted expected value, check the release ID, and extract only into the fixed `/opt/still/releases` parent. From the directory containing the archive and its sidecar, run `sha256sum -c still-<release-id>.tar.gz.sha256` after independently comparing that digest with the value received over the trusted channel. Establish the extraction parent as a real root-owned directory with mode 0755, and confirm `/opt/still/releases/<release-id>` does not already exist:

```sh
sudo install -d -o root -g root -m 0755 /opt/still
sudo install -d -o root -g root -m 0755 /opt/still/releases
sudo chown root:root /opt/still /opt/still/releases
sudo chmod 0755 /opt/still /opt/still/releases
test ! -e /opt/still/releases/<release-id>
sudo tar -xzf "still-<release-id>.tar.gz" -C /opt/still/releases --no-same-owner --no-same-permissions --no-overwrite-dir
```

The archive has one versioned top-level directory and no `./` entry that can change the extraction parent. Do not extract to an arbitrary path or accept unexpected files. The standalone verifier is a packaging-machine tool and is not installed in the release. Confirm the extracted release root contains the expected manifest and topology. Install runtime dependencies in a separate directory owned by the unprivileged `still-build` account, which has no access to the service's future data/key directories:

```sh
sudo install -d -o still-build -g still-build -m 0700 /var/tmp/still-build/<release-id>
sudo install -d -o still-build -g still-build -m 0700 /var/tmp/still-build/npm-cache
sudo cp /opt/still/releases/<release-id>/server/package.json /opt/still/releases/<release-id>/server/package-lock.json /var/tmp/still-build/<release-id>/
sudo chown still-build:still-build /var/tmp/still-build/<release-id>/package.json /var/tmp/still-build/<release-id>/package-lock.json
sudo -u still-build npm --cache /var/tmp/still-build/npm-cache --prefix /var/tmp/still-build/<release-id> ci --omit=dev
sudo -u still-build env -i PATH=/usr/bin:/bin /usr/bin/node --input-type=module -e "import Database from '/var/tmp/still-build/<release-id>/node_modules/better-sqlite3/lib/index.js'; const db = new Database(':memory:'); db.exec('select 1'); db.close();"
sudo cp -a /var/tmp/still-build/<release-id>/node_modules /opt/still/releases/<release-id>/server/
```

Then, as `still-build`, run an import-only smoke from the compiled release in a clean environment: `cd /opt/still/releases/<release-id>/server && sudo -u still-build env -i PATH=/usr/bin:/bin /usr/bin/node --input-type=module -e "await import('./scripts/still-server.mjs')"`. That import loads modules but does not call the start command or read workspace/data state. Create the service data/key directories only after dependency and import checks pass: `sudo install -d -o still -g still -m 0700 /var/lib/still/data /var/lib/still/keys`. Before activation, make the release root-owned and nonwritable by the service user while retaining existing executable bits (the archive's files are 0644 and directories 0755): `sudo chown -R root:root /opt/still/releases/<release-id> && sudo chmod -R u=rwX,go=rX /opt/still/releases/<release-id>`. These checks touch no production data. If any fails, do not activate the release; install the distribution's compiler/runtime prerequisites or use a compatible Node build, then repeat the checks.

Make the release tree owned by root and not writable by `still`; preserve readable/execute permissions for the service. Do not make the env file or private directories readable by other users. Replace both `REPLACE_WITH_RELEASE_ID` tokens in the systemd template with the exact checked ID, inspect the two resulting paths, and install the file as `/etc/systemd/system/still.service`. For the env file, use `sudo install -o root -g root -m 0600 deploy/still.env.example /etc/still/still.env`, then edit it with a root editor; keep OAuth secrets out of shell arguments/history and out of exported shell variables. Install the data/key parents with `sudo install -d -o still -g still -m 0700 /var/lib/still/data /var/lib/still/keys`. Replace the Caddy site name in `deploy/caddy/Caddyfile` with the canonical host, install it as `/etc/caddy/Caddyfile`, and validate it with `sudo caddy validate --config /etc/caddy/Caddyfile` before starting the service. Run `sudo systemd-analyze verify /etc/systemd/system/still.service` on the actual target. Neither validation has been run on Linux for this draft.

Run enrollment from a local interactive TTY after the service account, private directories, environment file, and release dependencies are ready. The package does not install a `still-server` executable, so invoke the versioned entrypoint directly. Supply only the nonsecret config paths needed by the CLI; the password prompt is hidden:

```sh
sudo -u still env \
  STILL_ORIGIN=https://still.example.com \
  STILL_DATA_DIR=/var/lib/still/data \
  STILL_VAULT_KEY_FILE=/var/lib/still/keys/vault-root.key \
  /usr/bin/node /opt/still/releases/<release-id>/server/scripts/still-server.mjs enroll
```

Never pass the password as an argument or environment variable. `status` is also a direct invocation and reports enrollment state only:

```sh
sudo -u still env \
  STILL_ORIGIN=https://still.example.com \
  STILL_DATA_DIR=/var/lib/still/data \
  STILL_VAULT_KEY_FILE=/var/lib/still/keys/vault-root.key \
  /usr/bin/node /opt/still/releases/<release-id>/server/scripts/still-server.mjs status
```

Start with `sudo systemctl start still.service` and confirm `sudo systemctl is-active still.service`. The external probe is `curl --fail --show-error https://still.example.com/healthz`. A local loopback probe must use the canonical Host header, for example `curl --fail --show-error -H 'Host: still.example.com' http://127.0.0.1:8787/healthz`; it checks only HTTP admission. Confirm an unauthenticated request is not mistaken for a logged-in session. Do not send provider requests as deployment smoke tests.

## Release activation and rollback

Prepare and verify the new versioned release, install its Linux dependencies, and perform the native-addon and import smoke checks before stopping the active release. Keep the current release untouched. Stop with `sudo systemctl stop still.service`; read its group using `systemctl show still.service -p ControlGroup --value`, then inspect that exact group with `sudo systemd-cgls <control-group>`. Change the unit's `WorkingDirectory` and `ExecStart` only after the old cgroup is empty. The unit uses SIGTERM, `KillMode=mixed`, a finite stop timeout, and `SendSIGKILL=no`: if graceful close exceeds the timeout, systemd should leave the process for operator investigation instead of killing it or permitting an overlapping app instance. Do not start another release until the old cgroup is confirmed empty.

After updating the unit, run `sudo systemctl daemon-reload`, `sudo systemd-analyze verify /etc/systemd/system/still.service`, and `sudo systemctl start still.service`. Check `sudo systemctl is-active still.service`, `sudo journalctl -u still.service`, the canonical HTTPS route, and `/healthz`. The journal and Caddy configuration should not record request query strings. Do not infer provider connectivity or authenticated readiness from these checks.

Rollback by selecting a prior binary only when it is compatible with the current database schema and vault format. Never point an older binary at a database it cannot read. If a release changed persistent schema or vault format, rollback requires a coordinated restore of the matching database, media, and exact vault key from a separately verified backup. There is no automatic data downgrade.

## Failure handling

- **Stop timeout or non-empty cgroup:** leave the service stopped; inspect `systemctl status`, `systemctl show still.service -p MainPID,ControlGroup`, and the unit journal. Determine whether the process still owns files or child processes. Do not start a replacement or force-kill it by default. Use an explicit operator-reviewed recovery only after establishing that the old process cannot continue writing.
- **Disk full:** keep the service stopped if SQLite cannot safely write. Free space outside the live database, WAL, media, and key paths first. Do not delete `-wal` or `-shm` files while the process is open. After space is restored, start and inspect the journal and application state.
- **Missing or wrong vault key:** do not let a new key replace the original. Restore the exact key from its separate escrow, check owner/mode/path, and retry. A missing key beside an existing database or a key mismatch is a recovery event, not a fresh-install prompt.
- **Permissions or symlink rejection:** inspect each configured path and ancestor. Data/key directories must be real directories owned by `still` and private; the key file is separate from the database and static tree. Remove a symlink only after verifying its target and restore the intended real path and permissions.
- **Native addon failure:** do not use Windows dependencies or activate the release. Re-run target-local `npm ci --omit=dev` with the supported Node runtime and build prerequisites, then repeat the in-memory SQLite smoke.
- **TLS or canonical-origin failure:** verify DNS, inbound 80/443, Caddy validation, exact `STILL_ORIGIN` spelling, and that the proxy preserves Host and URI. Do not weaken the app's HTTPS/canonical-origin checks to work around a proxy error.
- **OAuth failure:** check the canonical redirect URI (`<origin>/api/oauth/google/callback` or `<origin>/api/oauth/microsoft/callback`), complete server-only client ID/secret pair, provider registration, and host clock. Do not print callback URLs, authorization codes, tokens, or secrets into shared logs. Synthetic tests do not prove live provider registration or account behavior.
- **Unknown command result:** inspect the exact command status/history in the authenticated app and keep the original command ID. Do not create a new command to retry an outcome that may already have committed. Resolve the exact result or use the relevant domain recovery path before proceeding.

## Backup and restore status

Backup is a separate operational phase and is not implemented by these packaging scripts. Do not tar an open SQLite database and its live WAL/SHM files and call it consistent. A valid plan must capture a consistent database snapshot while writes are quiesced or through a separately reviewed SQLite backup mechanism, include private media and the vault encrypted payloads, encrypt the backup off-host, escrow the exact vault key separately, and prove restore into an isolated environment before relying on it. Record the tested restore point and key pairing. Until that process exists and has a restore proof, backup readiness remains open.

## Validation limits

The packaging tests use disposable fixtures and exercise path, symlink, archive, manifest, checksum, required-file, and static-reference checks. They do not install system packages or access production data, keys, providers, or a live host. Before a real deployment, the selected Linux host still needs `npm ci --omit=dev`, the native SQLite smoke, `systemd-analyze verify`, `caddy validate`, graceful SIGTERM/cgroup-drain proof, HTTPS/canonical-host checks, and a separate backup restore proof. No Linux/GCP or iPhone behavior is established by this package.
