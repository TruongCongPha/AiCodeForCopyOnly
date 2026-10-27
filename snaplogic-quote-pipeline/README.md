# SnapLogic assets

| Path | What it is |
|---|---|
| `specs/FS_UPS_RateQuote_API.md` | Build guide for the quote pipeline and its Triggered Task (Snap by Snap) |
| `specs/quote-pipeline-expressions.js` | Every Mapper, Router and HTTP Client expression of the quote pipeline. The single source of truth |
| `expression-libraries/fs_ups_config.expr` | Per-environment settings. Upload one copy per environment |
| `expression-libraries/fs_ups_fn.expr` | Shared functions. Identical in every environment; reused by the label pipeline later |
| `tests/test_expressions.js` | Tests every library function and rejects syntax SnapLogic expressions don't support |
| `tests/simulate_quote_pipeline.js` | Runs the pipeline's expressions end to end against mocked Freshservice and UPS responses |
| `samples/` | A real UPS RatedShipment (amount checks), a synthetic UPS response, and the simulated quote responses shown in the guide |

Run the checks (Node.js 18 or later) from the repo root:

    node snaplogic/tests/test_expressions.js
    node snaplogic/tests/simulate_quote_pipeline.js

If you change an expression, change it in `quote-pipeline-expressions.js` or the library first, rerun both scripts, then copy it into Designer.

Never put real account numbers, tokens or API keys in this folder. `fs_ups_config.expr` holds a placeholder shipper number; keep the real value only in the copy uploaded to SnapLogic.
