# FS → UPS Rate Quote API — SnapLogic Implementation Guide

**Pipeline:** `FS_UPS_RateQuote_API` · **Task:** `FS_UPS_RateQuote_API_Task` (Triggered, synchronous) · **Target:** SnapLogic 4.44.1 GA
**Caller:** Freshservice Custom App (FDK request method, server-side template) · **Auth:** Triggered Task bearer token held in a secure iparam
**Response mode:** return rates only; nothing is written back to Freshservice

> Items marked **⚠ Verify** could not be confirmed from vendor docs for this exact release. Check them in Designer/Manager or on the UPS/Freshworks portal before go-live.

---

## 1. Solution Overview

| Item | Detail |
|---|---|
| Business objective | An agent clicks **Get UPS Quote** on a child ticket. The app shows every UPS service with its published rate, negotiated rate and transit time, so the agent can choose a service before the shipment is created. |
| Input | `POST { "ticketId": 330134 }`, where `ticketId` is the child ticket's display ID |
| Output | A single JSON envelope: `success`, `httpStatus`, `ticketId`, `requestId`, `data.rates[]` or `error{}` |
| Dependencies | Freshservice API v2 (Tickets), the UPS OAuth 2.0 client-credentials flow, the UPS Rating API (`Shoptimeintransit`), and a SnapLogic Cloudplex or Groundplex |
| Writes | None, so the API is idempotent and safe to call repeatedly |

### Where the Ship-To and package data comes from

The best source is the **child ticket's custom fields**, read with **one** call: `GET /api/v2/tickets/{id}?include=requester`.

- The Ship-To name, address lines, city, state, ZIP, country and package weight come from the ticket's `custom_fields`. Your invoice shows each shipment going to a specific person and address, and that data belongs to the ticket. The requester profile only has a single free-text address, so it can't be parsed reliably.
- If the Ship-To name or phone custom fields are empty, the pipeline falls back to the embedded **requester** name and phone.
- Shipper and Ship-From (for example, Pearce Roseville IT, 9000 Foothills Blvd) are fixed per environment, so they live in an **Expression Library** and are not stored on the ticket.
- The custom-field API names are **not hard-coded in the pipeline**. They are mapped in `ups_rate_config.expr`. To get your real field names, call `GET /api/v2/ticket_form_fields` once and copy the `name` values.

Cost: 2 Freshservice API credits (1 for the ticket and 1 for the `requester` embed) and 1 UPS Rating call. The UPS OAuth token is cached and refreshed by the account.

---

## 2. Architecture Diagram

```text
 Freshservice Custom App (ticket sidebar)
   client.request.invokeTemplate("getUpsQuote", { body: {"ticketId": 330134} })
      │  HTTPS POST  Authorization: Bearer <secure iparam>
      ▼
 SnapLogic Triggered Task  FS_UPS_RateQuote_API_Task   (bearer token validated by platform)
      │  request body → unconnected input view
      ▼
 [01] Mapper  Validate Request
      ▼
 [02] Router  Request Valid?
      ├─ invalid ──────────────────────────────────────────────► [E1] Mapper 400 Response ─┐
      ▼ valid                                                                             │
 [03] HTTP Client  FS Get Ticket  (GET /api/v2/tickets/{id}?include=requester)            │
      ├─ error view ───────────────────────────────────────────► [E2] Mapper FS Error ─────┤
      ▼                                                                                   │
 [04] Mapper  Extract Ship-To & Package  → [04b] Mapper  Validate Ship-To                │
      ▼                                                                                   │
 [05] Router  Ship-To Complete?                                                           │
      ├─ missing fields ───────────────────────────────────────► [E3] Mapper 422 Response ─┤
      ▼ complete                                                                          │
 [06] Mapper  Build UPS RateRequest                                                       │
      ▼                                                                                   │
 [07] HTTP Client  UPS Rate Shop  (POST /api/rating/{ver}/Shoptimeintransit, OAuth2)      │
      ├─ error view ───────────────────────────────────────────► [E4] Mapper UPS Error ────┤
      ▼                                                                                   │
 [08] Mapper  Normalize Rates                                                             │
      ▼                                                                                   │
 [09] Router  UPS Success?                                                                │
      ├─ no rates / ResponseStatus≠1 ──────────────────────────► [E5] Mapper No Rates ─────┤
      ▼                                                                                   │
 [10] Mapper  Success Response ────────────────────────────────────────────────────────────┤
                                                                                          ▼
                                                              [11] Union  Response  (only unconnected output view)
                                                                                          │
                                                                        HTTP 200 body: [ { envelope } ]
```

There is exactly **one** unconnected input view (on Snap 01) and **one** unconnected output view (on Snap 11). A Triggered Task returns the documents from the unconnected output view as the response body.

---

## 3. Prerequisites: Expression Libraries

Expression Libraries keep every environment-specific value and all reusable logic out of the Snaps. Upload both files to the **project** (or the shared project space) in each environment.

**Manager → Project → Create → File → Upload.** Then open the pipeline in **Designer → Pipeline Properties → Expression Libraries** and add `ups_rate_config.expr` and `ups_rate_fn.expr`. You reference them as `lib.ups_rate_config.*` and `lib.ups_rate_fn.*`.

### 3.1 `ups_rate_config.expr` (one copy per environment)

