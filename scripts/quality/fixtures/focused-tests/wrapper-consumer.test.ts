import { verify } from "./test-wrapper";
import * as runners from "./test-wrapper";

verify.only("wrapper focus", () => undefined);
runners.assignedVerify.only("assigned wrapper focus", () => undefined);
runners.wrapped.verify.skip("namespace wrapper skip", () => undefined);
