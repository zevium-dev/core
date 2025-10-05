// @ts-check

/** @type {import("eslint").Rule.RuleModule} */
const preferArrayAtRule = {
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed && node.property.type === "Literal" && typeof node.property.value === "number") {
          const src = context.sourceCode.getText(node.object);
          const idx = node.property.value;
          context.report({
            data: { array: src, index: `${idx}` },
            fix(fixer) {
              return fixer.replaceText(node, `${src}.at(${idx})`);
            },
            messageId: "useAt",
            node,
          });
        }
      },
    };
  },
  meta: {
    fixable: "code",
    messages: {
      useAt: "Use {{array}}.at({{index}}) instead of {{array}}[{{index}}].",
    },
    type: "suggestion",
  },
};

const rules = {
  "prefer-array-at": preferArrayAtRule,
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  rules: {
    "prefer-array-at": preferArrayAtRule,
  },
};

/** @type {Record<string, import("eslint").Linter.Config>} */
const configs = {
  recommended: {
    plugins: {
      "prefer-array-at": {
        rules,
      },
    },
    rules: {
      "prefer-array-at/prefer-array-at": "warn",
    },
  },
};

export default { ...plugin, configs };