```javascript
{
  "shipper": {
    "name": "Pearce Shipment",
    "shipperNumber": "2XD198",
    "address": { "AddressLine": ["9000 Foothills Blvd"], "City": "Roseville", "StateProvinceCode": "CA", "PostalCode": "95747", "CountryCode": "US" }
  },
  "shipFrom": {
    "name": "Pearce Roseville - IT",
    "address": { "AddressLine": ["9000 Foothills Blvd"], "City": "Roseville", "StateProvinceCode": "CA", "PostalCode": "95747", "CountryCode": "US" }
  },
  "fsFields": {
    "shipToName":   "ship_to_name",
    "shipToPhone":  "ship_to_phone",
    "line1":        "ship_to_address_line_1",
    "line2":        "ship_to_address_line_2",
    "city":         "ship_to_city",
    "state":        "ship_to_state",
    "postal":       "ship_to_zip",
    "country":      "ship_to_country",
    "weightLbs":    "package_weight_lbs"
  },
  "defaults": { "country": "US", "weightLbs": "5", "packagingCode": "02", "residential": true },
  "serviceNames": {
    "01": "UPS Next Day Air", "02": "UPS 2nd Day Air", "03": "UPS Ground", "12": "UPS 3 Day Select",
    "13": "UPS Next Day Air Saver", "14": "UPS Next Day Air Early", "59": "UPS 2nd Day Air A.M.",
    "07": "UPS Worldwide Express", "08": "UPS Worldwide Expedited", "11": "UPS Standard",
    "54": "UPS Worldwide Express Plus", "65": "UPS Worldwide Saver"
  }
}
```

The `fsFields` values are placeholders. Replace them with your real Freshservice field API names from `GET /api/v2/ticket_form_fields`. Use the CIE/test shipper in Dev and Test, and the production shipper in Prod.

### 3.2 `ups_rate_fn.expr` (identical in every environment)

```javascript
{
  "clean": x => (x == null ? '' : ('' + x).trim()),

  "cf": (ticket, key) => ((ticket == null || ticket.get('custom_fields') == null) ? null : ticket.custom_fields.get(key)),

  "toArray": x => (x == null ? [] : (x instanceof Array ? x : [x])),

  "validTicketId": x => (('' + x).trim().match(/^[1-9][0-9]{0,11}$/) != null),

  "ymd": d => ((d == null || ('' + d).length != 8) ? null : ('' + d).substring(0, 4) + '-' + ('' + d).substring(4, 6) + '-' + ('' + d).substring(6, 8)),

  "rate": (r, names) => ({
    "serviceCode": r.Service.Code,
    "serviceName": names.get(r.Service.Code, 'UPS Service ' + r.Service.Code),
    "currency": r.get('TotalCharges', {}).get('CurrencyCode'),
    "publishedRate": r.get('TotalCharges') == null ? null : parseFloat(r.TotalCharges.MonetaryValue),
    "negotiatedRate": r.get('NegotiatedRateCharges') == null ? null : parseFloat(r.NegotiatedRateCharges.get('TotalCharge', {}).get('MonetaryValue')),
    "billingWeight": r.get('BillingWeight', {}).get('Weight'),
    "businessDaysInTransit": r.get('TimeInTransit', {}).get('ServiceSummary', {}).get('EstimatedArrival', {}).get('BusinessDaysInTransit', r.get('GuaranteedDelivery', {}).get('BusinessDaysInTransit')),
    "estimatedArrivalDate": r.get('TimeInTransit', {}).get('ServiceSummary', {}).get('EstimatedArrival', {}).get('Arrival', {}).get('Date'),
    "estimatedArrivalTime": r.get('TimeInTransit', {}).get('ServiceSummary', {}).get('EstimatedArrival', {}).get('Arrival', {}).get('Time'),
    "alerts": (r.get('RatedShipmentAlert') == null ? [] : (r.RatedShipmentAlert instanceof Array ? r.RatedShipmentAlert : [r.RatedShipmentAlert])).map(a => a.get('Description'))
  }),

  "effective": rt => (rt.negotiatedRate != null && !isNaN(rt.negotiatedRate) ? rt.negotiatedRate : rt.publishedRate),

  "httpStatus": e => (e.get('status_code') != null ? parseInt('' + e.status_code, 10) : (('' + e.get('error', '') + ' ' + e.get('reason', '')).match(/status code\s*[=:]?\s*(\d{3})/i) != null ? parseInt((('' + e.get('error', '') + ' ' + e.get('reason', '')).match(/status code\s*[=:]?\s*(\d{3})/i))[1], 10) : null)),

  "upsErrors": ent => ((ent instanceof Object && ent.get('response') instanceof Object && ent.response.get('errors') instanceof Array) ? ent.response.errors : []),

  "fsErrorMsg": ent => (ent instanceof Object ? ent.get('message', ent.get('description', null)) : (ent == null ? null : ('' + ent)))
}
```

Notes on why the library is written this way:

- `toArray` handles a known UPS JSON quirk: a repeating element that has only **one** item comes back as an object instead of an array. This applies to `RatedShipment` and `RatedShipmentAlert`. Without `toArray`, `.map()` fails whenever UPS returns a single service.
- `.get(key, default)` is used for every optional path. Plain dot access on a missing key raises an error in SnapLogic.
- No library function calls another library function, which avoids any dependency on cross-reference behavior inside a library.
- `httpStatus`: the error-view document for HTTP errors carries `error`, `reason`, `error_entity` and `original`. The status-code field name is **⚠ Verify**, so the function first reads `status_code` and then falls back to parsing "status code = NNN" from the error text.
- The logic was unit-tested in Node.js against Shop responses (with an array and with a single object), negotiated and non-negotiated rates, alert objects and arrays, and UPS and Freshservice error bodies. All tests passed. Before go-live, re-run one Validate in Designer, because SnapLogic expression semantics differ from JavaScript in a few places.

---

## 4. Pipeline Parameters

Pipeline Properties → Parameters. Set the values per environment on the Task. Do not edit them in the pipeline.

| Parameter | Description | Example | Required | Default |
|---|---|---|---|---|
| `fsBaseUrl` | Freshservice tenant URL with no trailing slash | `https://pearce.freshservice.com` | Yes | — |
| `upsBaseUrl` | UPS host | `https://wwwcie.ups.com` (CIE) / `https://onlinetools.ups.com` (Prod) | Yes | `https://wwwcie.ups.com` |
| `upsRatingVersion` | Rating API version path segment | `v2409` | Yes | `v2409` |
| `upsRequestOption` | `Shoptimeintransit` (all services plus transit time), `Shop`, `Rate` or `Ratetimeintransit` | `Shoptimeintransit` | Yes | `Shoptimeintransit` |
| `upsTransactionSrc` | Value for the UPS `transactionSrc` header | `FS-SnapLogic-Quote` | Yes | `FS-SnapLogic-Quote` |

