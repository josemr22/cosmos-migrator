# cosmos-migrator

TypeScript CLI for copying one Cosmos DB for NoSQL database, its containers and their items to another account.

## Requirements

- Node.js 20 or newer
- npm
- For online inventory, a Cosmos DB source account key
- For migration, source and target account keys

## Install and develop

```sh
npm install
npm run build
npm test
npm link
```

`npm link` makes the `cosmos-migrator` executable available on your PATH. During development you can instead use `npm run dev -- plan ...`.

## Credentials

Online `plan` reads `COSMOS_SOURCE_KEY`. A real `run` requires both `COSMOS_SOURCE_KEY` and `COSMOS_TARGET_KEY`. Set them in the environment (or a secret manager); credentials are never accepted as flags or written to plan JSON or logs. `--offline` does not connect to Azure and does not require credentials.

## Create a plan

Offline mode is useful for checking CLI integration. It always produces an empty container inventory:

```sh
cosmos-migrator plan \
  --source-endpoint https://source.documents.azure.com \
  --target-endpoint https://target.documents.azure.com \
  --database appdata \
  --offline
```

Online mode makes a read-only request to list containers in the source database:

```sh
export COSMOS_SOURCE_KEY='your-source-account-key'
cosmos-migrator plan \
  --source-endpoint https://source.documents.azure.com \
  --target-endpoint https://target.documents.azure.com \
  --database appdata
```

By default, the plan is printed to stdout and is not persisted to the filesystem. Persisting a plan is opt-in with `--plan-out <file>`; the file is created without overwriting an existing path and with owner-only permissions where supported:

```sh
cosmos-migrator plan \
  --source-endpoint https://source.documents.azure.com \
  --target-endpoint https://target.documents.azure.com \
  --database appdata --offline \
  --plan-out appdata.plan.json
```

Plan JSON is versioned and contains account endpoint identities, the database id, a generation timestamp, and container configuration metadata. It contains no credentials or item data.

## Preview and run a saved plan

```sh
cosmos-migrator run --plan appdata.plan.json --dry-run
```

This validates the versioned plan and prints a summary without requiring credentials or making Cosmos DB requests.

Create an online plan before migration. Offline plans intentionally cannot be executed because they do not contain a complete source inventory. Then provide both keys and confirm interactively:

```sh
export COSMOS_SOURCE_KEY='your-source-account-key'
export COSMOS_TARGET_KEY='your-target-account-key'
cosmos-migrator run --plan appdata.plan.json --page-size 100
```

The command verifies the source metadata still matches the plan and preflights the destination database and containers before creating anything. Existing destination databases are treated as conflicts; nothing is deleted or overwritten. For automation, `--yes` explicitly confirms the write operation:

```sh
cosmos-migrator run --plan appdata.plan.json --yes --page-size 100 --max-concurrency 1
```

During a real run, the CLI writes an owner-readable recovery checkpoint after each completed container. By default it lives under `./.cosmos-migrator/checkpoints`; choose another directory with `--checkpoint-dir <directory>`. Checkpoints contain a plan fingerprint, account/database identities, completion state and timestamps, never credentials or item contents. They are written atomically with owner-only file permissions where supported. A successful migration removes its checkpoint. A failure after destination writes begin retains it and prints its path. `run --dry-run` never creates checkpoint state.

Inspect or resume a failed migration with the same plan and checkpoint directory:

```sh
cosmos-migrator status --plan appdata.plan.json
cosmos-migrator resume --plan appdata.plan.json --yes --page-size 100
cosmos-migrator resume --plan appdata.plan.json --checkpoint-dir ./recovery --yes
cosmos-migrator resume --plan appdata.plan.json --dry-run
```

`status` needs no cloud credentials. `resume` verifies the checkpoint fingerprint, source inventory and exact destination container metadata before writing; it refuses missing or extra target containers. It skips completed containers and starts an incomplete container from its first page, using idempotent upserts. If the same container failed mid-copy, its items may be written again.

`--page-size` accepts 1-1000 (default 100). `--max-concurrency` accepts 1-16 (default 1); item copying currently runs sequentially, so values above 1 do not increase concurrency yet. The Cosmos SDK handles ordinary throttling and transient retries. Progress reports counts only and never prints item payloads.

## Operational considerations and limitations

- Migration consumes request units and may incur network egress charges. Estimate cost and RU capacity before copying large databases.
- The source is not locked or snapshotted. Writes made while migration runs may be missed or copied inconsistently; pause source writes for a consistent cutover.
- A checkpoint is saved after each container finishes. A failure during an individual container causes that container to be copied again from the beginning on resume; upserts make this safe for item identity, but it can consume additional request units. Checkpointing does not make the source a snapshot and does not capture changes made while copying.
- Existing destination database/container conflicts abort before destination writes. A race or service failure after preflight can still leave partial resources.
- Offline plans are preview-only. Container filtering, change feed/incremental migration, key transforms and cross-partition-key migration are not supported.
- Migration copies items using upsert and copies basic container settings: partition key, indexing policy, unique keys and default TTL when provided by the source metadata.
