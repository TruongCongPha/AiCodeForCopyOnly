// Every expression used in the FS_UPS_RateQuote_API pipeline.
// The simulation (snaplogic/tests/simulate_quote_pipeline.js) runs these exact
// strings, and the guide's Snap tables are generated from this file.
// Write expressions in SnapLogic syntax: $field, $original, lib.<library>, _param.
"use strict";

const F = "lib.fs_ups_config.fsFields";

module.exports = {
  parameters: [
    { name: "fsBaseUrl", example: "https://pearce-sandbox.freshservice.com", required: "Yes", default: "(none)", description: "Freshservice account URL, no trailing slash" },
    { name: "upsBaseUrl", example: "https://wwwcie.ups.com", required: "Yes", default: "https://wwwcie.ups.com", description: "UPS host. Test: wwwcie.ups.com. Production: onlinetools.ups.com" },
    { name: "upsRatingVersion", example: "v2409", required: "Yes", default: "v2409", description: "Rating API version path segment" },
    { name: "upsRequestOption", example: "Shoptimeintransit", required: "Yes", default: "Shoptimeintransit", description: "Rating request option, used in the URL and the request body" },
    { name: "upsTransactionSrc", example: "FS-SnapLogic-Quote", required: "Yes", default: "FS-SnapLogic-Quote", description: "Value of the UPS transactionSrc header" }
  ],

  snaps: [
    {
      id: "01", label: "01 Parse request", type: "Mapper", passThrough: false,
      purpose: "Reads the POST body. Validates ticketId, keeps or creates a requestId, records today's date in the shipping time zone.",
      rows: [
        [`{"ticketIdRaw": lib.fs_ups_fn.clean($.get('ticketId')), "ticketId": lib.fs_ups_fn.validTicketId($.get('ticketId')) ? parseInt(lib.fs_ups_fn.clean($.get('ticketId')), 10) : null, "requestId": lib.fs_ups_fn.safeRequestId($.get('requestId')) != '' ? lib.fs_ups_fn.safeRequestId($.get('requestId')) : pipe.ruuid, "executionId": pipe.ruuid, "today": Date.now().toLocaleDateString({"format": "yyyyMMdd", "timeZone": lib.fs_ups_config.defaults.timeZone}), "stage": "items"}`, "$ctx"]
      ]
    },
    {
      id: "02", label: "02 Valid request?", type: "Router",
      routes: [["$ctx.ticketId != null", "valid", "03"], ["$ctx.ticketId == null", "invalid", "E1"]]
    },
    {
      id: "03", label: "03 FS requested items", type: "HTTP Client", account: "FS_API_Basic_<ENV>", method: "GET",
      purpose: "Reads the requested items of the child ticket.",
      url: `_fsBaseUrl + '/api/v2/tickets/' + $ctx.ticketId + '/requested_items'`,
      errorTo: "U1"
    },
    {
      id: "04", label: "04 Pick item", type: "Mapper", passThrough: false,
      purpose: "Selects the UPS Shipment Details item and restores the context from $original.",
      rows: [
        [`$original.ctx.extend({"item": lib.fs_ups_fn.pickItem($entity.get('requested_items'), lib.fs_ups_config.fs.serviceItemId)})`, "$ctx"]
      ]
    },
    {
      id: "04a", label: "04a Read form", type: "Mapper", passThrough: true,
      purpose: "Turns the item's custom fields into one clean shipment object.",
      rows: [
        [`{"itemFound": $ctx.item != null, "requestedItemId": $ctx.item == null ? null : $ctx.item.get('id'), "receiverRef": lib.fs_ups_fn.receiverRef(lib.fs_ups_fn.cf($ctx.item, ${F}.receiver)), "phone": lib.fs_ups_fn.normalizePhone(lib.fs_ups_fn.cf($ctx.item, ${F}.phone)), "line1": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.line1)), "line2": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.line2)), "city": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.city)), "state": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.state)).toUpperCase(), "zip": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.zip)), "residential": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.deliveryType)) == '' ? lib.fs_ups_config.defaults.residential : lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.deliveryType)).toLowerCase() != 'business', "weight": lib.fs_ups_fn.clean(lib.fs_ups_fn.cf($ctx.item, ${F}.weight)), "shipDate": lib.fs_ups_fn.ymd(lib.fs_ups_fn.cf($ctx.item, ${F}.shipDate), $ctx.today)}`, "$ctx.shipment"]
      ]
    },
    {
      id: "04b", label: "04b Validate form", type: "Mapper", passThrough: true,
      purpose: "Lists every missing or invalid form field. Sets the stage for error mapping.",
      rows: [
        [`lib.fs_ups_fn.formProblems($ctx.shipment, lib.fs_ups_config, $ctx.today)`, "$ctx.problems"],
        [`'receiver'`, "$ctx.stage"]
      ]
    },
    {
      id: "05", label: "05 Form complete?", type: "Router",
      routes: [["$ctx.problems.length == 0", "complete", "06"], ["$ctx.problems.length > 0", "invalid", "U2"]]
    },
    {
      id: "06", label: "06 FS receiver", type: "HTTP Client", account: "FS_API_Basic_<ENV>", method: "GET",
      purpose: "Reads the receiver (requester) by ID, or looks them up by email.",
      url: `lib.fs_ups_fn.requesterUrl(_fsBaseUrl, $ctx.shipment.receiverRef)`,
      errorTo: "U1"
    },
    {
      id: "07", label: "07 Pick receiver", type: "Mapper", passThrough: false,
      purpose: "Normalizes the two response shapes (by ID or by email) and restores the context.",
      rows: [
        [`$original.ctx.extend({"requester": lib.fs_ups_fn.requesterFrom($entity)})`, "$ctx"]
      ]
    },
    {
      id: "07a", label: "07a Read receiver", type: "Mapper", passThrough: true,
      purpose: "Takes the receiver's name and email. The department is not needed for a quote.",
      rows: [
        [`{"found": $ctx.requester != null, "id": $ctx.requester == null ? null : $ctx.requester.get('id'), "name": lib.fs_ups_fn.fullName($ctx.requester), "email": $ctx.requester == null ? null : $ctx.requester.get('primary_email')}`, "$ctx.receiver"]
      ]
    },
    {
      id: "07b", label: "07b Validate receiver", type: "Mapper", passThrough: true,
      purpose: "Checks the receiver was found and has a name.",
      rows: [
        [`lib.fs_ups_fn.receiverProblems($ctx.receiver)`, "$ctx.problems"],
        [`'ups'`, "$ctx.stage"]
      ]
    },
    {
      id: "08", label: "08 Receiver OK?", type: "Router",
      routes: [["$ctx.problems.length == 0", "ok", "12"], ["$ctx.problems.length > 0", "invalid", "U2"]]
    },
    {
      id: "12", label: "12 Build rate request", type: "Mapper", passThrough: true,
      purpose: "Builds the UPS Rating body from the shipment and the config library.",
      rows: [
        [`lib.fs_ups_fn.buildRateRequest($ctx.shipment.extend({"receiverName": $ctx.receiver.name}), lib.fs_ups_config, {"requestOption": _upsRequestOption, "customerContext": $ctx.requestId})`, "$rateBody"],
        [`lib.fs_ups_fn.transId($ctx.requestId)`, "$transId"]
      ]
    },
    {
      id: "13", label: "13 UPS rate", type: "HTTP Client", account: "UPS_OAuth2_<ENV>", method: "POST",
      purpose: "Calls the UPS Rating API with time in transit.",
      url: `_upsBaseUrl + '/api/rating/' + _upsRatingVersion + '/' + _upsRequestOption`,
      headers: [["Content-Type", `'application/json'`], ["Accept", `'application/json'`], ["transId", `$transId`], ["transactionSrc", `_upsTransactionSrc`]],
      body: "$rateBody",
      errorTo: "E4"
    },
    {
      id: "14", label: "14 Build options", type: "Mapper", passThrough: false,
      purpose: "Turns RatedShipment into option cards: filter, sort by price, tag Lowest cost and Fastest.",
      rows: [
        [`$original.ctx`, "$ctx"],
        [`'' + $entity.get('RateResponse', {}).get('Response', {}).get('ResponseStatus', {}).get('Code', '')`, "$upsStatusCode"],
        [`lib.fs_ups_fn.tag(lib.fs_ups_fn.toArray($entity.get('RateResponse', {}).get('RatedShipment')).map(r => lib.fs_ups_fn.option(r, lib.fs_ups_config, lib.fs_ups_fn.negotiated(r), lib.fs_ups_fn.published(r))).filter(o => lib.fs_ups_fn.keepOption(o, lib.fs_ups_config.allowedServiceCodes)).sort((a, b) => a.amount - b.amount))`, "$options"],
        [`lib.fs_ups_fn.toArray($entity.get('RateResponse', {}).get('Response', {}).get('Alert')).map(a => a.get('Description'))`, "$alerts"]
      ]
    },
    {
      id: "15", label: "15 Options found?", type: "Router",
      routes: [["$upsStatusCode == '1' && $options.length > 0", "ok", "16"], ["!($upsStatusCode == '1' && $options.length > 0)", "none", "E5"]]
    },
    {
      id: "16", label: "16 Success response", type: "Mapper", passThrough: false,
      purpose: "Builds the success envelope the app displays.",
      rows: [
        [`'ok'`, "$status"],
        [`200`, "$httpStatus"],
        [`$ctx.requestId`, "$requestId"],
        [`$ctx.ticketId`, "$ticketId"],
        [`$ctx.executionId`, "$quoteId"],
        [`Date.now()`, "$quotedAt"],
        [`{"receiverName": $ctx.receiver.name, "addressLines": [$ctx.shipment.line1, $ctx.shipment.line2].filter(l => l != ''), "city": $ctx.shipment.city, "state": $ctx.shipment.state, "zip": $ctx.shipment.zip, "residential": $ctx.shipment.residential, "weightLbs": parseFloat($ctx.shipment.weight), "shipDate": lib.fs_ups_fn.isoDate($ctx.shipment.shipDate)}`, "$shipmentSummary"],
        [`$options`, "$options"],
        [`$alerts`, "$alerts"]
      ]
    }
  ],

  errorSnaps: [
    {
      id: "E1", label: "E1 Invalid request", type: "Mapper", passThrough: false, from: "02 invalid",
      rows: [
        [`'invalid'`, "$status"], [`400`, "$httpStatus"], [`'INVALID_REQUEST'`, "$code"],
        [`'Send ticketId as a positive whole number.'`, "$message"], [`false`, "$retryable"],
        [`$ctx.requestId`, "$requestId"], [`null`, "$ticketId"],
        [`[{"field": "ticketId", "message": "Send ticketId as a positive whole number."}]`, "$problems"]
      ]
    },
    {
      id: "U1", label: "U1 FS errors", type: "Union", from: "error views of 03 and 06", to: "E2",
      purpose: "Collects the Freshservice error views into one input."
    },
    {
      id: "E2", label: "E2 Freshservice error", type: "Mapper", passThrough: false, from: "U1",
      rows: [
        [`lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).status`, "$status"],
        [`lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).httpStatus`, "$httpStatus"],
        [`lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).code`, "$code"],
        [`lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).message`, "$message"],
        [`lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).retryable`, "$retryable"],
        [`$original.ctx.requestId`, "$requestId"], [`$original.ctx.ticketId`, "$ticketId"],
        [`{"source": "FRESHSERVICE", "stage": $original.ctx.stage, "upstreamStatus": lib.fs_ups_fn.httpStatus($), "detail": lib.fs_ups_fn.fsError(lib.fs_ups_fn.httpStatus($), $original.ctx.stage, $.get('error_entity')).detail}`, "$error"]
      ]
    },
    {
      id: "U2", label: "U2 Invalid shipment", type: "Union", from: "invalid routes of 05 and 08", to: "E3",
      purpose: "Collects the validation failures into one input."
    },
    {
      id: "E3", label: "E3 Invalid shipment", type: "Mapper", passThrough: false, from: "U2",
      rows: [
        [`'invalid'`, "$status"], [`422`, "$httpStatus"],
        [`$ctx.problems.filter(p => p.field == 'item').length > 0 ? 'NOT_A_UPS_TICKET' : 'INVALID_SHIPMENT'`, "$code"],
        [`$ctx.problems.map(p => p.message).join(' ')`, "$message"], [`false`, "$retryable"],
        [`$ctx.requestId`, "$requestId"], [`$ctx.ticketId`, "$ticketId"], [`$ctx.problems`, "$problems"]
      ]
    },
    {
      id: "E4", label: "E4 UPS error", type: "Mapper", passThrough: false, from: "13 error view",
      rows: [
        [`lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).status`, "$status"],
        [`lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).httpStatus`, "$httpStatus"],
        [`lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).code`, "$code"],
        [`lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).message`, "$message"],
        [`lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).retryable`, "$retryable"],
        [`$original.ctx.requestId`, "$requestId"], [`$original.ctx.ticketId`, "$ticketId"],
        [`{"source": "UPS", "upstreamStatus": lib.fs_ups_fn.httpStatus($), "details": lib.fs_ups_fn.upsError(lib.fs_ups_fn.httpStatus($), $.get('error_entity')).details}`, "$error"]
      ]
    },
    {
      id: "E5", label: "E5 No options", type: "Mapper", passThrough: false, from: "15 none",
      rows: [
        [`'error'`, "$status"], [`502`, "$httpStatus"], [`'UPS_NO_OPTIONS'`, "$code"],
        [`'UPS returned no delivery options for this shipment.'`, "$message"], [`false`, "$retryable"],
        [`$ctx.requestId`, "$requestId"], [`$ctx.ticketId`, "$ticketId"],
        [`{"source": "UPS", "upsStatusCode": $upsStatusCode, "details": $alerts}`, "$error"]
      ]
    },
    {
      id: "17", label: "17 Response", type: "Union", from: "16, E1, E2, E3, E4, E5",
      purpose: "Single unconnected output view. The Triggered Task returns its documents as the response body."
    }
  ]
};