Credentials are **never** stored in parameters. They live in the two Accounts below.

---

## 5. Required Accounts

### 5.1 `FS_API_Basic` (HTTP Client → **Basic Authentication Account**)

| Field | Value |
|---|---|
| Label | `FS_API_Basic_<ENV>` |
| Username | Freshservice API key of a dedicated **integration agent** |
| Password | `X` (Freshservice ignores it; API-key Basic auth is the only supported Basic scheme) |

- **Permissions:** the agent needs a role that can **view tickets** in the groups and workspaces where child tickets live. Read access is enough; no write permissions are needed.
- **Environment:** use a separate agent and key for the sandbox and for production.
- **Security:** the account is encrypted at rest by SnapLogic. Rotate the key every 90 days. If the integration agent is deactivated, the key stops working.

### 5.2 `UPS_OAuth2_CC` (HTTP Client → **OAuth2 Client Credentials Account**)

| Field | Value |
|---|---|
| Label | `UPS_OAuth2_CC_<ENV>` |
| Client ID / Client secret | From the UPS Developer Portal app (the app must have the **Rating** product added) |
| Token endpoint | `{upsBaseUrl}/security/v1/oauth/token`, entered as a literal (for example `https://wwwcie.ups.com/security/v1/oauth/token`) |
| Grant type | `client_credentials` |
| Client authentication | Send the client ID and secret as a **Basic Auth header**. UPS requires `Authorization: Basic base64(id:secret)` and the form body `grant_type=client_credentials` |
| Token endpoint header (optional) | `x-merchant-id: <shipper number>` |
| Auto-refresh token | Enabled. UPS tokens last about 4 hours (`expires_in` ≈ 14399 seconds) |

- ⚠ **Verify** the exact field labels for the OAuth2 Client Credentials Account in the 4.44.1 API Suite.
- **Fallback** if your build can't send client credentials as a Basic header: create a child pipeline `UPS_Get_Token` with an HTTP Client POST to the token endpoint, using a Basic Authentication Account (ID and secret) and a form-encoded body. Call it with **Pipeline Execute** set to *Reuse executions* and cache the token in an upstream Mapper. Avoid this unless you need it.
- **Security:** keep separate UPS apps for CIE and production, and rotate the secret in the UPS portal. The shipper number in the expression library is an identifier, not a secret.

---

## 6. Pipeline Flow: Snap-by-Snap Configuration

**Before you start:** create the pipeline `FS_UPS_RateQuote_API` → **Pipeline Properties**:

- Add both Expression Libraries.
- Add the parameters from section 4.
- Set **Error Pipeline** to your shared `Common_Error_Logger` (if you have one), with the parameter `source = 'FS_UPS_RateQuote_API'`. This catches only unexpected Snap failures; expected errors are handled inline below.

### [01] Mapper — `Validate Request`

**Purpose:** normalizes the request body and fails fast on a bad `ticketId` before any API call. Its input view stays **unconnected**, so the task feeds it the POST body.

1. Drag a **Mapper** onto the canvas and set the label to `01 Validate Request`.
2. **Views tab:** keep 1 input and 1 output, and leave the input unconnected.
3. **Null-safe access:** ☑ (a missing `ticketId` becomes null instead of throwing).
4. **Pass through:** ☐
5. Mapping table:

| Expression | Target path |
|---|---|
| `lib.ups_rate_fn.validTicketId($.get('ticketId', '')) ? parseInt(('' + $.ticketId).trim(), 10) : null` | `$ticketId` |
| `'' + $.get('ticketId', '')` | `$ticketIdRaw` |
| `pipe.ruuid` | `$requestId` |

6. **Error handling (Views → Error):** Stop Pipeline Execution. Unexpected errors go to the Error Pipeline.

Input `{ "ticketId": 330134 }` → output `{ "ticketId": 330134, "ticketIdRaw": "330134", "requestId": "…" }`.
Input `{ "ticketId": "abc" }` → output `{ "ticketId": null, … }`.

### [02] Router — `Request Valid?`

1. Add a **Router** labeled `02 Request Valid?`.
2. Add two routes:

| Expression | Output view |
|---|---|
| `$ticketId != null` | `valid` |
| `$ticketId == null` | `invalid` |

3. Leave **First Match** cleared. The two conditions are mutually exclusive, so each document goes to exactly one view.
4. Connect `valid` → [03] and `invalid` → [E1].

### [E1] Mapper — `400 Invalid Request`

| Expression | Target path |
|---|---|
| `false` | `$success` |
| `400` | `$httpStatus` |
| `null` | `$ticketId` |
| `$requestId` | `$requestId` |
| `{ "code": "INVALID_REQUEST", "source": "API", "message": "ticketId is required and must be a positive integer (Freshservice display ID).", "details": [ { "received": $ticketIdRaw } ] }` | `$error` |

Connect its output to Union [11] input0.

### [03] HTTP Client — `FS Get Ticket`

**Purpose:** reads the child ticket and its embedded requester in one call.

1. Add **HTTP Client** (API Suite Snap Pack) labeled `03 FS Get Ticket`.
2. **Account:** `FS_API_Basic_<ENV>`.
3. **Request method:** `GET`.
4. **Request URL** (expression ☑): `_fsBaseUrl + '/api/v2/tickets/' + $ticketId`
5. **Query parameters:** `include` = `requester`
6. **HTTP headers:** `Accept` = `application/json`
7. **Retry policy** (⚠ Verify labels): retry on connection errors **and** status `429` / `5xx`; maximum attempts **3**; interval **2 s** with exponential backoff; honor `Retry-After` if your build offers that option. Freshservice returns `Retry-After` on 429.
8. **Timeouts:** connection 10 s, read 15 s. Keep the total under the FDK request timeout (see section 10).
9. **Response entity type:** Default (JSON is parsed into `$entity`).
10. **Views → Error:** **Route Error Data to Error View**, connected to [E2].

