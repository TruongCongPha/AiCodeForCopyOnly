// Tests for snaplogic/expression-libraries/*.expr
// Run: node snaplogic/tests/test_expressions.js
//
// SnapLogic is not JavaScript. These tests emulate the two SnapLogic object
// methods the libraries use (.get(key, default) and .extend(obj)) and check the
// logic. They do not prove SnapLogic accepts the syntax. Validate the pipeline
// in Designer as well.
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

// SnapLogic-like object methods. Defining a property named "get" on
// Object.prototype breaks Node (it looks like a getter descriptor), so the test
// copy of the library calls __slGet/__slExtend instead. The .expr files on disk
// are not changed.
Object.defineProperty(Object.prototype, "__slGet", {
  value: function (key, dflt) {
    const has = Object.prototype.hasOwnProperty.call(this, key) && this[key] !== undefined;
    return has ? this[key] : (dflt === undefined ? null : dflt);
  },
  enumerable: false, writable: true, configurable: true
});
Object.defineProperty(Object.prototype, "__slExtend", {
  value: function (...objs) { return Object.assign({}, this, ...objs); },
  enumerable: false, writable: true, configurable: true
});

const libDir = path.join(__dirname, "..", "expression-libraries");
const fnText = fs.readFileSync(path.join(libDir, "fs_ups_fn.expr"), "utf8");
const cfgText = fs.readFileSync(path.join(libDir, "fs_ups_config.expr"), "utf8");

