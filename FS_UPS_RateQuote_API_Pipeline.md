# FS_UPS_RateQuote_API — quote pipeline (SnapLogic 4.44.1 GA)

**Pipeline:** `FS_UPS_RateQuote_API` · **Task:** `FS_UPS_RateQuote_API_Task` (Triggered, synchronous)
**Caller:** the Freshservice custom app (request template `getQuote`) · **Auth:** Triggered Task bearer token
**Input:** `{ "ticketId": 46, "requestId": "<uuid>" }` · **Writes:** nothing (read-only, safe to call again)

This guide replaces `claude_FS_UPS_RateQuote_API_Pipeline.md` in the project. What changed: the receiver is a Freshservice user picked in a lookup field; the Class is not part of the quote (the label pipeline reads the receiver's department and the Class when it creates the label); Shipper and Ship From are one sender; the response uses the `status` contract from `docs/09-api-contract.md` with a `shipmentSummary` and tagged options.

Status labels used below: **Confirmed** (vendor docs), **Tested** (logic run in Node.js against the exact expressions), **Verify** (check in Designer or the UPS test environment before go-live).

---

## 1. Solution overview

| Item | Detail |
|---|---|
| Objective | The agent clicks "Get delivery options" on a UPS Shipment Details child ticket and sees every UPS service with charge and arrival |
| Input | POST body with `ticketId` (the child ticket number) and an optional `requestId` |
| Output | One JSON envelope: `status` = `ok`, `invalid` or `error`, with options or problems |
| Calls | Freshservice: requested items and the receiver (requester). UPS: Rating `Shoptimeintransit`. OAuth token handled by the UPS account. No department or Class lookup |
| Writes | None |

### Data flow

1. Read the child ticket's requested items and pick the UPS Shipment Details item.
2. Clean and validate the form fields. Stop with `invalid` and a list of problems if anything is missing.
3. Read the receiver from the lookup field (by ID, or by email if the lookup returns an email) and take the name. Stop with `invalid` if the receiver isn't found or has no name.
4. Build the UPS rate request (sender = shipper = ship-from, residential flag, weight, ship date) and call UPS.
5. Turn the rated services into option cards, sort by price, tag "Lowest cost" and "Fastest".

The Class and the receiver's department are resolved only by the label pipeline, because they affect the label references and not the price.

## 2. Architecture diagram

```text
 Custom app ──POST {ticketId, requestId}──► Triggered Task FS_UPS_RateQuote_API_Task
                                              (Authorization: Bearer <task token>)
 [01] Parse request ► [02] Router ──invalid──► [E1] Invalid request
   ▼ valid
 [03] GET requested items ──error──► U1
 [04] Pick item ► [04a] Read form ► [04b] Validate form ► [05] Router ──invalid──► U2
   ▼
 [06] GET receiver ──error──► U1
 [07] Pick receiver ► [07a] Read receiver ► [07b] Validate ► [08] Router ──invalid──► U2
   ▼
 [12] Build rate request ► [13] POST UPS Rating ──error──► [E4] UPS error
   ▼
 [14] Build options ► [15] Router ──none──► [E5] No options
   ▼ ok
 [16] Success response

 U1 Union (FS error views) ► [E2] Freshservice error
 U2 Union (validation fails) ► [E3] Invalid shipment
 [16], [E1], [E2], [E3], [E4], [E5] ► [17] Union Response  (only unconnected output = HTTP response)
```

Exactly one unconnected input view (on 01) and one unconnected output view (on 17). Each request produces exactly one response document (Tested: every scenario returns one document).

## 3. Expression libraries

All logic lives in two libraries so the Snaps stay short and the label pipeline can reuse them.

| File | Contents | Per environment? |
|---|---|---|
| `fs_ups_config.expr` | Sender, shipper number, service item ID, Freshservice field keys, Class rule (label pipeline only), limits, defaults, service names, US states | Yes, one copy per environment |
| `fs_ups_fn.expr` | Functions (clean, pickItem, receiverRef, formProblems, buildRateRequest, option, tag, error mapping, …) | No, identical everywhere |

Upload both to the project: **Manager → project → Files → Add**. Then open the pipeline: **Pipeline Properties → Expression Libraries**, add both. Reference them as `lib.fs_ups_config.*` and `lib.fs_ups_fn.*`.

### 3.1 Fill in `fs_ups_config.expr`

| Key | What to enter |
|---|---|
| `sender.*` | The Roseville address, phone and attention name. **Confirm the ZIP**: the rate sample uses 95678, the invoice shows 95747 |
| `shipperNumber` | The UPS account number |
| `fs.serviceItemId` | The `service_item_id` of UPS Shipment Details, copied from `GET /api/v2/tickets/{n}/requested_items`. `null` takes the first item |
| `fsFields.*` | The real API keys of the service item fields. Read them once from the same call (keys under `custom_fields`) |
| `classRule.source` | Label pipeline only. `name` (department name is the Class) or `custom_field` (set `customFieldKey`) |
| `classRule.multiDepartment` | Label pipeline only. `fail` (default) or `first` |
| `defaults.declaredValue` | `null` sends no declared value. Set `999` if the client confirms |
| `allowedServiceCodes` | Empty shows every service UPS returns. List codes to restrict |
| `serviceNames` | Fallback names when UPS sends no description. **Verify** the codes in the UPS appendix |

Field values the pipeline expects from the form: State dropdown values must be 2-letter codes. Delivery type values are `Residential` and `Business` (empty uses `defaults.residential`). Weight is a plain number in lbs. Ship date is a Freshservice date (`YYYY-MM-DD`).

### 3.2 Why the libraries look the way they do

- SnapLogic expressions cannot hold statements, so every function is a single expression (no `return`, no `const`, no blocks). The test script rejects those patterns.
- No library function calls another library function. Mappers combine them instead.
- Optional paths use `.get(key, default)`, because plain dot access on a missing key fails.
- `toArray` handles UPS returning a single `RatedShipment` as an object instead of an array.
- **Verify:** arrow functions inside an expression library and the `.get`/`.extend` behavior in your 4.44.1 Designer. Run one Validate after uploading.

## 4. Pipeline parameters

Set these on the Task per environment, not in the pipeline.

| Parameter | Description | Example | Required | Default |
|---|---|---|---|---|
| `fsBaseUrl` | Freshservice account URL, no trailing slash | `https://pearce-sandbox.freshservice.com` | Yes | (none) |
| `upsBaseUrl` | UPS host. Test: wwwcie.ups.com. Production: onlinetools.ups.com | `https://wwwcie.ups.com` | Yes | https://wwwcie.ups.com |
| `upsRatingVersion` | Rating API version path segment | `v2409` | Yes | v2409 |
| `upsRequestOption` | Rating request option, used in the URL and the request body | `Shoptimeintransit` | Yes | Shoptimeintransit |
| `upsTransactionSrc` | Value of the UPS transactionSrc header | `FS-SnapLogic-Quote` | Yes | FS-SnapLogic-Quote |

Credentials never go in parameters. They live in the accounts below.

## 5. Accounts

| Account | Type | Settings | Notes |
|---|---|---|---|
| `FS_API_Basic_<ENV>` | API Suite **Basic Authentication Account** | Username = Freshservice API key of an integration agent; Password = `X` | For the quote, the agent's role must read tickets, requested items and requesters. The label pipeline will also read departments. **Verify** with one call each |
| `UPS_OAuth2_<ENV>` | Your existing UPS OAuth 2.0 client-credentials account | Token URL on `wwwcie.ups.com` (test) or `onlinetools.ups.com` (production) | Reuse the client's account if it already works. **Verify** the same UPS app works in both environments |

Use separate accounts for sandbox and production. Rotate the Freshservice API key and the UPS secret on a schedule (for example every 90 days).

## 6. Snap-by-snap configuration

Create the pipeline `FS_UPS_RateQuote_API`, then in **Pipeline Properties**: add both expression libraries (section 3), add the parameters (section 4), and set **Error Pipeline** to your shared error logger if you have one. It only catches unexpected Snap failures; expected errors are handled inline below.

### 6.1 Common settings

**Every Mapper:** Null-safe access ☑. Pass through as stated per Snap. A Mapper cannot read its own targets, which is why some steps are split into two or three Mappers.

**Every Router:** First match cleared. Each pair of conditions is mutually exclusive, so a document goes to exactly one view.

**Every HTTP Client** (API Suite). Field names follow the SnapLogic HTTP Client and REST Snap docs. **Verify** the exact labels in your Designer:

| Setting | Freshservice calls (03, 06) | UPS rate call (13) |
|---|---|---|
| Response entity type | DEFAULT (parses JSON into `$entity`) | DEFAULT |
| Connection timeout / read timeout | 10 s / 15 s | 10 s / 20 s |
| Retry policy | Connection errors and status codes 429 and 5xx | Connection errors and status codes 429 and 5xx (rating is read-only, so retrying is safe) |
| Maximum request attempts | 3 | 2 |
| Retry request interval | 2 s | 1 s |
| Normalize URL | ☑ | ☑ |
| Views → Error | Route Error Data to Error View | Route Error Data to Error View |

Keep the totals inside the app's request timeout: two Freshservice calls plus one UPS call normally take a few seconds, but retries add up. Measure it in the sandbox (see section 13).

**Carrying context through HTTP calls.** The design keeps everything in one object, `$ctx`. Each HTTP Client receives `$ctx` and the next Mapper restores it from `$original.ctx`. **Verify `$original`** in Designer preview on 03's output and error view. If your HTTP Client does not include `original`, put a **Copy** before the HTTP Client and a **Join** (Merge) after it, then read `$ctx` instead of `$original.ctx`.

### 6.2 Snaps in execution order

Snap numbers 09 to 11 are not used. They held the department and Class lookup, which moved to the label pipeline.

#### [01] Mapper — `01 Parse request`

Reads the POST body. Validates ticketId, keeps or creates a requestId, records today's date in the shipping time zone.

1. Add a **Mapper** and set the label to `01 Parse request`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `{"ticketIdRaw": lib.fs_ups_fn.clean($.get('ticketId')), "ticketId": lib.fs_ups_fn.validTicketId($.get('ticketId')) ? parseInt(lib.fs_ups_fn.clean($.get('ticketId')), 10) : null, "requestId": lib.fs_ups_fn.safeRequestId($.get('requestId')) != '' ? lib.fs_ups_fn.safeRequestId($.get('requestId')) : pipe.ruuid, "executionId": pipe.ruuid, "today": Date.now().toLocaleDateString({"format": "yyyyMMdd", "timeZone": lib.fs_ups_config.defaults.timeZone}), "stage": "items"}` | `$ctx` |

#### [02] Router — `02 Valid request?`

1. Add a **Router**, label `02 Valid request?`. Leave **First match** cleared; the conditions are mutually exclusive.
2. Routes:

| Expression | Output view | Connect to |
|---|---|---|
| `$ctx.ticketId != null` | `valid` | 03 |
| `$ctx.ticketId == null` | `invalid` | E1 |

#### [03] HTTP Client — `03 FS requested items`

Reads the requested items of the child ticket.

1. Add an **HTTP Client** (API Suite Snap Pack), label `03 FS requested items`.
2. **Account:** `FS_API_Basic_<ENV>`.
3. **Request method:** `GET`.
4. **Service URL** (expression ☑): `_fsBaseUrl + '/api/v2/tickets/' + $ctx.ticketId + '/requested_items'`
5. **HTTP headers:** `Accept` = `'application/json'`.
6. Apply the common HTTP Client settings in section 6.1.
7. **Views → Error:** Route Error Data to Error View, connected to U1.

#### [04] Mapper — `04 Pick item`

Selects the UPS Shipment Details item and restores the context from $original.

1. Add a **Mapper** and set the label to `04 Pick item`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `$original.ctx.extend({"item": lib.fs_ups_fn.pickItem($entity.get('requested_items'), lib.fs_ups_config.fs.serviceItemId)})` | `$ctx` |

#### [04a] Mapper — `04a Read form`

Turns the item's custom fields into one clean shipment object.

1. Add a **Mapper** and set the label to `04a Read form`.
2. **Null-safe access:** ☑. **Pass through:** ☑ (keeps $ctx and every other field).
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `{"itemFound": $ctx.item != null, "requestedItemId": $ctx.item == null ? null : $ctx.item.get('id'), "receiverRef": lib.fs_ups_fn.receiverRef(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.receiver)), "phone": lib.fs_ups_fn.normalizePhone(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.phone)), "line1": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.line1)), "line2": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.line2)), "city": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.city)), "state": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.state)).toUpperCase(), "zip": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.zip)), "residential": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.deliveryType)) == '' ? lib.fs_ups_config.defaults.residential : lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.deliveryType)).toLowerCase() != 'business', "weight": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.weight)), "shipDate": lib.fs_ups_fn.ymd(lib.fs_ups_fn.cf($ctx.item, lib.fs_ups_config.fsFields.shipDate), $ctx.today)}` | `$ctx.shipment` |

#### [04b] Mapper — `04b Validate form`

Lists every missing or invalid form field. Sets the stage for error mapping.

1. Add a **Mapper** and set the label to `04b Validate form`.
2. **Null-safe access:** ☑. **Pass through:** ☑ (keeps $ctx and every other field).
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `lib.fs_ups_fn.formProblems($ctx.shipment, lib.fs_ups_config, $ctx.today)` | `$ctx.problems` |
| `'receiver'` | `$ctx.stage` |

#### [05] Router — `05 Form complete?`

1. Add a **Router**, label `05 Form complete?`. Leave **First match** cleared; the conditions are mutually exclusive.
2. Routes:

| Expression | Output view | Connect to |
|---|---|---|
| `$ctx.problems.length == 0` | `complete` | 06 |
| `$ctx.problems.length > 0` | `invalid` | U2 |

#### [06] HTTP Client — `06 FS receiver`

Reads the receiver (requester) by ID, or looks them up by email.

1. Add an **HTTP Client** (API Suite Snap Pack), label `06 FS receiver`.
2. **Account:** `FS_API_Basic_<ENV>`.
3. **Request method:** `GET`.
4. **Service URL** (expression ☑): `lib.fs_ups_fn.requesterUrl(_fsBaseUrl, $ctx.shipment.receiverRef)`
5. **HTTP headers:** `Accept` = `'application/json'`.
6. Apply the common HTTP Client settings in section 6.1.
7. **Views → Error:** Route Error Data to Error View, connected to U1.

#### [07] Mapper — `07 Pick receiver`

Normalizes the two response shapes (by ID or by email) and restores the context.

1. Add a **Mapper** and set the label to `07 Pick receiver`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `$original.ctx.extend({"requester": lib.fs_ups_fn.requesterFrom($entity)})` | `$ctx` |

#### [07a] Mapper — `07a Read receiver`

Takes the receiver's name and email. The department is not needed for a quote.

1. Add a **Mapper** and set the label to `07a Read receiver`.
2. **Null-safe access:** ☑. **Pass through:** ☑ (keeps $ctx and every other field).
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `{"found": $ctx.requester != null, "id": $ctx.requester == null ? null : $ctx.requester.get('id'), "name": lib.fs_ups_fn.fullName($ctx.requester), "email": $ctx.requester == null ? null : $ctx.requester.get('primary_email')}` | `$ctx.receiver` |

#### [07b] Mapper — `07b Validate receiver`

Checks the receiver was found and has a name.

1. Add a **Mapper** and set the label to `07b Validate receiver`.
2. **Null-safe access:** ☑. **Pass through:** ☑ (keeps $ctx and every other field).
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `lib.fs_ups_fn.receiverProblems($ctx.receiver)` | `$ctx.problems` |
| `'ups'` | `$ctx.stage` |

#### [08] Router — `08 Receiver OK?`

1. Add a **Router**, label `08 Receiver OK?`. Leave **First match** cleared; the conditions are mutually exclusive.
2. Routes:

| Expression | Output view | Connect to |
|---|---|---|
| `$ctx.problems.length == 0` | `ok` | 12 |
| `$ctx.problems.length > 0` | `invalid` | U2 |

#### [12] Mapper — `12 Build rate request`

Builds the UPS Rating body from the shipment and the config library.

1. Add a **Mapper** and set the label to `12 Build rate request`.
2. **Null-safe access:** ☑. **Pass through:** ☑ (keeps $ctx and every other field).
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `lib.fs_ups_fn.buildRateRequest($ctx.shipment.extend({"receiverName": $ctx.receiver.name}), lib.fs_ups_config, {"requestOption": _upsRequestOption, "customerContext": $ctx.requestId})` | `$rateBody` |
| `lib.fs_ups_fn.transId($ctx.requestId)` | `$transId` |

#### [13] HTTP Client — `13 UPS rate`

Calls the UPS Rating API with time in transit.

1. Add an **HTTP Client** (API Suite Snap Pack), label `13 UPS rate`.
2. **Account:** `UPS_OAuth2_<ENV>`.
3. **Request method:** `POST`.
4. **Service URL** (expression ☑): `_upsBaseUrl + '/api/rating/' + _upsRatingVersion + '/' + _upsRequestOption`
5. **HTTP headers** (values as expressions):

| Key | Value |
|---|---|
| `Content-Type` | `'application/json'` |
| `Accept` | `'application/json'` |
| `transId` | `$transId` |
| `transactionSrc` | `_upsTransactionSrc` |

6. **Request body:** `$rateBody`.
7. Apply the common HTTP Client settings in section 6.1.
8. **Views → Error:** Route Error Data to Error View, connected to E4.

#### [14] Mapper — `14 Build options`

Turns RatedShipment into option cards: filter, sort by price, tag Lowest cost and Fastest.

1. Add a **Mapper** and set the label to `14 Build options`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `$original.ctx` | `$ctx` |
| `'' + $entity.get('RateResponse', {}).get('Response', {}).get('ResponseStatus', {}).get('Code', '')` | `$upsStatusCode` |
| `lib.fs_ups_fn.tag(lib.fs_ups_fn.toArray($entity.get('RateResponse', {}).get('RatedShipment')).map(r => lib.fs_ups_fn.option(r, lib.fs_ups_config)).filter(o => lib.fs_ups_fn.keepOption(o, lib.fs_ups_config.allowedServiceCodes)).sort((a, b) => a.amount - b.amount))` | `$options` |
| `lib.fs_ups_fn.toArray($entity.get('RateResponse', {}).get('Response', {}).get('Alert')).map(a => a.get('Description'))` | `$alerts` |

#### [15] Router — `15 Options found?`

1. Add a **Router**, label `15 Options found?`. Leave **First match** cleared; the conditions are mutually exclusive.
2. Routes:

| Expression | Output view | Connect to |
|---|---|---|
| `$upsStatusCode == '1' && $options.length > 0` | `ok` | 16 |
| `!($upsStatusCode == '1' && $options.length > 0)` | `none` | E5 |

#### [16] Mapper — `16 Success response`

Builds the success envelope the app displays.

1. Add a **Mapper** and set the label to `16 Success response`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `'ok'` | `$status` |
| `200` | `$httpStatus` |
| `$ctx.requestId` | `$requestId` |
| `$ctx.ticketId` | `$ticketId` |
| `$ctx.executionId` | `$quoteId` |
| `Date.now()` | `$quotedAt` |
| `{"receiverName": $ctx.receiver.name, "addressLines": [$ctx.shipment.line1, $ctx.shipment.line2].filter(l => l != ''), "city": $ctx.shipment.city, "state": $ctx.shipment.state, "zip": $ctx.shipment.zip, "residential": $ctx.shipment.residential, "weightLbs": parseFloat($ctx.shipment.weight), "shipDate": lib.fs_ups_fn.isoDate($ctx.shipment.shipDate)}` | `$shipmentSummary` |
| `$options` | `$options` |
| `$alerts` | `$alerts` |

#### [E1] Mapper — `E1 Invalid request`

Input: 02 invalid.

1. Add a **Mapper** and set the label to `E1 Invalid request`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `'invalid'` | `$status` |
| `400` | `$httpStatus` |
| `'INVALID_REQUEST'` | `$code` |
| `'Send ticketId as a positive whole number.'` | `$message` |
| `false` | `$retryable` |
| `$ctx.requestId` | `$requestId` |
| `null` | `$ticketId` |
| `[{"field": "ticketId", "message": "Send ticketId as a positive whole number."}]` | `$problems` |

#### [U1] Union — `U1 FS errors`

Collects the Freshservice error views into one input.

Inputs: error views of 03 and 06. Output → E2.

#### [E2] Mapper — `E2 Freshservice error`

Input: U1.

1. Add a **Mapper** and set the label to `E2 Freshservice error`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).status` | `$status` |
| `lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).httpStatus` | `$httpStatus` |
| `lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).code` | `$code` |
| `lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).message` | `$message` |
| `lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).retryable` | `$retryable` |
| `$original.ctx.requestId` | `$requestId` |
| `$original.ctx.ticketId` | `$ticketId` |
| `{"source": "FRESHSERVICE", "stage": $original.ctx.stage, "upstreamStatus": lib.fs_ups_fn.httpStatus($), "detail": lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).detail}` | `$error` |

#### [U2] Union — `U2 Invalid shipment`

Collects the validation failures into one input.

Inputs: invalid routes of 05 and 08. Output → E3.

#### [E3] Mapper — `E3 Invalid shipment`

Input: U2.

1. Add a **Mapper** and set the label to `E3 Invalid shipment`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `'invalid'` | `$status` |
| `422` | `$httpStatus` |
| `$ctx.problems.filter(p => p.field == 'item').length > 0 ? 'NOT_A_UPS_TICKET' : 'INVALID_SHIPMENT'` | `$code` |
| `$ctx.problems.map(p => p.message).join(' ')` | `$message` |
| `false` | `$retryable` |
| `$ctx.requestId` | `$requestId` |
| `$ctx.ticketId` | `$ticketId` |
| `$ctx.problems` | `$problems` |

#### [E4] Mapper — `E4 UPS error`

Input: 13 error view.

1. Add a **Mapper** and set the label to `E4 UPS error`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).status` | `$status` |
| `lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).httpStatus` | `$httpStatus` |
| `lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).code` | `$code` |
| `lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).message` | `$message` |
| `lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).retryable` | `$retryable` |
| `$original.ctx.requestId` | `$requestId` |
| `$original.ctx.ticketId` | `$ticketId` |
| `{"source": "UPS", "upstreamStatus": lib.fs_ups_fn.httpStatus($), "details": lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).details}` | `$error` |