On success the output is `{ statusLine: {statusCode: 200,…}, headers: {…}, entity: { ticket: { id, subject, custom_fields: {…}, requester: { id, name, email, phone, mobile } } } }`.

### [E2] Mapper — `FS Error Response`

The input is the HTTP Client error document (`error`, `reason`, `error_entity`, `original`). `$original` is the document that entered Snap 03, so `ticketId` and `requestId` are still available.

| Expression | Target path |
|---|---|
| `false` | `$success` |
| `lib.ups_rate_fn.httpStatus($) == 404 ? 404 : (lib.ups_rate_fn.httpStatus($) == 401 \|\| lib.ups_rate_fn.httpStatus($) == 403 ? 502 : (lib.ups_rate_fn.httpStatus($) == 429 ? 503 : 502))` | `$httpStatus` |
| `$original.get('ticketId')` | `$ticketId` |
| `$original.get('requestId')` | `$requestId` |
| `{ "code": lib.ups_rate_fn.httpStatus($) == 404 ? "TICKET_NOT_FOUND" : (lib.ups_rate_fn.httpStatus($) == 429 ? "FS_RATE_LIMITED" : "FS_API_ERROR"), "source": "FRESHSERVICE", "upstreamStatus": lib.ups_rate_fn.httpStatus($), "message": lib.ups_rate_fn.fsErrorMsg($.get('error_entity')) != null ? lib.ups_rate_fn.fsErrorMsg($.get('error_entity')) : $.get('reason', $.get('error')) }` | `$error` |

Mapping 401/403 to 502 is deliberate: Freshservice credential problems are a server-side fault, and the agent should not see an authentication error. → Union input1.

### [04] Mapper — `Extract Ship-To & Package`

**Purpose:** flattens and cleans the ticket into a canonical shape. This is the only Snap that knows about Freshservice field names, and it reads them through the config library.

Null-safe access ☑, Pass through ☐.

| Expression | Target path |
|---|---|
| `$entity.ticket.id` | `$ticketId` |
| `pipe.ruuid` | `$requestId` |
| `$entity.ticket.get('subject')` | `$ticketSubject` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.shipToName)) != '' ? lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.shipToName)) : lib.ups_rate_fn.clean($entity.ticket.get('requester', {}).get('name'))` | `$shipTo.name` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.shipToPhone)) != '' ? lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.shipToPhone)) : lib.ups_rate_fn.clean($entity.ticket.get('requester', {}).get('phone', $entity.ticket.get('requester', {}).get('mobile')))` | `$shipTo.phone` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.line1))` | `$shipTo.line1` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.line2))` | `$shipTo.line2` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.city))` | `$shipTo.city` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.state)).toUpperCase()` | `$shipTo.state` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.postal))` | `$shipTo.postal` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.country)) != '' ? lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.country)).toUpperCase() : lib.ups_rate_config.defaults.country` | `$shipTo.country` |
| `lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.weightLbs)) != '' ? lib.ups_rate_fn.clean(lib.ups_rate_fn.cf($entity.ticket, lib.ups_rate_config.fsFields.weightLbs)) : lib.ups_rate_config.defaults.weightLbs` | `$pkg.weightLbs` |

### [04b] Mapper — `Validate Ship-To`

Add a second Mapper directly after 04, labeled `04b Validate Ship-To`, with **Pass through ☑** so `$ticketId`, `$requestId`, `$shipTo` and `$pkg` flow on. A separate Mapper is needed because a Mapper can't read its own target paths.

| Expression | Target path |
|---|---|
| `[ ['shipToName', $shipTo.name], ['addressLine1', $shipTo.line1], ['city', $shipTo.city], ['state', $shipTo.state], ['postalCode', $shipTo.postal] ].filter(p => p[1] == '').map(p => p[0])` | `$missingFields` |
| `(isNaN(parseFloat($pkg.weightLbs)) \|\| parseFloat($pkg.weightLbs) <= 0 \|\| parseFloat($pkg.weightLbs) > 150) ? ['packageWeight'] : []` | `$invalidFields` |

The 150 lb limit is the UPS per-package maximum for small-package services. A heavier package needs UPS freight, which is out of scope here.

The state is required for US, CA and PR addresses. If you ship internationally, make the `state` check conditional: `$shipTo.country == 'US' || $shipTo.country == 'CA' ? … : …`.

### [05] Router — `Ship-To Complete?`

| Expression | Output view |
|---|---|
| `$missingFields.length == 0 && $invalidFields.length == 0` | `complete` |
| `$missingFields.length > 0 \|\| $invalidFields.length > 0` | `incomplete` |

`complete` → [06], `incomplete` → [E3].

### [E3] Mapper — `422 Incomplete Ticket Data`

| Expression | Target path |
|---|---|
| `false` | `$success` |
| `422` | `$httpStatus` |
| `$ticketId` | `$ticketId` |
| `$requestId` | `$requestId` |
| `{ "code": "SHIP_TO_INCOMPLETE", "source": "FRESHSERVICE", "message": "The ticket is missing shipping data required for a UPS quote: " + $missingFields.concat($invalidFields).join(', '), "details": [ { "missingFields": $missingFields, "invalidFields": $invalidFields } ] }` | `$error` |

This branch saves a UPS call and gives the agent a message they can act on.

### [06] Mapper — `Build UPS RateRequest`

Pass through ☐. This builds the body from your **Shipping Rate Example** template, with every literal replaced.

| Expression | Target path |
|---|---|
| `$ticketId` | `$ticketId` |
| `$requestId` | `$requestId` |
| `'FS' + $ticketId + 'T' + Date.now().getTime()` | `$transId` |
| *(the object below)* | `$rateBody` |

`$rateBody` expression:

```javascript
{
  "RateRequest": {
    "Request": {
      "RequestOption": _upsRequestOption,
      "TransactionReference": { "CustomerContext": "FS-TKT-" + $ticketId }
    },
    "Shipment": {
      "Shipper": {
        "Name": lib.ups_rate_config.shipper.name,
        "ShipperNumber": lib.ups_rate_config.shipper.shipperNumber,
        "Address": lib.ups_rate_config.shipper.address
      },
      "ShipFrom": {
        "Name": lib.ups_rate_config.shipFrom.name,
        "Address": lib.ups_rate_config.shipFrom.address
      },
      "ShipTo": {
        "Name": $shipTo.name.substring(0, 35),
        "Address": ({
          "AddressLine": [$shipTo.line1, $shipTo.line2].filter(l => l != '').map(l => l.substring(0, 35)),
          "City": $shipTo.city,
          "StateProvinceCode": $shipTo.state,
          "PostalCode": $shipTo.postal,
          "CountryCode": $shipTo.country
        }).extend(lib.ups_rate_config.defaults.residential ? { "ResidentialAddressIndicator": "" } : {})
      },
      "PaymentDetails": {
        "ShipmentCharge": {
          "Type": "01",
          "BillShipper": { "AccountNumber": lib.ups_rate_config.shipper.shipperNumber }
        }
      },
      "ShipmentTotalWeight": {
        "UnitOfMeasurement": { "Code": "LBS", "Description": "Pounds" },
        "Weight": $pkg.weightLbs
      },
      "Package": {
        "PackagingType": { "Code": lib.ups_rate_config.defaults.packagingCode, "Description": "Package" },
        "PackageWeight": {
          "UnitOfMeasurement": { "Code": "LBS", "Description": "Pounds" },
          "Weight": $pkg.weightLbs
        }
      },
      "DeliveryTimeInformation": { "PackageBillType": "03" },
      "ShipmentRatingOptions": { "NegotiatedRatesIndicator": "Y" }
    }
  }
}
```

Field notes:

- `transId` must be 32 characters or fewer. The pattern `FS` + up to 12 digits + `T` + 13 digits is at most 28.
- `ShipmentTotalWeight` is used for the time-in-transit calculation, and `DeliveryTimeInformation.PackageBillType` is required for the `*timeintransit` options.
- `ResidentialAddressIndicator` is a presence flag in UPS (an empty string means present). Your invoice shows *Ground Residential*, so `defaults.residential` is `true`. The `.extend()` adds the key only when the flag is on, so UPS never receives `null`.
- The UPS rating response doesn't need `Phone`, so it is omitted.

### [07] HTTP Client — `UPS Rate Shop`

1. **Account:** `UPS_OAuth2_CC_<ENV>`
2. **Request method:** `POST`
3. **Request URL** (expression ☑): `_upsBaseUrl + '/api/rating/' + _upsRatingVersion + '/' + _upsRequestOption`
4. **HTTP headers:**

| Header | Value (expression ☑) |
|---|---|
| `Content-Type` | `'application/json'` |
| `Accept` | `'application/json'` |
| `transId` | `$transId` |
| `transactionSrc` | `_upsTransactionSrc` |

5. **Request body:** `$rateBody`
6. **Retry policy:** retry on connection errors and status `429` / `500` / `502` / `503`, at most **2** retries with a 1 s interval and exponential backoff. **Never retry 400**, because that is a data error.
7. **Timeouts:** connection 10 s, read 20 s.
8. **Views → Error:** Route Error Data to Error View → [E4].

### [E4] Mapper — `UPS Error Response`

| Expression | Target path |
|---|---|
| `false` | `$success` |
| `lib.ups_rate_fn.httpStatus($) == 400 ? 422 : (lib.ups_rate_fn.httpStatus($) == 429 \|\| lib.ups_rate_fn.httpStatus($) == 503 ? 503 : 502)` | `$httpStatus` |
| `$original.get('ticketId')` | `$ticketId` |
| `$original.get('requestId')` | `$requestId` |
| `{ "code": lib.ups_rate_fn.httpStatus($) == 400 ? "UPS_VALIDATION_ERROR" : (lib.ups_rate_fn.httpStatus($) == 401 \|\| lib.ups_rate_fn.httpStatus($) == 403 ? "UPS_AUTH_ERROR" : "UPS_UNAVAILABLE"), "source": "UPS", "upstreamStatus": lib.ups_rate_fn.httpStatus($), "message": lib.ups_rate_fn.upsErrors($.get('error_entity')).length > 0 ? lib.ups_rate_fn.upsErrors($.get('error_entity')).map(e => e.get('message')).join(' \| ') : $.get('reason', $.get('error')), "details": lib.ups_rate_fn.upsErrors($.get('error_entity')) }` | `$error` |

UPS error body: `{"response":{"errors":[{"code":"111210","message":"The requested service is unavailable between the selected locations."}]}}`. A UPS 400 (for example an invalid ZIP or state) becomes **422** with UPS's own message, so the agent can fix the ticket fields.

⚠ **Verify** that `error_entity` holds a parsed object for HTTP Client. If it is a string, wrap it in `JSON.parse($.error_entity)` inside a try-safe ternary. Run one call with an invalid ZIP in Designer to confirm.

### [08] Mapper — `Normalize Rates`

| Expression | Target path |
|---|---|
| `$entity.RateResponse.get('Response', {}).get('ResponseStatus', {}).get('Code')` | `$upsStatusCode` |
| `$entity.RateResponse.get('Response', {}).get('TransactionReference', {}).get('CustomerContext', '').replace('FS-TKT-', '')` | `$ticketIdEcho` |
| `lib.ups_rate_fn.toArray($entity.RateResponse.get('RatedShipment')).map(r => lib.ups_rate_fn.rate(r, lib.ups_rate_config.serviceNames)).map(x => x.extend({ "amount": lib.ups_rate_fn.effective(x) })).sort((a, b) => a.amount - b.amount)` | `$rates` |
| `lib.ups_rate_fn.toArray($entity.RateResponse.get('Response', {}).get('Alert')).map(a => a.get('Description'))` | `$responseAlerts` |
| `pipe.ruuid` | `$requestId` |

