describe.only("focused fixture", () => {
  test.skip("skipped fixture", () => undefined);
});

const modifier = "only";
test[modifier]("computed fixture", () => undefined);
test?.skip("optional fixture", () => undefined);

const focused = test.only;
focused("aliased fixture", () => undefined);

const { skip: skipped, only: selected } = suite;
skipped("destructured skip", () => undefined);
selected("destructured focus", () => undefined);

fdescribe("suite alias", () => undefined);
