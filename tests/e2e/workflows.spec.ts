import { expect, test } from "@playwright/test";
import { type E2eEnvironment, startE2eEnvironment } from "./helpers/e2e-server.js";

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

test.describe("Fluxo de revisão e aprovação E2E", () => {
  let env: E2eEnvironment;

  test.beforeAll(async () => {
    env = await startE2eEnvironment();
  });

  test.afterAll(async () => {
    await env?.stop();
  });

  test.beforeEach(async ({ page }) => {
    await page.context().addInitScript(() => {
      window.localStorage.setItem("papyrus_ui_locale", "pt-BR");
    });
  });

  test("executa envio para aprovação, solicitação de ajuste, nova versão, aprovação final e histórico", async ({
    page,
    browser,
  }) => {
    const documentTitle = "Contrato Fluxo Aprovação E2E 2026";
    const adjustmentComment = "Ajustar cláusula de vigência no anexo contratual.";
    const step1ApprovalComment = "Revisão jurídica da v2 aprovada sem ressalvas.";
    const step2ApprovalComment = "Aprovação final concedida para publicação da v2.";

    const v1Buffer = createSamplePdfBuffer("papyrus Workflow v1");
    const v2Buffer = createSamplePdfBuffer("papyrus Workflow v2 Corrigida");

    // 1. Login do solicitante/aprovador final e envio da versão inicial v1
    await page.goto(env.baseUrl);
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel(/E-mail corporativo/i).fill(env.credentials.email);
    await page.getByLabel(/^Senha/i).fill(env.credentials.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).not.toHaveURL(/\/login$/);

    await page.getByRole("link", { name: "Documentos" }).first().click();
    await expect(page).toHaveURL(/\/documents$/);

    await page.getByRole("button", { name: "Enviar documentos" }).first().click();
    const uploadDialog = page.getByRole("dialog", { name: "Enviar documentos" });
    await uploadDialog.getByLabel("Título do documento").fill(documentTitle);
    await uploadDialog.getByLabel(/Categoria/i).click();
    await page.getByRole("option", { name: env.categoryName }).click();
    await uploadDialog.getByLabel("Pasta de destino").click();
    await page.getByRole("option", { name: env.folderName }).click();
    await uploadDialog.getByLabel("Observação da versão").fill("Versão inicial para aprovação");
    await uploadDialog.getByLabel("Selecionar arquivos para envio").setInputFiles({
      name: "contrato-wf-v1.pdf",
      mimeType: "application/pdf",
      buffer: v1Buffer,
    });
    await uploadDialog.getByRole("button", { name: "Iniciar envio (1)" }).click();
    await expect(uploadDialog.getByText(/Em análise|Disponível/)).toBeVisible();
    await uploadDialog.getByRole("button", { name: "Fechar", exact: true }).click();

    await page.getByLabel("Pesquisar documento").fill(documentTitle);
    await page.getByRole("button", { name: `Abrir ${documentTitle}` }).click();
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/);
    const documentUrl = page.url();

    await expect(page.getByText("Disponível").first()).toBeVisible();
    await expect(page.getByText("Rascunho")).toBeVisible();

    // 2. Solicitante envia v1 para aprovação no fluxo sequencial
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    const startWorkflowDialog = page.getByRole("dialog", {
      name: "Enviar para revisão e aprovação",
    });
    await expect(startWorkflowDialog).toBeVisible();
    await expect(startWorkflowDialog.getByText(env.workflowDefinitionName)).toBeVisible();
    await startWorkflowDialog.getByRole("button", { name: "Confirmar envio" }).click();

    await expect(page.getByText("Em revisão")).toBeVisible();
    const timelineList = page.getByRole("list", {
      name: `Etapas do fluxo ${env.workflowDefinitionName}`,
    });
    await expect(timelineList.getByText("Etapa 1: Revisão Jurídica")).toBeVisible();
    await expect(timelineList.getByText("Pendente")).toBeVisible();

    // 3. Revisor jurídico abre sua caixa de tarefas e solicita ajuste com comentário obrigatório
    const reviewerContext = await browser.newContext({ locale: "pt-BR" });
    await reviewerContext.addInitScript(() => {
      window.localStorage.setItem("papyrus_ui_locale", "pt-BR");
    });
    const reviewerPage = await reviewerContext.newPage();

    await reviewerPage.goto(env.baseUrl);
    await expect(reviewerPage).toHaveURL(/\/login$/);
    await reviewerPage.getByLabel(/E-mail corporativo/i).fill(env.reviewerCredentials.email);
    await reviewerPage.getByLabel(/^Senha/i).fill(env.reviewerCredentials.password);
    await reviewerPage.getByRole("button", { name: "Entrar" }).click();
    await expect(reviewerPage).not.toHaveURL(/\/login$/);

    await reviewerPage.getByRole("link", { name: "Minhas tarefas" }).first().click();
    await expect(reviewerPage).toHaveURL(/\/tasks$/);

    const reviewerRowV1 = reviewerPage.locator("tr", { hasText: documentTitle });
    await expect(reviewerRowV1).toBeVisible();
    await expect(reviewerRowV1.getByText("Versão v1")).toBeVisible();
    await reviewerRowV1.getByRole("button", { name: /Revisar/i }).click();

    await expect(reviewerPage).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
    await expect(reviewerPage.getByText("Versão v1").first()).toBeVisible();
    await reviewerPage.getByLabel("Comentário da revisão").fill(adjustmentComment);
    await reviewerPage.getByRole("button", { name: "Solicitar ajustes" }).click();

    await expect(reviewerPage.getByText(/Solicitação de ajustes registrada/i)).toBeVisible();

    // 4. Solicitante verifica documento de volta em Rascunho, histórico com comentário, e envia v2
    await page.reload();
    await expect(page.getByText("Rascunho")).toBeVisible();
    await expect(page.getByText("Versão avaliada v1")).toBeVisible();
    await expect(page.getByText(new RegExp(adjustmentComment))).toBeVisible();

    await page.getByRole("button", { name: "Enviar nova versão" }).first().click();
    const newVersionDialog = page.getByRole("dialog", { name: "Enviar documentos" });
    await expect(newVersionDialog).toBeVisible();
    await newVersionDialog.getByLabel("Observação da versão").fill("Cláusula ajustada na v2");
    await newVersionDialog.getByLabel("Selecionar arquivos para envio").setInputFiles({
      name: "contrato-wf-v2.pdf",
      mimeType: "application/pdf",
      buffer: v2Buffer,
    });
    await newVersionDialog.getByRole("button", { name: "Iniciar envio (1)" }).click();
    await expect(newVersionDialog.getByText(/Em análise|Disponível/)).toBeVisible();
    await newVersionDialog.getByRole("button", { name: "Fechar", exact: true }).click();

    await expect(page.getByText("Versão v2")).toBeVisible();
    await expect(page.getByText("Disponível").first()).toBeVisible();

    // 5. Solicitante reenvia v2 para o fluxo sequencial de aprovação
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    const restartWorkflowDialog = page.getByRole("dialog", {
      name: "Enviar para revisão e aprovação",
    });
    await expect(restartWorkflowDialog).toBeVisible();
    await restartWorkflowDialog.getByRole("button", { name: "Confirmar envio" }).click();
    await expect(page.getByText("Em revisão")).toBeVisible();

    // 6. Revisor aprova Etapa 1 vinculada à v2
    await reviewerPage.getByRole("link", { name: "Minhas tarefas" }).first().click();
    await expect(reviewerPage).toHaveURL(/\/tasks$/);
    await reviewerPage.getByRole("button", { name: "Atualizar" }).click();

    const reviewerRowV2 = reviewerPage
      .locator("tr", { hasText: documentTitle })
      .filter({ hasText: "Versão v2" });
    await expect(reviewerRowV2).toBeVisible();
    await reviewerRowV2.getByRole("button", { name: /Revisar/i }).click();

    await expect(reviewerPage.getByText("Versão v2").first()).toBeVisible();
    await reviewerPage.getByLabel("Comentário da revisão").fill(step1ApprovalComment);
    await reviewerPage.getByRole("button", { name: "Aprovar" }).click();
    await expect(reviewerPage.getByText(/Aprovação registrada/i)).toBeVisible();

    await reviewerContext.close();

    // 7. Aprovador final executa Etapa 2 (v2) e confirma aprovação final do documento
    await page.getByRole("link", { name: "Minhas tarefas" }).first().click();
    await expect(page).toHaveURL(/\/tasks$/);

    const finalTaskRow = page
      .locator("tr", { hasText: "Etapa 2: Aprovação Final" })
      .filter({ hasText: documentTitle });
    await expect(finalTaskRow).toBeVisible();
    await finalTaskRow.getByRole("button", { name: /Revisar/i }).click();

    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
    await page.getByLabel("Comentário da revisão").fill(step2ApprovalComment);
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText(/Aprovação registrada/i)).toBeVisible();

    // 8. Conferir status final Aprovado e histórico completo (v1 ajustes + v2 aprovação final)
    await page.getByRole("button", { name: "Abrir documento" }).click();
    await expect(page).toHaveURL(
      new RegExp(`^${documentUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\?|$)`),
    );
    await expect(page.getByRole("heading", { name: documentTitle })).toBeVisible();

    await expect(page.getByText("Aprovado").first()).toBeVisible();
    await expect(page.getByText("Versão v2").first()).toBeVisible();

    await expect(page.getByText("Versão avaliada v2").first()).toBeVisible();
    await expect(page.getByText("Concluído").first()).toBeVisible();
    await expect(page.getByText(new RegExp(step1ApprovalComment)).first()).toBeVisible();
    await expect(page.getByText(new RegExp(step2ApprovalComment)).first()).toBeVisible();

    await expect(page.getByText("Versão avaliada v1").first()).toBeVisible();
    await expect(page.getByText("Ajustes solicitados").first()).toBeVisible();
    await expect(page.getByText(new RegExp(adjustmentComment)).first()).toBeVisible();
  });
});
