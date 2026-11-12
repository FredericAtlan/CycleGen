import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    name: "cyclegen/pre-existing-debt",
    rules: {
      // eslint-plugin-react-hooks v7 compiler rules — not enforced before Next 16 ESLint migration
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/static-components": "off",
      "react-hooks/immutability": "off",
    },
  },
  {
    name: "cyclegen/pre-existing-file-overrides",
    files: [
      "src/app/not-found.tsx",
      "src/components/CycleLibraryTable.tsx",
      "src/components/export/ResultsAnalyseStudio.tsx",
      "src/components/ide/IdeWorkspace.tsx",
      "src/lib/cycleLibrary.ts",
      "src/lib/exportWorkbook.ts",
    ],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
      "react-hooks/rules-of-hooks": "off",
      "prefer-const": "off",
    },
  },
];
