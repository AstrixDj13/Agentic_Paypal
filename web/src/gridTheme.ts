import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid theme driven by the same design tokens as the rest of the app. */
export const gridTheme = themeQuartz.withParams({
  accentColor: "var(--brand-blue)",
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--text)",
  borderColor: "var(--border)",
  headerBackgroundColor: "var(--surface-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  wrapperBorderRadius: 12,
});
