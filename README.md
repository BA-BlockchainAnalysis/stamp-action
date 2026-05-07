# BA | Stamp — GitHub Action

Anchor file hashes on **Polygon + Bitcoin via OpenTimestamps** from any GitHub workflow. Files never leave the runner — only the SHA-256 hash is sent.

Use it to timestamp release artifacts, build outputs, audit logs, or any file you need to prove existed at a specific moment in time. Each stamp produces a tamper-proof PDF certificate with jurisdiction-specific legal framing (eIDAS Art. 41, IT Art. 2712 c.c., US FRE 901(b)(9), and 30+ more).

[bastamp.com](https://bastamp.com) · [API reference](https://bastamp.com/docs/api) · operated by Aletheia Tech Ltd.

## Quickstart

1. Create an API key at <https://bastamp.com/account/api-keys>.
2. Add it as a repository secret named `BASTAMP_API_KEY`.
3. Drop a workflow file:

```yaml
name: Stamp release

on:
  release:
    types: [published]

jobs:
  stamp:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: BA-BlockchainAnalysis/stamp-action@v1
        with:
          api-key: ${{ secrets.BASTAMP_API_KEY }}
          files: |
            dist/**/*.tar.gz
            CHANGELOG.md
```

That's it. The action hashes each file, posts the hashes to BA Stamp, and writes proofs to `bastamp-proofs.json` in the workspace.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | — | API key, format `ba_live_<32 hex>`. Mint at /account/api-keys. |
| `files` | yes | — | Newline-separated globs. |
| `jurisdiction` | no | — | ISO 3166-1 alpha-2 country code (e.g. `IT`, `US`). Drives the legal-framing block on the certificate PDF. |
| `locale` | no | `en` | BCP-47 locale for the PDF (`en`, `it`, `fr`, etc.). |
| `wait-for-anchor` | no | `false` | If `true`, poll until every stamp is anchored on Polygon (~5 min). Adds CI minutes; consider only for steps that need the cert immediately. |
| `poll-timeout-seconds` | no | `900` | How long to wait when `wait-for-anchor=true`. |
| `output-json` | no | `bastamp-proofs.json` | Where to write the proofs JSON. |
| `api-base` | no | `https://bastamp.com/api/v1` | Override for testing or self-host. |

## Outputs

| Name | Description |
|---|---|
| `stamps` | JSON-encoded array: `[{ ownershipId, stampId, contentHash, fileName, anchored, txHash, chain, blockNumber }]` |
| `pending-count` | Stamps still pending at exit. `0` when `wait-for-anchor=true` succeeded. |
| `anchored-count` | Stamps fully anchored at exit. |
| `credits-charged` | Total credits charged for this run. |

## Idempotency — safe to retry

The action submits batches with `Idempotency-Key: ${github.run_id}-chunk-${i}`. If you re-run a failed workflow:

- Same `run_id` → BA Stamp serves the cached response → **no double charge**.
- New `run_id` (different attempt) → fresh batch.

This means you can safely use `if: failure()` retry steps without worrying about double-billing.

## Examples

### Stamp every release artifact, attach proofs to the release

```yaml
on:
  release:
    types: [published]

jobs:
  stamp:
    runs-on: ubuntu-latest
    permissions:
      contents: write   # required to upload to the release
    steps:
      - uses: actions/checkout@v4
      - uses: BA-BlockchainAnalysis/stamp-action@v1
        with:
          api-key: ${{ secrets.BASTAMP_API_KEY }}
          files: |
            dist/*.tar.gz
            dist/*.zip
            dist/SHA256SUMS
          wait-for-anchor: true
          jurisdiction: IT

      - name: Attach proofs to release
        uses: softprops/action-gh-release@v2
        with:
          files: bastamp-proofs.json
```

### Stamp every commit on main

```yaml
on:
  push:
    branches: [main]

jobs:
  stamp:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: git archive --format=tar.gz HEAD -o source.tar.gz
      - uses: BA-BlockchainAnalysis/stamp-action@v1
        with:
          api-key: ${{ secrets.BASTAMP_API_KEY }}
          files: source.tar.gz
```

### Use the output in a downstream step

```yaml
      - uses: BA-BlockchainAnalysis/stamp-action@v1
        id: stamp
        with:
          api-key: ${{ secrets.BASTAMP_API_KEY }}
          files: build.zip

      - name: Notify Slack
        run: |
          echo '${{ steps.stamp.outputs.stamps }}' | jq '.[].contentHash' | xargs -I{} \
            curl -X POST $SLACK_WEBHOOK -H 'Content-Type: application/json' \
              -d '{"text":"Stamped: {}"}'
```

## Verifying the certificate later

Every stamped file produces a PDF certificate with a merkle proof and the on-chain anchor. Verification is trustless: any Polygon full node can confirm the timestamp.

The standalone open-source verifier is at [stamp-verify/stamp-verify](https://github.com/stamp-verify/stamp-verify).

## Pricing

Each call charges credits from your BA Stamp account. Buy packs at <https://bastamp.com/#pricing> — same packs apply whether you use the dashboard or this action.

## License

MIT — see [LICENSE](./LICENSE). Operated by Aletheia Tech Ltd, London, UK.
