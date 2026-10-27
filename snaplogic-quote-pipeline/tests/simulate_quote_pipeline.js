// Simulates FS_UPS_RateQuote_API with the exact expressions from
// snaplogic/specs/quote-pipeline-expressions.js and mocked HTTP responses.
// Run: node snaplogic/tests/simulate_quote_pipeline.js
//
// Assumptions this simulation cannot prove (check them in Designer):
//  - HTTP Client output and error documents carry the input document as $original.
//  - HTTP Client error documents have error, reason and error_entity fields.
//  - Mapper rows read the input document; pass-through copies it to the output.
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

Object.defineProperty(Object.prototype, "__slGet", {
  value: function (key, dflt) {
    const has = Object.prototype.hasOwnProperty.call(this, key) && this[key] !== undefined;
    return has ? this[key] : (dflt === undefined ? null : dflt);
  }, enumerable: false, writable: true, configurable: true
});
Object.defineProperty(Object.prototype, "__slExtend", {
  value: function (...objs) { return Object.assign({}, this, ...objs); },
  enumerable: false, writable: true, configurable: true
});

const root = path.join(__dirname, "..");
const fnText = fs.readFileSync(path.join(root, "expression-libraries", "fs_ups_fn.expr"), "utf8");
const cfgText = fs.readFileSync(path.join(root, "expression-libraries", "fs_ups_config.expr"), "utf8");
// eslint-disable-next-line no-eval
const fn = eval("(" + fnText.replace(/\.get\(/g, ".__slGet(").replace(/\.extend\(/g, ".__slExtend(") + ")");
const spec = require(path.join(root, "specs", "quote-pipeline-expressions.js"));
const snaps = {};
spec.snaps.concat(spec.errorSnaps).forEach(s => { snaps[s.id] = s; });

const TODAY = "20261022";
const PARAMS = {
  _fsBaseUrl: "https://pearce-sandbox.freshservice.com",
  _upsBaseUrl: "https://wwwcie.ups.com",
  _upsRatingVersion: "v2409",
  _upsRequestOption: "Shoptimeintransit",
  _upsTransactionSrc: "FS-SnapLogic-Quote"
};
const nowObj = { toLocaleDateString: () => TODAY, toJSON: () => "2026-10-22T17:00:00.000Z" };

function compile(expr) {
  let s = expr.replace(/\.get\(/g, ".__slGet(").replace(/\.extend\(/g, ".__slExtend(")
    .replace(/Date\.now\(\)/g, "__now()")
    .replace(/\$\./g, "__D.")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, "__D.$1")
    .replace(/\$/g, "__D");
  // eslint-disable-next-line no-new-func
  return new Function("__D", "lib", "pipe", "__now", ...Object.keys(PARAMS), "return (" + s + ");");
}
const clone = x => JSON.parse(JSON.stringify(x));
function setPath(obj, target, value) {
  const parts = target.replace(/^\$/, "").split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

function makeEnv(cfgPatch) {
  const cfg = JSON.parse(cfgText);
  if (cfgPatch) cfgPatch(cfg);
  return { lib: { fs_ups_fn: fn, fs_ups_config: cfg }, pipe: { ruuid: "exec-0001" } };
}
function evalExpr(expr, doc, env) {
  return compile(expr)(doc, env.lib, env.pipe, () => nowObj, ...Object.values(PARAMS));
}
function mapper(id, input, env) {
  const s = snaps[id];
  const out = s.passThrough ? clone(input) : {};
  s.rows.forEach(([expr, target]) => setPath(out, target, evalExpr(expr, input, env)));
  return clone(out);
}
function router(id, input, env) {
  return snaps[id].routes.filter(([expr]) => evalExpr(expr, input, env)).map(r => r[1]);
}
function http(id, input, env, mocks, calls) {
  const s = snaps[id];
  const url = evalExpr(s.url, input, env);
  calls.push(s.method + " " + url);
  const m = mocks[s.method + " " + url];
  if (!m) throw new Error("No mock for " + s.method + " " + url);
  if (s.body) {
    const body = evalExpr(s.body, input, env);
    if (m.checkBody) m.checkBody(body);
  }
  if (m.status >= 200 && m.status < 300) {
    return { ok: { statusLine: { statusCode: m.status }, headers: {}, entity: clone(m.body), original: clone(input) } };
  }
  return { err: { error: "Failed to execute HTTP request", reason: "Request failed with status code = " + m.status, error_entity: m.body == null ? null : clone(m.body), original: clone(input) } };
}

function runQuote(body, mocks, cfgPatch) {
  const env = makeEnv(cfgPatch);
  const out = [];
  const calls = [];
  let d = mapper("01", body, env);
  if (router("02", d, env).includes("invalid")) { out.push(mapper("E1", d, env)); return { out, calls }; }

  let h = http("03", d, env, mocks, calls);
  if (h.err) { out.push(mapper("E2", h.err, env)); return { out, calls }; }
  d = mapper("04b", mapper("04a", mapper("04", h.ok, env), env), env);
  if (router("05", d, env).includes("invalid")) { out.push(mapper("E3", d, env)); return { out, calls }; }

  h = http("06", d, env, mocks, calls);
  if (h.err) { out.push(mapper("E2", h.err, env)); return { out, calls }; }
  d = mapper("07b", mapper("07a", mapper("07", h.ok, env), env), env);
  if (router("08", d, env).includes("invalid")) { out.push(mapper("E3", d, env)); return { out, calls }; }

  d = mapper("12", d, env);
  h = http("13", d, env, mocks, calls);
  if (h.err) { out.push(mapper("E4", h.err, env)); return { out, calls }; }
  d = mapper("14", h.ok, env);
  out.push(router("15", d, env).includes("ok") ? mapper("16", d, env) : mapper("E5", d, env));
  return { out, calls };
}

// ---------- mock data ----------
const FS = PARAMS._fsBaseUrl;
const UPS_URL = "POST https://wwwcie.ups.com/api/rating/v2409/Shoptimeintransit";
const upsSample = JSON.parse(fs.readFileSync(path.join(root, "samples", "ups-rate-response.synthetic.json"), "utf8"));
const goodFields = {
  receiver: 12345, receiver_phone: "(555) 010-0100", address_line_1: "100 Main St", address_line_2: "",
  city: "Longwood", state: "fl", zip_code: "32779", delivery_type: "Residential", package_weight_lbs: "5",
  ship_date: "2026-10-26"
};
function items(fields, serviceItemId) {
  return { status: 200, body: { requested_items: [{ id: 900, service_item_id: serviceItemId || 42, custom_fields: fields }] } };
}
const requester = { status: 200, body: { requester: { id: 12345, first_name: "Jane", last_name: "Sample", primary_email: "jane@example.com", department_ids: [501] } } };
function baseMocks(over) {
  return Object.assign({
    ["GET " + FS + "/api/v2/tickets/46/requested_items"]: items(goodFields),
    ["GET " + FS + "/api/v2/requesters/12345"]: requester,
    [UPS_URL]: { status: 200, body: upsSample }
  }, over || {});
}

let passed = 0;
function scenario(name, f) {
  try { f(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name + "\n     " + (e.stack || e.message)); process.exitCode = 1; }
}
const eq = assert.deepStrictEqual;
function one(res) { eq(res.out.length, 1, "exactly one response document"); return res.out[0]; }

scenario("S1 happy path returns options and summary", () => {
  let sent = null;
  const mocks = baseMocks({ [UPS_URL]: { status: 200, body: upsSample, checkBody: b => { sent = b; } } });
  const res = runQuote({ ticketId: 46, requestId: "6f0c7a2e-1b2c-4d5e-8f90-0123456789ab" }, mocks);
  const r = one(res);
  eq(r.status, "ok"); eq(r.httpStatus, 200); eq(r.ticketId, 46);
  eq(r.requestId, "6f0c7a2e-1b2c-4d5e-8f90-0123456789ab"); eq(r.quoteId, "exec-0001");
  eq(r.options.map(o => o.serviceCode), ["03", "01", "14"]);
  eq(r.options.map(o => o.tags), [["Lowest cost"], [], ["Fastest"]]);
  eq(r.options[0].amount, 35.1); eq(r.options[0].listAmount, 39.43);
  eq(r.shipmentSummary, {
    receiverName: "Jane Sample", addressLines: ["100 Main St"], city: "Longwood", state: "FL", zip: "32779", residential: true,
    weightLbs: 5, shipDate: "2026-10-26"
  });
  eq(r.alerts, ["Your invoice may vary from the displayed reference rates"]);
  eq(res.calls.length, 3);
  eq(res.calls.some(c => c.indexOf("/departments/") >= 0), false);
  eq(sent.RateRequest.Shipment.ShipTo.Address.StateProvinceCode, "FL");
  eq(sent.RateRequest.Shipment.DeliveryTimeInformation.Pickup.Date, "20261026");
  eq(sent.RateRequest.Request.TransactionReference.CustomerContext, "6f0c7a2e-1b2c-4d5e-8f90-0123456789ab");
});
scenario("S2 bad ticketId returns 400 without any call", () => {
  const res = runQuote({ ticketId: "abc" }, baseMocks());
  const r = one(res);
  eq([r.status, r.httpStatus, r.code], ["invalid", 400, "INVALID_REQUEST"]);
  eq(r.requestId, "exec-0001"); eq(res.calls.length, 0);
});
scenario("S3 ticket not found", () => {
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/tickets/46/requested_items"]: { status: 404, body: { message: "Not found" } } })));
  eq([r.status, r.code, r.error.stage, r.error.upstreamStatus], ["invalid", "TICKET_NOT_FOUND", "items", 404]);
});
scenario("S4 not a UPS ticket (other service item)", () => {
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/tickets/46/requested_items"]: items(goodFields, 99) }), c => { c.fs.serviceItemId = 42; }));
  eq([r.status, r.code], ["invalid", "NOT_A_UPS_TICKET"]);
});
scenario("S5 form problems are listed together", () => {
  const f = Object.assign({}, goodFields, { receiver_phone: "123", zip_code: "", ship_date: "2026-10-01" });
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/tickets/46/requested_items"]: items(f) })));
  eq(r.code, "INVALID_SHIPMENT"); eq(r.problems.map(p => p.field), ["phone", "zip", "shipDate"]);
});
scenario("S6 receiver looked up by email, not found", () => {
  const f = Object.assign({}, goodFields, { receiver: "Ghost@Example.com" });
  const r = one(runQuote({ ticketId: 46 }, baseMocks({
    ["GET " + FS + "/api/v2/tickets/46/requested_items"]: items(f),
    ["GET " + FS + "/api/v2/requesters?email=ghost%40example.com"]: { status: 200, body: { requesters: [] } }
  })));
  eq(r.problems.map(p => p.field), ["receiver"]);
});
scenario("S7 receiver with two departments still gets a quote", () => {
  const two = { status: 200, body: { requester: { id: 12345, first_name: "Jane", last_name: "Sample", department_ids: [501, 502] } } };
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/requesters/12345"]: two })));
  eq(r.status, "ok");
});
scenario("S8 receiver without a name is reported", () => {
  const noName = { status: 200, body: { requester: { id: 12345, first_name: null, last_name: null, department_ids: [] } } };
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/requesters/12345"]: noName })));
  eq([r.code, r.problems.map(p => p.field)], ["INVALID_SHIPMENT", ["receiver"]]);
});
scenario("S9 UPS validation error becomes invalid with UPS message", () => {
  const body = { response: { errors: [{ code: "111285", message: "The postal code 32779 is invalid for FL." }] } };
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ [UPS_URL]: { status: 400, body } })));
  eq([r.status, r.httpStatus, r.code, r.message], ["invalid", 422, "UPS_VALIDATION", "The postal code 32779 is invalid for FL."]);
});
scenario("S10 UPS unavailable is retryable", () => {
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ [UPS_URL]: { status: 503, body: null } })));
  eq([r.status, r.code, r.retryable], ["error", "UPS_UNAVAILABLE", true]);
});
scenario("S11 UPS returns nothing rateable", () => {
  const only99 = { RateResponse: { Response: { ResponseStatus: { Code: "1" } }, RatedShipment: { Service: { Code: "99" } } } };
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ [UPS_URL]: { status: 200, body: only99 } })));
  eq([r.status, r.code], ["error", "UPS_NO_OPTIONS"]);
});
scenario("S12 Freshservice rate limit on the receiver call", () => {
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/requesters/12345"]: { status: 429, body: null } })));
  eq([r.status, r.code, r.retryable, r.error.stage], ["error", "FS_RATE_LIMITED", true, "receiver"]);
});
scenario("S14 receiver not found by ID (404)", () => {
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/requesters/12345"]: { status: 404, body: { message: "Not found" } } })));
  eq([r.status, r.code], ["invalid", "RECEIVER_NOT_FOUND"]);
});
scenario("S13 allowed services filter", () => {
  const r = one(runQuote({ ticketId: 46 }, baseMocks(), c => { c.allowedServiceCodes = ["03"]; }));
  eq(r.options.map(o => o.serviceCode), ["03"]); eq(r.options[0].tags, ["Lowest cost", "Fastest"]);
});