#### [E5] Mapper — `E5 No options`

Input: 15 none.

1. Add a **Mapper** and set the label to `E5 No options`.
2. **Null-safe access:** ☑. **Pass through:** ☐.
3. Add these rows (Expression → Target path):

| Expression | Target path |
|---|---|
| `'error'` | `$status` |
| `502` | `$httpStatus` |
| `'UPS_NO_OPTIONS'` | `$code` |
| `'UPS returned no delivery options for this shipment.'` | `$message` |
| `false` | `$retryable` |
| `$ctx.requestId` | `$requestId` |
| `$ctx.ticketId` | `$ticketId` |
| `{"source": "UPS", "upsStatusCode": $upsStatusCode, "details": $alerts}` | `$error` |

#### [17] Union — `17 Response`

Single unconnected output view. The Triggered Task returns its documents as the response body.

Inputs: 16, E1, E2, E3, E4, E5. Leave the output view unconnected.


## 7. Triggered Task and authentication

**Manager → project → Create → Triggered Task:**

| Setting | Value | Why |
|---|---|---|
| Name | `FS_UPS_RateQuote_API_Task` | Becomes part of the URL. Avoid spaces and special characters; SnapLogic requires encoded characters in task URLs |
| Pipeline | `FS_UPS_RateQuote_API` | |
| Snaplex | Cloudplex | Freshworks servers must reach the URL. A Groundplex needs an inbound route |
| Bearer token | Keep the generated token, or replace it with a long random value (for example `openssl rand -hex 32`). **Never clear it** | Confirmed: callers send it as the HTTP `Authorization` header. A cleared field means the pipeline must authenticate requests itself |
| Pipeline parameters | Section 4 values for this environment | |
| Timeout | 1 minute | The minimum. It stops runaway executions |
| Do not start a new execution if one is already active | **Off** | Confirmed: when on, a second caller gets HTTP 409 |
| Record triggers / debug | Off in production | Recorded triggers store request data |

