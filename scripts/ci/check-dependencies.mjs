#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const ALLOWED_LICENSES = new Set([
  "MIT",
  "MIT-0",
  "MIT OR Apache-2.0",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "Unlicense",
  "MPL-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
]);

/**
 * Explicitly reviewed runtime advisories that have documented mitigations
 * and cannot be patched without a breaking major-version migration.
 */
const DOCUMENTED_PROD_EXCEPTIONS = new Map([
  [
    "1243066",
    {
      moduleName: "zod",
      reason:
        "Zod v3 -> v4 é atualização major incompatível em todo o monorepo; mitigado em runtime via limites de payload do Fastify e restrições de upload/paginação.",
    },
  ],
]);

function resolvePnpmInvoker() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath?.toLowerCase().includes("pnpm")) {
    if (/\.(c|m)?js$/i.test(npmExecPath)) {
      return { bin: process.execPath, prefixArgs: [npmExecPath] };
    }
    return { bin: npmExecPath, prefixArgs: [] };
  }
  const direct = spawnSync("pnpm", ["--version"], { stdio: "ignore" });
  if (direct.status === 0) {
    return { bin: "pnpm", prefixArgs: [] };
  }
  return { bin: "corepack", prefixArgs: ["pnpm"] };
}

function runPnpm(invoker, args, allowNonZero = false) {
  const result = spawnSync(invoker.bin, [...invoker.prefixArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (!allowNonZero && result.status !== 0) {
    throw new Error(
      `Comando pnpm ${args.join(" ")} falhou (exit=${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }

  return result;
}

function validateLicenses(invoker, label, args) {
  const res = runPnpm(invoker, args, false);
  const parsed = JSON.parse(res.stdout || "{}");
  const violations = [];
  const counts = [];

  for (const [license, entries] of Object.entries(parsed)) {
    const count = Array.isArray(entries) ? entries.length : 0;
    counts.push([license, count]);
    if (!ALLOWED_LICENSES.has(license)) {
      const names = Array.isArray(entries) ? entries.map((e) => e.name).join(", ") : "";
      violations.push(`${license}: ${names}`);
    }
  }

  counts.sort((a, b) => b[1] - a[1]);
  console.log(`[audit:deps] Licenças (${label}): ${JSON.stringify(counts)}`);

  if (violations.length > 0) {
    throw new Error(`Licenças não aprovadas detectadas em ${label}:\n${violations.join("\n")}`);
  }
}

function validateProductionAudit(invoker) {
  const res = runPnpm(invoker, ["audit", "--prod", "--json"], true);
  const raw = res.stdout?.trim();
  if (!raw) {
    throw new Error(`pnpm audit --prod --json não retornou saída JSON válida: ${res.stderr}`);
  }

  const report = JSON.parse(raw);
  const advisories = report.advisories ?? {};
  const blocking = [];
  const accepted = [];

  for (const [id, advisory] of Object.entries(advisories)) {
    const severity = advisory?.severity ?? "unknown";
    const moduleName = advisory?.module_name ?? "unknown";
    const title = advisory?.title ?? "";

    if (severity === "critical" || severity === "high") {
      const documented = DOCUMENTED_PROD_EXCEPTIONS.get(id);
      if (documented && documented.moduleName === moduleName) {
        accepted.push(`${id} (${severity}, ${moduleName}): ${documented.reason}`);
      } else {
        blocking.push(
          `${id} (${severity}, ${moduleName}): ${title} [patch: ${advisory?.patched_versions ?? "n/a"}]`,
        );
      }
    }
  }

  console.log(`[audit:deps] Metadados prod audit: ${JSON.stringify(report.metadata ?? {})}`);
  for (const item of accepted) {
    console.log(`[audit:deps] Exceção runtime documentada: ${item}`);
  }

  if (blocking.length > 0) {
    throw new Error(
      `CVEs bloqueantes (high/critical) em dependências de produção:\n${blocking.join("\n")}`,
    );
  }
}

function main() {
  const invoker = resolvePnpmInvoker();
  validateLicenses(invoker, "workspace prod", [
    "--filter",
    "./apps/*",
    "--filter",
    "./packages/*",
    "licenses",
    "list",
    "--prod",
    "--json",
  ]);
  validateLicenses(invoker, "monorepo completo", ["licenses", "list", "--json"]);
  validateProductionAudit(invoker);
  console.log("[audit:deps] Auditoria de dependências e licenças aprovada.");
}

main();
