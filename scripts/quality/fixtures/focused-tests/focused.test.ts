describe.only("focused fixture", () => {
  test.skip("skipped fixture", () => undefined);
});

const modifier = "only";
test[modifier]("computed fixture", () => undefined);
test["on" + "ly"]("concatenated fixture", () => undefined);
test?.skip("optional fixture", () => undefined);

const focused = test.only;
focused("aliased fixture", () => undefined);

let assigned;
assigned = test.only;
assigned("assigned fixture", () => undefined);

let destructuredAssignment;
({ only: destructuredAssignment } = test);
destructuredAssignment("destructured assignment", () => undefined);

test.each([[1]])["on" + "ly"]("chained fixture", () => undefined);

const { skip: skipped, only: selected } = suite;
skipped("destructured skip", () => undefined);
selected("destructured focus", () => undefined);

fdescribe("suite alias", () => undefined);