After saving, open **Task Details** and copy the **Cloudplex secured URL**. It has the form `https://<pod>.snaplogic.com/api/1/rest/slsched/feed/<Org>/<ProjectSpace>/<Project>/FS_UPS_RateQuote_API_Task` (**Verify** the pod and path on the details page).

Test it before touching the app:

```bash
curl -s -X POST "<task URL>" \
  -H "Authorization: Bearer <task token>" \
  -H "Content-Type: application/json" \
  -d '{"ticketId": 46, "requestId": "test-0001"}'
```

### Real HTTP status codes (optional)

By default a Triggered Task returns HTTP 200 with a JSON array of the output documents (Confirmed), so the outcome is in `status` and `httpStatus` inside the envelope. Platform failures still use real codes: 401 for a bad token, 5xx for an unhandled pipeline failure.

If you want real status codes, SnapLogic documents ending the pipeline with a **Document to Binary** Snap and a binary header named `status` holding the HTTP code. Keep the envelope approach for the first release; the app code below handles both, and you can switch later after testing.

## 8. Response contract

The body is a JSON array with one envelope. These examples were produced by the simulation from the exact expressions (options shortened).

**Success**

```json
[
  {
    "status": "ok",
    "httpStatus": 200,
    "requestId": "6f0c7a2e-1b2c-4d5e-8f90-0123456789ab",
    "ticketId": 46,
    "quoteId": "exec-0001",
    "quotedAt": "2026-10-22T17:00:00.000Z",
    "shipmentSummary": {
      "receiverName": "Jane Sample",
      "addressLines": [
        "100 Main St"
      ],
      "city": "Longwood",
      "state": "FL",
      "zip": "32779",
      "residential": true,
      "weightLbs": 5,
      "shipDate": "2026-10-26"
    },
    "options": [
      {
        "serviceCode": "03",
        "serviceName": "UPS Ground",
        "currency": "USD",
        "publishedAmount": 39.43,
        "negotiatedAmount": 35.1,
        "negotiated": true,
        "amount": 35.1,
        "arrivalDate": "2026-10-30",
        "arrivalTime": "23:00",
        "arrivalKey": "20261030230000",
        "dayOfWeek": "FRI",
        "businessDays": "4",
        "guaranteed": false,
        "alerts": [
          "Your invoice may vary from the displayed reference rates"
        ],
        "tags": [
          "Lowest cost"
        ]
      },
      {
        "...": "two more options"
      }
    ],
    "alerts": [
      "Your invoice may vary from the displayed reference rates"
    ]
  }
]
```

