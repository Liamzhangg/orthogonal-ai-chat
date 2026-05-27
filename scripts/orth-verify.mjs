import * as m from "../src/lib/orthogonal.ts";

console.log("=== 1. describeOrthogonalEndpoint on sixtyfour/find-email ===");
const desc = await m.describeOrthogonalEndpoint({ api: "sixtyfour", path: "/find-email" });
console.log(JSON.stringify({ acceptsEmpty: desc.acceptsEmpty, summary: desc.summary, errorDetail: desc.errorDetail, nextStepHint: desc.nextStepHint }, null, 2));

console.log("\n=== 2. runOrthogonalApi with correct lead shape ===");
const ok = await m.runOrthogonalApi({ api: "sixtyfour", path: "/find-email", body: { lead: { name: "Logan Head", company: "Whatnot", domain: "whatnot.com" } } });
console.log(JSON.stringify({ isError: ok.isError, isEmpty: ok.isEmpty, hasEmail: ok.hasEmail, summary: ok.summary, requestId: ok.requestId, price: ok.price, dataPreview: ok.dataPreview }, null, 2));

console.log("\n=== 3. runOrthogonalApi with WRONG (flat) body ===");
const bad = await m.runOrthogonalApi({ api: "sixtyfour", path: "/find-email", body: { name: "Logan Head", company: "Whatnot" } });
console.log(JSON.stringify({ isError: bad.isError, isEmpty: bad.isEmpty, summary: bad.summary, errorDetail: bad.errorDetail, nextStepHint: bad.nextStepHint }, null, 2));

console.log("\n=== 4. runOrthogonalApi with empty lead (empty data path) ===");
const empty = await m.runOrthogonalApi({ api: "sixtyfour", path: "/find-email", body: { lead: {} } });
console.log(JSON.stringify({ isError: empty.isError, isEmpty: empty.isEmpty, summary: empty.summary, nextStepHint: empty.nextStepHint }, null, 2));
