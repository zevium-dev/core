import { reexportedCheck, verify } from "./test-wrapper";
import * as runners from "./test-wrapper";

verify.only("wrapper focus", () => undefined);
runners.assignedVerify.only("assigned wrapper focus", () => undefined);
runners.wrapped.verify.skip("namespace wrapper skip", () => undefined);
const reexportedFocus = reexportedCheck[`on${"ly"}`];
reexportedFocus("computed re-export focus", () => undefined);