Option fields: `serviceCode`, `serviceName`, `currency`, `amount` (negotiated if UPS returned one, otherwise published), `publishedAmount`, `negotiatedAmount`, `negotiated`, `arrivalDate`, `arrivalTime` (`HH:MM`), `dayOfWeek`, `businessDays`, `guaranteed`, `alerts`, `tags` (`Lowest cost`, `Fastest`). `arrivalKey` is internal (sorting). The app decides how to word `arrivalTime`, for example "End of day" for Ground; **Verify** what UPS returns for Ground in the test environment.

**Invalid form**

```json
[
  {
    "status": "invalid",
    "httpStatus": 422,
    "code": "INVALID_SHIPMENT",
    "message": "Enter a 10-digit phone number. Enter a 5-digit ZIP code or ZIP+4.",
    "retryable": false,
    "requestId": "exec-0001",
    "ticketId": 46,
    "problems": [
      {
        "field": "phone",
        "message": "Enter a 10-digit phone number."
      },
      {
        "field": "zip",
        "message": "Enter a 5-digit ZIP code or ZIP+4."
      }
    ]
  }
]
```

| status | httpStatus | code | Meaning | App shows |
|---|---|---|---|---|
| `ok` | 200 | — | Options found | Cards |
| `invalid` | 400 | `INVALID_REQUEST` | Bad or missing ticketId | Generic error (app bug) |
| `invalid` | 404 | `TICKET_NOT_FOUND` | Ticket doesn't exist | Message |
| `invalid` | 422 | `NOT_A_UPS_TICKET` | No UPS Shipment Details item | Message |
| `invalid` | 422 | `INVALID_SHIPMENT` | Form or receiver problems, listed in `problems[]` | List of fixes |
| `invalid` | 422 | `RECEIVER_NOT_FOUND` | Receiver lookup failed | Message |
| `invalid` | 422 | `UPS_VALIDATION` | UPS rejected the data (UPS's own message) | Message |
| `error` | 502 | `FS_AUTH`, `UPS_AUTH` | Integration credentials problem | "Contact the integration team" |
| `error` | 503 / 502 | `FS_RATE_LIMITED`, `FS_UNAVAILABLE`, `UPS_UNAVAILABLE` | Temporary (`retryable: true`) | "Try again" button |
| `error` | 502 | `UPS_NO_OPTIONS` | UPS returned nothing usable | Message |

## 9. Calling it from the custom app

`config/iparams.json` (add):

```json
"snaplogic_host": { "display_name": "SnapLogic host", "type": "text", "required": true, "description": "Host only, for example elastic.snaplogic.com" },
"snaplogic_quote_path": { "display_name": "Quote task path", "type": "text", "required": true, "description": "/api/1/rest/slsched/feed/<Org>/<ProjectSpace>/<Project>/FS_UPS_RateQuote_API_Task" },
"snaplogic_token": { "display_name": "SnapLogic task token", "type": "text", "required": true, "secure": true }
```

`config/requests.json` (add):

```json
"getQuote": {
  "schema": {
    "method": "POST",
    "host": "<%= iparam.snaplogic_host %>",
    "path": "<%= iparam.snaplogic_quote_path %>",
    "headers": {
      "Authorization": "Bearer <%= iparam.snaplogic_token %>",
      "Content-Type": "application/json"
    }
  },
  "options": { "maxAttempts": 1 }
}
```

`manifest.json`: add `"getQuote": {}` under `modules.common.requests`.

`modal.js` (core call):

```js
async function getQuote(client, ticketNumber) {
  const requestId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : String(Date.now());
  try {
    const res = await client.request.invokeTemplate("getQuote", {
      body: JSON.stringify({ ticketId: ticketNumber, requestId: requestId })
    });
    const body = JSON.parse(res.response);
    const envelope = Array.isArray(body) ? body[0] : body;
    return envelope || { status: "error", message: "Empty response from SnapLogic." };
  } catch (err) {
    // 401: bad task token. 5xx: pipeline failed. Timeouts also land here.
    return { status: "error", message: "The quote service didn't respond (" + (err && err.status ? err.status : "no status") + ")." };
  }
}
```

The secure token stays in the request header, which the Freshworks request method allows for secure install settings. `maxAttempts: 1` avoids repeated quotes on slow responses; the pipeline already retries its own calls.

## 10. Error handling summary

| Layer | Condition | Behavior |
|---|---|---|
| Platform | Missing or wrong bearer token | SnapLogic returns 401; the pipeline does not run |
| 01–02 | ticketId missing, not a number, 0, or over 12 digits | `INVALID_REQUEST`, no calls |
| 03 | Ticket missing | `TICKET_NOT_FOUND` |
| 04–05 | No UPS item, or form problems | `NOT_A_UPS_TICKET` or `INVALID_SHIPMENT` with every problem listed |
| 06–08 | Receiver missing or has no name | `INVALID_SHIPMENT` (or `RECEIVER_NOT_FOUND` on 404). The department is not checked |
| 03, 06 | Freshservice 401/403, 429, 5xx | Retries per 6.1, then `FS_AUTH`, `FS_RATE_LIMITED` or `FS_UNAVAILABLE` |
| 13 | UPS 400 | `UPS_VALIDATION` with UPS's message, no retry |
| 13 | UPS 401/403, 429, 5xx, timeout | Retries per 6.1, then `UPS_AUTH` or `UPS_UNAVAILABLE` |
| 15 | UPS status not 1, or no usable option | `UPS_NO_OPTIONS` with UPS alerts |
| Any | Unexpected Snap failure | Error pipeline logs it; the task returns 5xx; the app shows its generic message |

Every response carries `requestId` (from the app) and `quoteId` (the SnapLogic execution ID), so support can find the run in Monitor.

## 11. Performance

- Calls per quote: 2 Freshservice + 1 UPS (plus the OAuth token when it expires).
- Documents: one small document per request. No pagination, batching or parallel paths needed.
- Freshservice rate limits apply per account per minute; agent clicks are far below them.
- Latency: task start, two Freshservice calls in sequence, then one UPS call. If the total is too slow for the app, tune the retry attempts and timeouts in 6.1 first. Keep the data reading in SnapLogic.

## 12. Security

- The app holds only the task URL and token, as install settings (token secure). It never sees Freshservice or UPS credentials.
- Freshservice and UPS credentials live in encrypted SnapLogic accounts, never in parameters or libraries.
- The pipeline trusts nothing from the body except `ticketId` and `requestId`, both validated and sanitized.
- Read-only: a repeated quote changes nothing.
- Separate tasks, tokens and accounts per environment. Debug recording off in production.
- The receiver's name and address appear in `shipmentSummary` for the agent to confirm. Agents can already see them on the ticket.

## 13. Testing

**Automated (Node.js 18+), from the repo root:**

```bash
node snaplogic/tests/test_expressions.js        # 27 groups: every library function + syntax check
node snaplogic/tests/simulate_quote_pipeline.js  # 14 end-to-end scenarios with mocked HTTP responses
```

These prove the logic of the exact expressions in this guide. They do not prove SnapLogic accepts the syntax or that the real APIs return these shapes.

**In Designer:** put a JSON Generator with `[{"ticketId": 46, "requestId": "test-0001"}]` in front of 01, Validate, and check each Snap's preview. Remove the JSON Generator afterwards; a pipeline with a connected input won't receive the task body.

| # | Setup | Expected |
|---|---|---|
| T1 | Complete UPS ticket | `ok`, options sorted by price, receiver name in the summary |
| T2 | `{"ticketId": "abc"}` | `invalid`, `INVALID_REQUEST`, no calls in the run log |
| T3 | Ticket number that doesn't exist | `TICKET_NOT_FOUND` |
| T4 | A service request without the UPS item | `NOT_A_UPS_TICKET` |
| T5 | Wrong phone and empty ZIP | `INVALID_SHIPMENT` listing phone and zip |
| T6 | Receiver with no department | `ok` (the quote ignores the department) |
| T7 | Receiver not found (deleted user) | `RECEIVER_NOT_FOUND` |
| T8 | ZIP that doesn't match the state | `UPS_VALIDATION` with UPS's message |
| T9 | Wrong UPS secret | `UPS_AUTH` |
| T10 | Wrong Freshservice key | `FS_AUTH` |
| T11 | Missing bearer token | HTTP 401 from SnapLogic |
| T12 | Two agents at once | Both succeed (no 409) |
| T13 | Time the T1 call | Note it against the app's request timeout |

## 14. Deployment

| Item | Dev | Test | Prod |
|---|---|---|---|
| Pipeline | Built here | Promoted | Promoted |
| `fs_ups_fn.expr` | ✓ | Same | Same |
| `fs_ups_config.expr` | Sandbox item ID and field keys, test shipper | Same as Dev | Production item ID, field keys, shipper |
| `FS_API_Basic_<ENV>` | Sandbox key | Sandbox key | Production key |
| `UPS_OAuth2_<ENV>` | UPS test environment | UPS test environment | Production |
| Task and token | Own | Own | Own |
| `upsBaseUrl` | `https://wwwcie.ups.com` | Same | `https://onlinetools.ups.com` |
| App install settings | Dev URL and token | Test | Prod |

**Go-live checklist**

- [ ] Real field keys and service item ID in `fs_ups_config.expr`; sender ZIP confirmed
- [ ] Class rule confirmed with the client (needed for the label pipeline, not the quote)
- [ ] Every **Verify** item in section 15 checked
- [ ] Node tests pass; T1–T13 pass in Test
- [ ] Task "do not start" option off; debug off in Prod
- [ ] Token rotation date in the operations calendar

## 15. What is confirmed and what to verify

**Confirmed (vendor docs):** bearer token in the `Authorization` header; a cleared token means the pipeline authenticates; one unconnected output view returned as a JSON array; a POST object becomes one input document; the "do not start" option returns 409; minimum task timeout 1 minute; the Document to Binary `status` header option; HTTP Client is recommended over REST Snaps; `encodeURIComponent` for URL parts.

**Tested (Node.js):** every library function, every Mapper and Router expression, and 14 end-to-end scenarios.

**Verify before go-live:**

1. `$original` on HTTP Client output and error documents, and the error document fields (`error`, `reason`, `error_entity`). If `error_entity` is a string, the UPS and Freshservice messages fall back to generic text.
2. `Date.now().toLocaleDateString({"format": "yyyyMMdd", "timeZone": ...})` returns `yyyyMMdd`.
3. Pass-through Mappers writing nested targets such as `$ctx.problems`.
4. Expression library syntax: arrow functions and `.extend` in 4.44.1. Default `.sort()` on strings sorts ascending.
5. The Freshservice lookup field value format (ID, email or object) and the requester response shapes (`requester`, `requesters`). Department shapes are checked with the label pipeline.
6. Freshservice `GET /api/v2/requesters?email=` returns `{ "requesters": [...] }`.
7. UPS: request option casing (`Shoptimeintransit` in the URL and body; your sample used `shopTimeInTransit`), `DeliveryTimeInformation.Pickup.Date`, `ResidentialAddressIndicator`, and the response leaf names under `TimeInTransit` and `GuaranteedDelivery`.
8. The service code names in `serviceNames`.
9. The app's request timeout against the measured T13 time.