`$rates` is sorted cheapest-first by the **effective** price: the negotiated rate when UPS returns one, otherwise the published rate. `ticketIdEcho` relies on UPS echoing `TransactionReference.CustomerContext`. ⚠ **Verify** this in CIE. If UPS doesn't echo it, the FS app already knows the ticket ID, so nothing breaks.

### [09] Router — `UPS Success?`

| Expression | Output view |
|---|---|
| `$upsStatusCode == '1' && $rates.length > 0` | `ok` |
| `!($upsStatusCode == '1' && $rates.length > 0)` | `noRates` |

### [E5] Mapper — `No Rates Response`

| Expression | Target path |
|---|---|
| `false` | `$success` |
| `502` | `$httpStatus` |
| `$ticketIdEcho != '' ? parseInt($ticketIdEcho, 10) : null` | `$ticketId` |
| `$requestId` | `$requestId` |
| `{ "code": "UPS_NO_RATES", "source": "UPS", "message": "UPS returned no rated services for this shipment.", "details": $responseAlerts }` | `$error` |

### [10] Mapper — `Success Response`

| Expression | Target path |
|---|---|
| `true` | `$success` |
| `200` | `$httpStatus` |
| `$ticketIdEcho != '' ? parseInt($ticketIdEcho, 10) : null` | `$ticketId` |
| `$requestId` | `$requestId` |
| `{ "requestOption": _upsRequestOption, "currency": $rates[0].currency, "cheapest": $rates[0], "rates": $rates, "alerts": $responseAlerts, "quotedAt": Date.now() }` | `$data` |

### [11] Union — `Response`

1. Add **Union** labeled `11 Response`. On the Views tab, add input views until there are **6** (E1, E2, E3, E4, E5, 10).
2. Connect all six branches. **Leave the output unconnected.** This is the task's response.

Because each request carries exactly one document, exactly one envelope reaches the Union.

---

## 7. Task, Authentication and Response Contract

### 7.1 Create the Triggered Task

**Manager → project → Create Task → Triggered Task:**

| Setting | Value |
|---|---|
| Name | `FS_UPS_RateQuote_API_Task` |
| Pipeline | `FS_UPS_RateQuote_API` |
| Snaplex | Cloudplex (public Cloud URL). A Groundplex needs an inbound route that Freshworks servers can reach. |
| Bearer token | Keep the auto-generated token, or replace it with a 40+ character random value (`openssl rand -hex 32`). **Never clear this field.** A blank token makes the pipeline responsible for authentication. |
| Pipeline parameters | Set the environment values from section 4 |
| Timeout | `1` minute. The minimum is 1; it bounds runaway executions. |
| "Do not start a new execution if one is already running" | **☐ Off.** If this is on, two agents clicking at the same time get **409**. |
| Debug / record triggers | Off in Prod. Use it in Dev only, because it stores request traces. |

Copy the **Cloud URL**: `https://elastic.snaplogic.com/api/1/rest/slsched/feed/<Org>/<ProjectSpace>/<Project>/FS_UPS_RateQuote_API_Task`. It may be `emea.snaplogic.com` depending on your pod.

### 7.2 Request and response contract

Request:

```http
POST /api/1/rest/slsched/feed/<Org>/<ProjectSpace>/<Project>/FS_UPS_RateQuote_API_Task
Authorization: Bearer <task token>
Content-Type: application/json

{ "ticketId": 330134 }
```

The response is HTTP **200** and the body is a **JSON array with one envelope**. The real outcome is in `success` and `httpStatus`:

```json
[{
  "success": true,
  "httpStatus": 200,
  "ticketId": 330134,
  "requestId": "6f0c…",
  "data": {
    "requestOption": "Shoptimeintransit",
    "currency": "USD",
    "cheapest": { "serviceCode": "03", "serviceName": "UPS Ground", "publishedRate": 21.72, "negotiatedRate": null, "amount": 21.72, "businessDaysInTransit": "4", "estimatedArrivalDate": "20261030", "alerts": [] },
    "rates": [ { "serviceCode": "03", "…": "…" }, { "serviceCode": "12", "…": "…" }, { "serviceCode": "01", "…": "…" } ],
    "alerts": [],
    "quotedAt": "2026-10-26T08:15:03.112Z"
  }
}]
```

Error example:

```json
[{ "success": false, "httpStatus": 422, "ticketId": 330134, "requestId": "…",
   "error": { "code": "SHIP_TO_INCOMPLETE", "source": "FRESHSERVICE", "message": "The ticket is missing shipping data required for a UPS quote: city, postalCode", "details": [ … ] } }]
```

**Why the envelope always returns 200:** this release doesn't document a native way for a Triggered Task pipeline to set its own HTTP status code. **This behavior is not documented by the vendor and should be verified before implementation.** Platform-level failures still return non-200 codes: **401** for a bad or missing bearer token, and 5xx for an unhandled pipeline failure. The FS app must handle both layers (see 7.4).

### 7.3 Triggered vs Ultra Task

| Criteria | Triggered Task | Ultra Task |
|---|---|---|
| Latency | Pipeline prepares on every call (~1–3 s of overhead) | Pipeline always running (sub-second overhead) |
| Fit for agent-clicked quotes (low volume) | Good | Overkill |
| Infrastructure | Cloudplex works as is | Needs FeedMaster and a dedicated Snaplex, plus an additional subscription |
| Design constraints | None special | Ultra-compatible Snaps only; stricter view rules |
| Operational overhead | Low | Medium (always-on nodes) |
| Cost | Included | Extra |

**Recommendation:** use a **Triggered Task**. Quotes are on-demand and human-paced, and end-to-end latency (about 3–6 s) fits easily inside the FDK request timeout. Move to an Ultra Task only if the FS app is later embedded in a high-volume, automated flow.

### 7.4 Freshservice Custom App (FDK, platform 3.0)

`config/iparams.json`:

```json
{
  "snaplogic_host":   { "display_name": "SnapLogic host", "type": "text", "required": true, "default_value": "elastic.snaplogic.com", "description": "FQDN only, no https://" },
  "snaplogic_path":   { "display_name": "Task path", "type": "text", "required": true, "description": "/api/1/rest/slsched/feed/<Org>/<ProjectSpace>/<Project>/FS_UPS_RateQuote_API_Task" },
  "snaplogic_token":  { "display_name": "SnapLogic task bearer token", "type": "text", "required": true, "secure": true }
}
```

`config/requests.json`:

```json
{
  "getUpsQuote": {
    "schema": {
      "method": "POST",
      "host": "<%= iparam.snaplogic_host %>",
      "path": "<%= iparam.snaplogic_path %>",
      "headers": {
        "Authorization": "Bearer <%= iparam.snaplogic_token %>",
        "Content-Type": "application/json"
      }
    },
    "options": { "retryDelay": 1000, "maxAttempts": 1 }
  }
}
```

`manifest.json` (relevant parts):

```json
{
  "platform-version": "3.0",
  "modules": {
    "common": { "requests": { "getUpsQuote": {} } },
    "service_ticket": { "location": { "ticket_sidebar": { "url": "index.html", "icon": "styles/images/icon.svg" } } }
  },
  "engines": { "node": "18.20.8", "fdk": "9.4.2" }
}
```

`app/scripts/app.js` (core call):

```javascript
async function getUpsQuote(client) {
  const { ticket } = await client.data.get('ticket');
  const ticketId = ticket.display_id || ticket.id;
  try {
    const res = await client.request.invokeTemplate('getUpsQuote', {
      body: JSON.stringify({ ticketId })
    });
    const env = JSON.parse(res.response)[0];
    if (!env || !env.success) {
      return { ok: false, message: env ? env.error.message : 'Empty response', ref: env && env.requestId };
    }
    return { ok: true, rates: env.data.rates, cheapest: env.data.cheapest };
  } catch (err) {
    const msg = err.status === 401 ? 'Integration authentication failed - contact IT Integration.'
              : err.status === 504 || err.status === 502 ? 'Quote service timed out - please retry.'
              : 'Quote service unavailable (' + err.status + ').';
    return { ok: false, message: msg };
  }
}
```

FDK facts that affect this design, from the Freshworks Request Method docs:

- **Secure iparams are allowed only in `headers`**, which is why the token is placed there. Never put it in the path or query string.
- `host` must be an FQDN with no protocol.
- The default request timeout is **15 s**. You can raise it to 20, 25 or 30 s in the app configuration; 20 s is recommended here.
- The limit is **50 requests per minute per app per account**, which is far above agent click rates.
- Calls run through the Freshworks proxy, so the token never reaches the browser.

⚠ **Verify** two items. First, in Freshservice the FDK ticket object has both `id` and `display_id`, and the REST API uses the **display** ID. Confirm which one your instance returns. Second, confirm the module name `service_ticket` against your FDK version.

---

## 8. Error Handling

| Layer | Condition | Behavior |
|---|---|---|
| Platform | Missing or invalid bearer token | SnapLogic returns 401; the pipeline never runs |
| [01–02] | `ticketId` missing, non-numeric, 0 or longer than 12 digits | Envelope with 400 `INVALID_REQUEST` and no API calls |
| [03] | Freshservice 404 | Envelope with 404 `TICKET_NOT_FOUND` |
| [03] | Freshservice 401/403 | Envelope with 502 `FS_API_ERROR`, plus an operations alert (key revoked or role changed) |
| [03] | Freshservice 429/5xx | Snap retries 3× with backoff, then returns 503 `FS_RATE_LIMITED` / 502 |
| [05] | Ship-To or weight incomplete | Envelope with 422 `SHIP_TO_INCOMPLETE` listing the fields; no UPS call |
| [07] | UPS 400 | Envelope with 422 `UPS_VALIDATION_ERROR` carrying the UPS message; no retry |
| [07] | UPS 401/403 | Envelope with 502 `UPS_AUTH_ERROR`; check the OAuth account or app products |
| [07] | UPS 429/5xx | Snap retries 2×, then returns 503 `UPS_UNAVAILABLE` |
| [09] | ResponseStatus ≠ 1 or no RatedShipment | Envelope with 502 `UPS_NO_RATES` |
| Any Snap | Unexpected failure (expression error, platform) | Pipeline fails; the Error Pipeline logs it and the task returns 5xx; the FS app shows a generic message |

**Logging and correlation:** `requestId` (`pipe.ruuid`) is in every envelope, so support can find the execution in **Manager → Dashboard → Pipeline Executions**. `transId` (`FS<ticket>T<epoch>`) goes to UPS for UPS-side support tickets.

**Notification:** the Error Pipeline (`Common_Error_Logger`) sends email or Teams alerts for unhandled failures. For handled 502 and 503 envelopes, create a Dashboard alert on task failures, or add a Copy → Filter (`$httpStatus >= 502`) → Email Sender branch after [11] if operations needs per-incident alerts.

**Recovery:** the API is read-only and idempotent, so the agent simply clicks again. No state needs cleaning up.

---

## 9. Performance

- **API calls per quote:** 1 Freshservice call (2 credits) plus 1 UPS call. Token refresh happens about once every 4 hours.
- **Freshservice rate limits:** the *View Ticket* sub-limit is 50/80/140/160 per minute (Starter/Growth/Pro/Enterprise). Human clicking never approaches it, and `Retry-After` is honored on 429.
- **Memory:** a single document of a few kilobytes. No pagination, batching or parallelism is needed.
- **Latency budget:** task start ~1–3 s, Freshservice ~0.3–0.8 s, UPS Shop with time-in-transit ~1–3 s. The total of about 3–6 s fits inside the FDK timeout (raise it to 20 s).
- **Optimization:** if agents usually need only one service, `Rate` with a fixed `Service.Code` is faster than `Shop`. Keep `Shoptimeintransit` as the default because it gives agents a real choice.

---

## 10. Security

