# Server deployment

The deployment job reads `main` from GitHub and builds each new commit in a
separate release directory. It runs `pnpm check` before restarting the API.
The new release becomes current only after `/ready` succeeds. A failed startup
restores the previous release. A rejected commit is skipped until `main` changes
or its marker in `run/rejected` is removed.

The dedicated server directory is `/home/developer/scoutapotres-backend`.
It holds the runtime, release directories, logs, and persistent database and
media. The API listens on port 3000. MongoDB listens on loopback port 27028,
uses a single member replica set with keyfile authentication, and grants the
API its own database user. Production credentials stay in the server directory.

`deploy.sh` is installed at the root of that directory and runs once a minute
from the `developer` user crontab. The job also starts the last healthy release
after a reboot. It uses a lock to prevent overlapping deploys. The job pulls
from the public GitHub repository, so GitHub needs no SSH credentials.

Inspect `logs/deploy.log` for checks and the deployed commit. The `current`
symlink points to that commit's release directory. `logs/api.log` and
`logs/mongo.log` hold service logs. Database and media files live under `data/`
and are shared by releases.
