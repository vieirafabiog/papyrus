import { configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetUiLocaleForTests } from "../src/i18n/index.js";

configure({
  asyncUtilTimeout: 10_000,
});

afterEach(() => {
  resetUiLocaleForTests();
});