// 1. Lint for constructs SnapLogic expressions do not support
const banned = [
  [/\breturn\b/, "return statement"],
  [/=>\s*\{/, "arrow function with a statement block (use => ({ ... }) for objects)"],
  [/\b(const|let|var)\b/, "variable declaration"],
  [/`/, "template literal"],
  [/\.\.\./, "spread operator"],
  [/\?\./, "optional chaining"],
  [/\?\?/, "nullish coalescing"],
  [/===|!==/, "strict equality (use == and !=)"],
  [/Object\.keys|Array\.isArray/, "JavaScript-only helper"]
];
banned.forEach(([re, why]) => {
  assert.ok(!re.test(fnText), "fs_ups_fn.expr contains " + why);
});

const cfg = JSON.parse(cfgText); // config must be plain JSON
// eslint-disable-next-line no-eval
const fnForNode = fnText.replace(/\.get\(/g, ".__slGet(").replace(/\.extend\(/g, ".__slExtend(");
const fn = eval("(" + fnForNode + ")");

let passed = 0;
function t(name, f) {
  try { f(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
const eq = assert.deepStrictEqual;

// --- basics
t("clean", () => { eq(fn.clean(null), ""); eq(fn.clean("  a "), "a"); eq(fn.clean(5), "5"); });
t("toArray", () => { eq(fn.toArray(null), []); eq(fn.toArray({a: 1}), [{a: 1}]); eq(fn.toArray([1]), [1]); });
t("validTicketId", () => {
  eq(fn.validTicketId(46), true); eq(fn.validTicketId(" 46 "), true);
  eq(fn.validTicketId(0), false); eq(fn.validTicketId("abc"), false);
  eq(fn.validTicketId(null), false); eq(fn.validTicketId("1234567890123"), false); eq(fn.validTicketId("-5"), false);
});
t("safeRequestId and transId", () => {
  eq(fn.safeRequestId("abc-123<script>"), "abc-123script");
  eq(fn.transId("6f0c7a2e-1b2c-4d5e-8f90-0123456789ab"), "6f0c7a2e1b2c4d5e8f900123456789ab");
  eq(fn.transId("6f0c7a2e-1b2c-4d5e-8f90-0123456789ab").length, 32);
});

// --- requested items
const items = [
  {id: 1, service_item_id: 99, custom_fields: {}},
  {id: 2, service_item_id: 42, custom_fields: {receiver: 12345, city: "Longwood"}}
];
t("pickItem by id (number and string)", () => {
  eq(fn.pickItem(items, 42).id, 2); eq(fn.pickItem(items, "42").id, 2);
  eq(fn.pickItem(items, 7), null); eq(fn.pickItem(items, null).id, 1);
  eq(fn.pickItem([], 42), null); eq(fn.pickItem(null, 42), null);
});
t("cf", () => {
  eq(fn.cf(items[1], "city"), "Longwood"); eq(fn.cf(items[1], "missing"), null);
  eq(fn.cf(null, "city"), null); eq(fn.cf({id: 3}, "city"), null);
});

// --- receiver
t("receiverRef variants", () => {
  eq(fn.receiverRef(12345), {kind: "id", value: "12345"});
  eq(fn.receiverRef(" 12345 "), {kind: "id", value: "12345"});
  eq(fn.receiverRef("Jane.Sample@Example.com"), {kind: "email", value: "jane.sample@example.com"});
  eq(fn.receiverRef({id: 77, name: "Jane"}), {kind: "id", value: "77"});
  eq(fn.receiverRef({email: "a@b.com"}), {kind: "email", value: "a@b.com"});
  eq(fn.receiverRef({name: "Jane"}), {kind: "unknown", value: null});
  eq(fn.receiverRef("Jane Sample"), {kind: "unknown", value: "Jane Sample"});
  eq(fn.receiverRef(null), null); eq(fn.receiverRef("  "), null);
});
t("requesterUrl", () => {
  const base = "https://pearce-sandbox.freshservice.com";
  eq(fn.requesterUrl(base, {kind: "id", value: "12345"}), base + "/api/v2/requesters/12345");
  eq(fn.requesterUrl(base, {kind: "email", value: "jane+ups@example.com"}), base + "/api/v2/requesters?email=jane%2Bups%40example.com");
  eq(fn.requesterUrl(base, {kind: "unknown", value: "x"}), null); eq(fn.requesterUrl(base, null), null);
});
t("requesterFrom and fullName", () => {
  const r = {id: 1, first_name: "Jane", last_name: "Sample", department_ids: [5]};
  eq(fn.requesterFrom({requester: r}), r);
  eq(fn.requesterFrom({requesters: [r]}), r);
  eq(fn.requesterFrom({requesters: []}), null);
  eq(fn.requesterFrom(null), null);
  eq(fn.fullName(r), "Jane Sample"); eq(fn.fullName({first_name: "Jane"}), "Jane");
  eq(fn.fullName({first_name: "Jane", last_name: null}), "Jane"); eq(fn.fullName(null), "");
});
t("pickDepartment policies", () => {
  eq(fn.pickDepartment(null, "fail"), {id: null, reason: "RECEIVER_NOT_FOUND"});
  eq(fn.pickDepartment({department_ids: []}, "fail"), {id: null, reason: "NO_DEPARTMENT"});
  eq(fn.pickDepartment({department_ids: null}, "fail"), {id: null, reason: "NO_DEPARTMENT"});
  eq(fn.pickDepartment({department_ids: [5]}, "fail"), {id: 5, reason: null});
  eq(fn.pickDepartment({department_ids: [5, 6]}, "fail"), {id: null, reason: "MULTIPLE_DEPARTMENTS"});
  eq(fn.pickDepartment({department_ids: [5, 6]}, "first"), {id: 5, reason: null});
});
t("classFrom name and custom field", () => {
  eq(fn.classFrom({name: " ESS "}, {source: "name"}), "ESS");
  eq(fn.classFrom({name: "IT", custom_fields: {class_code: "ESS"}}, {source: "custom_field", customFieldKey: "class_code"}), "ESS");
  eq(fn.classFrom({name: "IT", custom_fields: {}}, {source: "custom_field", customFieldKey: "class_code"}), "");
  eq(fn.classFrom({name: "IT"}, {source: "custom_field", customFieldKey: null}), "");
  eq(fn.classFrom(null, {source: "name"}), "");
});

// --- form values
t("normalizePhone", () => {
  eq(fn.normalizePhone("(555) 010-0100"), "5550100100");
  eq(fn.normalizePhone("+1 555 010 0100"), "5550100100");
  eq(fn.normalizePhone(null), ""); eq(fn.normalizePhone("123"), "123");
});
t("ymd and isoDate", () => {
  eq(fn.ymd("2026-10-26", "20261022"), "20261026");
  eq(fn.ymd("2026-10-26T00:00:00Z", "20261022"), "20261026");
  eq(fn.ymd("", "20261022"), "20261022"); eq(fn.ymd(null, "20261022"), "20261022");
  eq(fn.ymd("26/10/2026", "20261022"), null);
  eq(fn.isoDate("20261026"), "2026-10-26"); eq(fn.isoDate("2026"), null);
});

const goodShipment = {
  itemFound: true, receiverRef: {kind: "id", value: "12345"}, phone: "5550100100",
  line1: "100 Main St", line2: "", city: "Longwood", state: "FL", zip: "32779",
  residential: true, weight: "5", shipDate: "20261026"
};
t("formProblems: complete form has no problems", () => {
  eq(fn.formProblems(goodShipment, cfg, "20261022"), []);
});
t("formProblems: missing item", () => {
  eq(fn.formProblems({itemFound: false}, cfg, "20261022").map(p => p.field), ["item"]);
  eq(fn.formProblems(null, cfg, "20261022").map(p => p.field), ["item"]);
});
t("formProblems: each bad field is reported", () => {
  const bad = Object.assign({}, goodShipment, {
    receiverRef: null, phone: "123", line1: "", city: "", state: "XX", zip: "3277", weight: "0", shipDate: null
  });
  eq(fn.formProblems(bad, cfg, "20261022").map(p => p.field),
    ["receiver", "phone", "addressLine1", "city", "state", "zip", "weight", "shipDate"]);
});
t("formProblems: limits, unknown receiver, past date, weight text", () => {
  const long = "x".repeat(36);
  const bad = Object.assign({}, goodShipment, {
    receiverRef: {kind: "unknown", value: "Jane"}, line1: long, line2: long, city: "y".repeat(31),
    zip: "32779-12", weight: "5abc", shipDate: "20261020"
  });
  eq(fn.formProblems(bad, cfg, "20261022").map(p => p.field),
    ["receiver", "addressLine1", "addressLine2", "city", "zip", "weight", "shipDate"]);
  eq(fn.formProblems(Object.assign({}, goodShipment, {weight: "151"}), cfg, "20261022").map(p => p.field), ["weight"]);
  eq(fn.formProblems(Object.assign({}, goodShipment, {weight: "0.5", zip: "32779-4706"}), cfg, "20261022"), []);
});
t("receiverProblems (quote: no department check)", () => {
  eq(fn.receiverProblems({found: true, name: "Jane Sample"}), []);
  eq(fn.receiverProblems({found: true, name: "Jane", departmentReason: "NO_DEPARTMENT"}), []);
  eq(fn.receiverProblems({found: false}).map(p => p.field), ["receiver"]);
  eq(fn.receiverProblems(null).map(p => p.field), ["receiver"]);
  eq(fn.receiverProblems({found: true, name: ""}).map(p => p.message), ["The receiver has no name in Freshservice."]);
});
t("profileProblems (label pipeline)", () => {
  const ok = {found: true, name: "Jane Sample", departmentReason: null};
  eq(fn.profileProblems(ok, null, cfg), []);
  eq(fn.profileProblems(ok, "ESS", cfg), []);
  eq(fn.profileProblems({found: false}, null, cfg).map(p => p.field), ["receiver"]);
  eq(fn.profileProblems(null, null, cfg).map(p => p.field), ["receiver"]);
  eq(fn.profileProblems({found: true, name: "", departmentReason: "NO_DEPARTMENT"}, null, cfg).map(p => p.field), ["receiver", "department"]);
  eq(fn.profileProblems({found: true, name: "J", departmentReason: "MULTIPLE_DEPARTMENTS"}, null, cfg).map(p => p.field), ["department"]);
  eq(fn.profileProblems(ok, "", cfg).map(p => p.field), ["class"]);
  eq(fn.profileProblems(ok, "Z".repeat(29), cfg).map(p => p.field), ["class"]);
  eq(fn.profileProblems(ok, "Z".repeat(28), cfg), []);
});

// --- UPS rate request
t("buildRateRequest: residential, no declared value, empty line 2 dropped", () => {
  const s = Object.assign({}, goodShipment, {receiverName: "Jane Sample"});
  const body = fn.buildRateRequest(s, cfg, {requestOption: "Shoptimeintransit", customerContext: "req-1"});
  const sh = body.RateRequest.Shipment;
  eq(body.RateRequest.Request.RequestOption, "Shoptimeintransit");
  eq(body.RateRequest.Request.TransactionReference.CustomerContext, "req-1");
  eq(sh.Shipper.Address, sh.ShipFrom.Address);
  eq(sh.ShipTo.Name, "PEARCE SERVICES");
  eq(sh.ShipTo.Address.AddressLine, ["100 Main St"]);
  eq(sh.ShipTo.Address.ResidentialAddressIndicator, "");
  eq(sh.Package.PackageWeight.Weight, "5");
  eq(sh.ShipmentTotalWeight.Weight, "5");
  eq(sh.Package.PackageServiceOptions, undefined);
  eq(sh.DeliveryTimeInformation, {PackageBillType: "03", Pickup: {Date: "20261026"}});
  eq(sh.PaymentDetails.ShipmentCharge.BillShipper.AccountNumber, cfg.shipperNumber);
});
t("buildRateRequest: business, declared value, line 2, no company", () => {
  const c = JSON.parse(cfgText);
  c.defaults.declaredValue = 999; c.defaults.receiverCompany = "";
  const s = Object.assign({}, goodShipment, {residential: false, line2: "Apt 4", weight: "5.50", receiverName: "Jane Sample"});
  const sh = fn.buildRateRequest(s, c, {requestOption: "Shoptimeintransit", customerContext: "r"}).RateRequest.Shipment;
  eq(sh.ShipTo.Name, "Jane Sample");
  eq(sh.ShipTo.Address.AddressLine, ["100 Main St", "Apt 4"]);
  eq("ResidentialAddressIndicator" in sh.ShipTo.Address, false);
  eq(sh.Package.PackageWeight.Weight, "5.5");
  eq(sh.Package.PackageServiceOptions.DeclaredValue, {CurrencyCode: "USD", MonetaryValue: "999"});
});

// --- UPS rate response (synthetic sample, not a real UPS response)
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "samples", "ups-rate-response.synthetic.json"), "utf8"));
const rated = fn.toArray(sample.RateResponse.RatedShipment);
t("option: negotiated, published, transit, names", () => {
  const o = rated.map(r => fn.option(r, cfg, fn.negotiated(r), fn.published(r)));
  eq(o[0].serviceCode, "03"); eq(o[0].serviceName, "UPS Ground");
  eq(o[0].amount, 35.10); eq(o[0].negotiated, true); eq(o[0].publishedAmount, 39.43);
  eq(o[0].arrivalDate, "2026-10-30"); eq(o[0].arrivalTime, "23:00"); eq(o[0].businessDays, "4");
  eq(o[0].guaranteed, false); eq(o[0].amountSource, "shipment"); eq(o[0].listAmount, 39.43); eq(o[0].alerts, ["Your invoice may vary from the displayed reference rates"]);
  eq(o[1].serviceName, "UPS Next Day Air"); eq(o[1].amount, 250.75); eq(o[1].negotiated, false);
  eq(o[1].arrivalTime, "10:30"); eq(o[1].guaranteed, true); eq(o[1].businessDays, "1");
  eq(o[2].serviceName, "UPS Next Day Air Early"); eq(o[2].arrivalTime, "08:00");
  eq(o[3].serviceName, "UPS service 99"); eq(o[3].amount, null); eq(o[3].arrivalDate, null);
});
// --- amounts, checked against a real UPS RatedShipment and what the UPS page shows
const real = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "samples", "ups-rated-shipment.real.json"), "utf8"));
const realOpt = fn.option(real, cfg, fn.negotiated(real), fn.published(real));
t("amounts match the UPS page for the real 2nd Day Air sample", () => {
  eq(realOpt.amount, 46.34);               // price shown by UPS
  eq(realOpt.listAmount, 173.19);          // struck-through price shown by UPS
  eq(realOpt.publishedAmount, 173.19);
  eq(realOpt.negotiatedAmount, 46.34);
  eq(realOpt.negotiated, true);
  eq(realOpt.amountSource, "package");
  eq(realOpt.shipmentLevelNegotiated, 171.46); // kept for diagnostics only, never used for the price
  eq(realOpt.currency, "USD");
});
t("real sample: service, arrival, alerts and guarantee", () => {
  eq(realOpt.serviceCode, "02"); eq(realOpt.serviceName, "UPS 2nd Day Air");
  eq(realOpt.arrivalDate, "2026-11-02"); eq(realOpt.arrivalTime, "23:00"); eq(realOpt.dayOfWeek, "MON");
  eq(realOpt.businessDays, "2");
  eq(realOpt.alertCodes, ["112237", "110971", "110920"]); eq(realOpt.alerts.length, 3);
  eq(realOpt.guaranteed, false); // GuaranteedDelivery has no DeliveryByTime and the UPS page shows no medal
});
t("negotiated(): package sum, single package object, missing package, none", () => {
  eq(fn.negotiated(real), {amount: 46.34, source: "package"});
  const two = JSON.parse(JSON.stringify(real));
  two.RatedPackage.push(JSON.parse(JSON.stringify(real.RatedPackage[0])));
  two.RatedPackage[1].NegotiatedCharges.TotalCharge.MonetaryValue = "20.10";
  eq(fn.negotiated(two), {amount: 66.44, source: "package"});
  const single = JSON.parse(JSON.stringify(real)); single.RatedPackage = real.RatedPackage[0];
  eq(fn.negotiated(single), {amount: 46.34, source: "package"});
  const mixed = JSON.parse(JSON.stringify(two)); delete mixed.RatedPackage[1].NegotiatedCharges;
  eq(fn.negotiated(mixed), {amount: 171.46, source: "shipment"});   // not every package negotiated: fall back
  const noPkg = JSON.parse(JSON.stringify(real)); delete noPkg.RatedPackage;
  eq(fn.negotiated(noPkg), {amount: 171.46, source: "shipment"});
  const none = JSON.parse(JSON.stringify(noPkg)); delete none.NegotiatedRateCharges;
  eq(fn.negotiated(none), {amount: null, source: null});
  eq(fn.negotiated({}), {amount: null, source: null});
});
t("published(): value, missing, text", () => {
  eq(fn.published(real), 173.19); eq(fn.published({}), null); eq(fn.published({TotalCharges: {MonetaryValue: "n/a"}}), null);
});
t("option: no negotiated rate means published price and no strike-through", () => {
  const noNeg = {Service: {Code: "03"}, TotalCharges: {CurrencyCode: "USD", MonetaryValue: "39.43"}};
  const o = fn.option(noNeg, cfg, fn.negotiated(noNeg), fn.published(noNeg));
  eq([o.amount, o.listAmount, o.negotiated, o.amountSource], [39.43, null, false, "published"]);
  const none = fn.option({Service: {Code: "99"}}, cfg, fn.negotiated({}), fn.published({}));
  eq([none.amount, none.amountSource, fn.keepOption(none, [])], [null, null, false]);
});
t("option: negotiated equal to published has no strike-through", () => {
  const same = {Service: {Code: "03"}, TotalCharges: {MonetaryValue: "20.00"}, RatedPackage: {NegotiatedCharges: {TotalCharge: {MonetaryValue: "20.00"}}}};
  eq(fn.option(same, cfg, fn.negotiated(same), fn.published(same)).listAmount, null);
});
t("negotiated(): rounding avoids float artifacts", () => {
  const f = {RatedPackage: [{NegotiatedCharges: {TotalCharge: {MonetaryValue: "0.10"}}}, {NegotiatedCharges: {TotalCharge: {MonetaryValue: "0.20"}}}]};
  eq(fn.negotiated(f).amount, 0.3);
});

t("keepOption, sort, tag", () => {
  const opts = rated.map(r => fn.option(r, cfg, fn.negotiated(r), fn.published(r))).filter(o => fn.keepOption(o, cfg.allowedServiceCodes)).sort((a, b) => a.amount - b.amount);
  eq(opts.map(o => o.serviceCode), ["03", "01", "14"]);
  const tagged = fn.tag(opts);
  eq(tagged.map(o => o.tags), [["Lowest cost"], [], ["Fastest"]]);
  eq(fn.tag([]), []);
  const only = rated.map(r => fn.option(r, cfg, fn.negotiated(r), fn.published(r))).filter(o => fn.keepOption(o, ["01", "14"]));
  eq(only.map(o => o.serviceCode), ["01", "14"]);
});
t("toArray handles a single RatedShipment object", () => {
  eq(fn.toArray(sample.RateResponse.RatedShipment[0]).length, 1);
});

// --- errors
const realErr = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "samples", "fs-error-404.real.json"), "utf8"))[0];
t("httpStatus reads statusLine.statusCode from the real error document", () => {
  eq(realErr.status_code, "error");        // the real field is text, not the HTTP code
  eq(fn.httpStatus(realErr), 404);
});
t("httpStatus fallbacks", () => {
  eq(fn.httpStatus({statusLine: {statusCode: 429}}), 429);
  eq(fn.httpStatus({statusLine: {statusCode: "503"}}), 503);
  eq(fn.httpStatus({status_code: "error", reason: "Got response 502 - Bad Gateway from the endpoint"}), 502);
  eq(fn.httpStatus({headers: {status: "403 Forbidden"}}), 403);
  eq(fn.httpStatus({status_code: "error", reason: "Connection refused"}), null);
  eq(fn.httpStatus({error: "Connection timed out"}), null);
  eq(fn.httpStatus({statusLine: {statusCode: "x"}, reason: "Got response 500 - Server Error from the endpoint"}), 500);
});
t("fsError mapping", () => {
  eq(fn.fsError(404, "items", "", {}).code, "TICKET_NOT_FOUND");
  eq(fn.fsError(404, "receiver", "", {}).code, "RECEIVER_NOT_FOUND");
  eq(fn.fsError(404, "department", "", {}).code, "DEPARTMENT_NOT_FOUND");
  eq(fn.fsError(403, "items", {message: "denied"}, {}).code, "FS_AUTH");
  eq(fn.fsError(403, "items", {message: "denied"}, {}).detail, "denied");
  eq(fn.fsError(429, "receiver", null, null).retryable, true);
  eq(fn.fsError(null, "items", "timeout", null).code, "FS_UNAVAILABLE");
  eq(fn.fsError(500, "items", null, null).source, "FRESHSERVICE");
});
t("fsError with the real 404 document", () => {
  const e = fn.fsError(fn.httpStatus(realErr), realErr.original.ctx.stage, realErr.entity, realErr.headers);
  eq([e.status, e.httpStatus, e.code, e.retryable], ["invalid", 404, "TICKET_NOT_FOUND", false]);
  eq([e.source, e.stage, e.upstreamStatus], ["FRESHSERVICE", "items", 404]);
  eq(e.detail, null);                       // empty text/html body gives no detail
  eq(e.rateLimitRemaining, 158); eq(e.retryAfter, null);
});
t("fsError: Retry-After header in either case, text bodies truncated", () => {
  eq(fn.fsError(429, "items", null, {"Retry-After": "30"}).retryAfter, 30);
  eq(fn.fsError(429, "items", null, {"retry-after": "12"}).retryAfter, 12);
  eq(fn.fsError(429, "items", null, {"retry-after": "soon"}).retryAfter, null);
  eq(fn.fsError(500, "items", "x".repeat(900), {}).detail.length, 500);
  eq(fn.fsError(500, "items", "   ", {}).detail, null);
});
t("upsError mapping", () => {
  const ent = {response: {errors: [{code: "111210", message: "The requested service is unavailable between the selected locations."}]}};
  const e = fn.upsError(400, ent);
  eq(e.status, "invalid"); eq(e.code, "UPS_VALIDATION"); eq(e.httpStatus, 422);
  eq(e.message, "The requested service is unavailable between the selected locations."); eq(e.details.length, 1);
  eq(fn.upsError(401, null).code, "UPS_AUTH");
  eq(fn.upsError(503, null).retryable, true);
  eq(fn.upsError(null, "socket timeout").code, "UPS_UNAVAILABLE");
  eq(fn.upsError(400, "not json").message, "UPS rejected the shipment details.");
  eq(fn.upsError(400, "").message, "UPS rejected the shipment details."); eq(fn.upsError(400, "").details, []);
});

console.log("\n" + passed + " test groups passed" + (process.exitCode ? ", some FAILED" : ""));