scenario("S15 real RatedShipment: amounts match the UPS page", () => {
  const realRated = JSON.parse(fs.readFileSync(path.join(root, "samples", "ups-rated-shipment.real.json"), "utf8"));
  const body = { RateResponse: { Response: { ResponseStatus: { Code: "1" } }, RatedShipment: [realRated] } };
  const r = one(runQuote({ ticketId: 46 }, baseMocks({ [UPS_URL]: { status: 200, body } })));
  eq(r.status, "ok"); eq(r.options.length, 1);
  const o = r.options[0];
  eq([o.serviceName, o.amount, o.listAmount, o.arrivalDate, o.arrivalTime], ["UPS 2nd Day Air", 46.34, 173.19, "2026-11-02", "23:00"]);
  eq(o.tags, ["Lowest cost", "Fastest"]);
});

// Write example responses for the guide
const exOk = runQuote({ ticketId: 46, requestId: "6f0c7a2e-1b2c-4d5e-8f90-0123456789ab" }, baseMocks()).out;
const exInvalid = runQuote({ ticketId: 46 }, baseMocks({ ["GET " + FS + "/api/v2/tickets/46/requested_items"]: items(Object.assign({}, goodFields, { receiver_phone: "123", zip_code: "" })) })).out;
fs.writeFileSync(path.join(root, "samples", "quote-response-ok.simulated.json"), JSON.stringify(exOk, null, 2) + "\n");
fs.writeFileSync(path.join(root, "samples", "quote-response-invalid.simulated.json"), JSON.stringify(exInvalid, null, 2) + "\n");

console.log("\n" + passed + " scenarios passed" + (process.exitCode ? ", some FAILED" : ""));
