import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildStorageProviderContractScenarios } from "@papyrus/storage-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createLocalStorageProvider } from "../src/index.js";

describe("LocalStorageProvider contract suite", () => {
  const scenarios = buildStorageProviderContractScenarios();
  let rootDirectory = "";

  beforeAll(async () => {
    rootDirectory = await mkdtemp(path.join(os.tmpdir(), "papyrus-local-contract-"));
  });

  afterAll(async () => {
    if (rootDirectory) {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const provider = createLocalStorageProvider({ rootDirectory });
      await scenario.run({
        provider,
        keyPrefix: `org/contract-org/documents/doc-${index + 1}`,
      });
    });
  }
});
