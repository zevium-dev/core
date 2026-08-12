const test = { skip() {}, only() {} };
const describe = { only() {} };

test.skip();
test.only();
describe.only();

const only = "business value";
const options = { skip: true, suite: "premium" };

export const allowed = { only, options };