- The bearer token lives in a **secure iparam** and is sent only server-side by FDK. It is never in browser code or query strings.
- Freshservice and UPS credentials live only in **encrypted SnapLogic Accounts** and are never stored in pipeline parameters.
- **Least privilege:** the Freshservice integration agent is read-only for tickets, and the UPS app has only the products you use.
- All traffic uses TLS (HTTPS on SnapLogic, Freshservice and UPS).
- **Rotation every 90 days:** generate a new task token, update the FS app iparam, then update the Task. Brief overlap isn't supported, so schedule rotation in a low-traffic window.
- **Environment isolation:** use separate tasks, tokens, accounts, UPS apps (CIE vs Prod) and Freshservice sandbox vs production.
- **Optional hardening** (if you have API Management): put the task behind an APIM proxy with an IP-restriction policy and request-size limits. You can also add an HMAC-signed body later without changing the contract.
- Turn off task **Debug** in Prod, because traces would capture request data.

---

## 11. Testing Strategy

| # | Input / setup | Expected envelope |
|---|---|---|
| T1 | Valid child ticket with full address and weight 5 | `success: true`, 3 or more rates sorted ascending, `cheapest.serviceCode` usually `03` |
| T2 | `{ "ticketId": "330134" }` (string) | Same as T1 (string is accepted) |
| T3 | `{}` / `{ "ticketId": "abc" }` / `{ "ticketId": 0 }` | 400 `INVALID_REQUEST` |
| T4 | Ticket ID that doesn't exist | 404 `TICKET_NOT_FOUND` |
| T5 | Ticket with blank city and ZIP | 422 `SHIP_TO_INCOMPLETE`, `missingFields: ["city","postalCode"]` |
| T6 | Weight `"-1"` or `"abc"` | 422, `invalidFields: ["packageWeight"]` |
| T7 | Blank weight field | Uses `defaults.weightLbs` → success |
| T8 | Ship-To name blank | Falls back to the requester name → success |
| T9 | ZIP that doesn't match the state (for example GA + 95678) | 422 `UPS_VALIDATION_ERROR` with the UPS message |
| T10 | `upsRequestOption = Rate` | Single `RatedShipment` object → still returns `rates[1]` (exercises `toArray`) |
| T11 | Wrong Freshservice API key in the account | 502 `FS_API_ERROR` |
| T12 | Wrong UPS secret | 502 `UPS_AUTH_ERROR` |
| T13 | Missing or wrong bearer token | Platform 401; the FS app shows the auth message |
| T14 | 10 concurrent calls (k6 or JMeter) | All succeed; no 409 |
| T15 | Account not negotiated-rate eligible | `negotiatedRate: null`, `amount = publishedRate` |

To test in Designer, drop a **JSON Generator** with `[{"ticketId": 330134}]` temporarily in front of [01], validate, inspect each Snap's preview, then remove it. A pipeline with a connected input won't receive the task body.

---

## 12. Deployment

```text
Development (FS sandbox + UPS CIE) → Testing/UAT (FS sandbox + UPS CIE) → Production (FS prod + UPS onlinetools)
```

| Artifact | Dev | Test | Prod |
|---|---|---|---|
| Pipeline `FS_UPS_RateQuote_API` | ✓ | promoted | promoted |
| `ups_rate_fn.expr` | ✓ | identical | identical |
| `ups_rate_config.expr` | CIE shipper, sandbox field names | same as Dev | **Prod shipper and field names** |
| `FS_API_Basic_<ENV>` | sandbox key | sandbox key | prod key |
| `UPS_OAuth2_CC_<ENV>` | CIE app | CIE app | Prod app, token URL on `onlinetools` |
| Task `FS_UPS_RateQuote_API_Task` | own token | own token | own token |
| FS App installation iparams | Dev task path and token | Test | Prod |

**Go-live checklist**

- [ ] Real Freshservice custom field names entered in `ups_rate_config.fsFields`
- [ ] UPS app has the Rating product; Prod credentials are in the Prod account; token endpoint is on `onlinetools.ups.com`
- [ ] The shipper number is eligible for negotiated rates (otherwise expect `negotiatedRate: null`)
- [ ] All ⚠ Verify items confirmed: HTTP Client retry labels, error-view status field and `error_entity` type, OAuth2 CC account labels, `CustomerContext` echo, FDK `display_id`, FDK module name
- [ ] The task's "do not start if running" option is **off**; Debug is **off**
- [ ] FDK request timeout set to 20 s; the app is validated with `fdk validate`
- [ ] T1–T15 pass in Test
- [ ] Error Pipeline alerts route to the operations channel
- [ ] Token rotation date is on the operations calendar

---

## Sources

- [Freshservice API v2 — View a Ticket, include options, rate limits, authentication](https://api.freshservice.com/)
- [Freshworks FDK — Request method (templates, secure iparams, timeouts, limits)](https://developers.freshworks.com/docs/app-sdk/v3.0/common/advanced-interfaces/request-method/)
- [SnapLogic — Triggered Task configuration options (bearer token, timeout, concurrency)](https://docs.snaplogic.com/manager/triggered-task-configuration-options.html)
- [SnapLogic — Triggered Tasks](https://docs.snaplogic.com/manager/triggered-tasks.html)
- [SnapLogic — HTTP Client Snap](https://docs.snaplogic.com/snaps/snaps-core/sp-api-suite/http-client.html)
- [SnapLogic — REST Snap Pack (Not Recommended; use HTTP Client)](https://docs.snaplogic.com/snaps/snaps-core/sp-rest/sp-rest-about.html)
- [SnapLogic Community — `error_entity` in the REST/HTTP error view](https://community.snaplogic.com/t5/designing-and-running-pipelines/rest-api-service-endpoint-returned-erros-result-status-code-403/td-p/17528)
- [UPS Developer Portal — Rating API](https://developer.ups.com/)
- Project docs: *Shipping Rate Example.txt* (RateRequest template), *UPS Shipment sample.png* (Ship-From and service context)
