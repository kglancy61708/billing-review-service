# billing-review-service

Runs the monthly WM billing review on a schedule (noon Central on the 15th by default) and posts it to Slack #ar.

Each run:
1. Lists the Box "Billing Review" folder and takes the `.xlsx` files modified in the last 3 days.
2. Classifies each by its columns: three one-month invoice exports (last / this / next month) plus the control-forms export.
3. Refuses any invoice file with ~10,000 rows (NetSuite's export cap) before touching history.
4. Merges the invoice months into `wm-billing-history.csv` (stored in the same Box folder): months in the new files replace the stored months, older months stay.
5. Flags customers (OK / SEASONAL / LOST / REVIEW), builds the workbook, uploads it to Slack with a summary.
Missing files, truncated files and errors are posted to the channel instead.

## Environment variables (Railway)
| Name | Purpose |
|---|---|
| `BOX_CONFIG_JSON` | Full contents of the Box app's JWT config JSON |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) with `chat:write`, `files:write` |
| `SLACK_CHANNEL_ID` | `CB12MAXC4` (#ar) |
| `BOX_FOLDER_ID` | optional, default `406564573839` |
| `REVIEW_CRON` / `REVIEW_TZ` | optional, default `0 12 15 * *` / `America/Chicago` |
| `MAX_FILE_AGE_DAYS` | optional, default 3 |

## Commands
- `npm test` — parity + end-to-end tests (some need local sample files and skip without them)
- `node src/index.js --dry-run` — runs against Box, writes the workbook to `./out`, posts nothing, saves nothing
- `node src/index.js --run-now` — real run now (posts to Slack, updates history)
- `node scripts/seed-history.js <monthly-totals.csv>` — one-time history upload
