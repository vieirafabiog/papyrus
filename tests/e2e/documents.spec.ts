import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { type E2eEnvironment, startE2eEnvironment } from "./helpers/e2e-server.js";

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function createSamplePdfBuffer(marker: string): Buffer {
  const safeText = marker.replace(/[()\\]/g, "");
  const streamContent = `BT\n/F1 14 Tf\n72 720 Td\n(${safeText}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += obj;
  }

  const xrefOffset = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "utf8");
}

test.describe("Gestão documental E2E", () => {
  let env: E2eEnvironment;

  test.beforeAll(async () => {
    env = await startE2eEnvironment();
  });

  test.afterAll(async () => {
    await env?.stop();
  });

  test("executa login, envio, processamento, pesquisa, pré-visualização, download e nova versão", async ({
    page,
  }) => {
    const documentTitle = "Contrato Prestação E2E 2026";
    const v1Buffer = createSamplePdfBuffer("DocuFlow E2E Versao 1");
    const v2Buffer = createSamplePdfBuffer("DocuFlow E2E Versao 2 Atualizada");

    // 1. Login no frontend real com CSRF e sessão em cookie HttpOnly
    await page.goto(env.baseUrl);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "DocuFlow" })).toBeVisible();

    await page.getByLabel(/E-mail corporativo/i).fill(env.credentials.email);
    await page.getByLabel(/^Senha/i).fill(env.credentials.password);
    await page.getByRole("button", { name: "Entrar" }).click();

    await expect(page).not.toHaveURL(/\/login$/);

    // 2. Navegação para acervo e envio de documento v1
    await page.getByRole("link", { name: "Documentos" }).first().click();
    await expect(page).toHaveURL(/\/documentos$/);
    await expect(page.getByRole("heading", { name: "Documentos" })).toBeVisible();

    await page.getByRole("button", { name: "Enviar documentos" }).click();
    const uploadDialog = page.getByRole("dialog", { name: "Enviar documentos" });
    await expect(uploadDialog).toBeVisible();

    await uploadDialog.getByLabel("Título do documento").fill(documentTitle);
    await uploadDialog.getByLabel(/Categoria/i).click();
    await page.getByRole("option", { name: env.categoryName }).click();
    await uploadDialog.getByLabel("Pasta de destino").click();
    await page.getByRole("option", { name: env.folderName }).click();
    await uploadDialog.getByLabel("Observação da versão").fill("Versão inicial E2E");

    await uploadDialog.getByLabel("Selecionar arquivos para envio").setInputFiles({
      name: "contrato-e2e-v1.pdf",
      mimeType: "application/pdf",
      buffer: v1Buffer,
    });

    await uploadDialog.getByRole("button", { name: "Iniciar envio (1)" }).click();
    await expect(uploadDialog.getByText(/Em análise|Disponível/)).toBeVisible();
    await uploadDialog.getByRole("button", { name: "Fechar", exact: true }).click();

    // 3. Pesquisa no PostgreSQL e abertura do documento
    await page.getByLabel("Pesquisar documento").fill(documentTitle);
    const docRow = page.locator("tr", { hasText: documentTitle });
    await expect(docRow).toBeVisible();

    await page.getByRole("button", { name: `Abrir ${documentTitle}` }).click();
    await expect(page).toHaveURL(/\/documentos\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: documentTitle })).toBeVisible();

    // 4. Aguardar processamento assíncrono pelo worker até liberação em Disponível
    await expect(page.getByText("Disponível").first()).toBeVisible();
    await expect(page.getByText("Versão v1")).toBeVisible();

    // 5. Pré-visualização segura inline do PDF (Blob URL privada)
    const v1PreviewFrame = page.locator(
      'iframe[title="Pré-visualização do PDF: contrato-e2e-v1.pdf"]',
    );
    await expect(v1PreviewFrame).toBeVisible();
    await expect(v1PreviewFrame).toHaveAttribute("src", /^blob:/);

    // 6. Download autorizado da versão v1 e validação dos bytes entregues
    const [v1Download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Baixar versão v1" }).click(),
    ]);
    expect(v1Download.suggestedFilename()).toBe("contrato-e2e-v1.pdf");
    const v1DownloadedPath = await v1Download.path();
    expect(v1DownloadedPath).toBeTruthy();
    if (v1DownloadedPath) {
      const downloadedBytes = await readFile(v1DownloadedPath);
      expect(sha256Hex(downloadedBytes)).toBe(sha256Hex(v1Buffer));
    }

    // 7. Criação de nova versão v2 pela interface de detalhes
    await page.getByRole("button", { name: "Enviar nova versão" }).first().click();
    const versionDialog = page.getByRole("dialog", { name: "Enviar documentos" });
    await expect(versionDialog).toBeVisible();

    await versionDialog.getByLabel("Observação da versão").fill("Aditivo v2 validado E2E");
    await versionDialog.getByLabel("Selecionar arquivos para envio").setInputFiles({
      name: "contrato-e2e-v2.pdf",
      mimeType: "application/pdf",
      buffer: v2Buffer,
    });

    await versionDialog.getByRole("button", { name: "Iniciar envio (1)" }).click();
    await expect(versionDialog.getByText(/Em análise|Disponível/)).toBeVisible();
    await versionDialog.getByRole("button", { name: "Fechar", exact: true }).click();

    // Aguardar worker processar v2 e UI atualizar versão vigente, preview e histórico
    await expect(page.getByText("Versão v2")).toBeVisible();
    const v2PreviewFrame = page.locator(
      'iframe[title="Pré-visualização do PDF: contrato-e2e-v2.pdf"]',
    );
    await expect(v2PreviewFrame).toBeVisible();
    await expect(v2PreviewFrame).toHaveAttribute("src", /^blob:/);

    const historyTable = page.getByRole("table", {
      name: "Histórico de versões do documento",
    });
    const v2Row = historyTable.locator("tr", { hasText: "v2" });
    await expect(v2Row.getByText("Vigente")).toBeVisible();
    await expect(v2Row.getByText("Aditivo v2 validado E2E")).toBeVisible();
    await expect(v2Row.getByText("Disponível")).toBeVisible();

    const v1HistoryRow = historyTable.locator("tr", { hasText: "v1" });
    await expect(v1HistoryRow.getByText("contrato-e2e-v1.pdf")).toBeVisible();
    await expect(v1HistoryRow.getByText("Disponível")).toBeVisible();

    // Validar download autorizado da nova versão v2
    const [v2Download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Baixar versão v2" }).click(),
    ]);
    expect(v2Download.suggestedFilename()).toBe("contrato-e2e-v2.pdf");
    const v2DownloadedPath = await v2Download.path();
    expect(v2DownloadedPath).toBeTruthy();
    if (v2DownloadedPath) {
      const downloadedBytesV2 = await readFile(v2DownloadedPath);
      expect(sha256Hex(downloadedBytesV2)).toBe(sha256Hex(v2Buffer));
    }
  });
});
