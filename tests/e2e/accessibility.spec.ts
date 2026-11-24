import { type Locator, type Page, expect, test } from "@playwright/test";
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

interface AccessibilityAuditReport {
  readonly htmlLang: string;
  readonly hasMainLandmark: boolean;
  readonly visibleH1Count: number;
  readonly hasVisibleDialogHeading: boolean;
  readonly unlabeledControls: readonly string[];
  readonly missingImageAlts: readonly string[];
  readonly contrastViolations: readonly string[];
}

/**
 * Audits WCAG 2.2 AA fundamentals directly in the rendered browser DOM:
 * document language, `<main>` landmark, visible heading structure, accessible labels
 * for all interactive controls, and computed foreground/background contrast ratios.
 */
async function auditViewAccessibility(
  page: Page,
  viewLabel: string,
  options: { readonly isModalDialog?: boolean } = {},
): Promise<void> {
  const report = await page.evaluate(async (): Promise<AccessibilityAuditReport> => {
    await Promise.all(
      document
        .getAnimations()
        .filter((anim) => anim.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((anim) => anim.finished.catch(() => undefined)),
    );
    interface RgbaColor {
      readonly r: number;
      readonly g: number;
      readonly b: number;
      readonly a: number;
    }

    function parseRgba(raw: string): RgbaColor | null {
      const match = raw.match(
        /rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?))?\s*\)/i,
      );
      if (!match) {
        return null;
      }
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] !== undefined ? Number(match[4]) : 1,
      };
    }

    function compositeOver(fg: RgbaColor, bg: RgbaColor): RgbaColor {
      const alpha = Math.max(0, Math.min(1, fg.a));
      return {
        r: fg.r * alpha + bg.r * (1 - alpha),
        g: fg.g * alpha + bg.g * (1 - alpha),
        b: fg.b * alpha + bg.b * (1 - alpha),
        a: 1,
      };
    }

    function relativeLuminance(c: RgbaColor): number {
      const toLinear = (channel: number): number => {
        const srgb = channel / 255;
        return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
    }

    function contrastRatio(a: RgbaColor, b: RgbaColor): number {
      const l1 = relativeLuminance(a);
      const l2 = relativeLuminance(b);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function isElementVisible(el: Element): boolean {
      if (el.closest('[aria-hidden="true"]')) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function isVisuallyHiddenSrOnly(el: Element): boolean {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.position === "absolute" &&
        rect.width <= 2 &&
        rect.height <= 2 &&
        style.overflow === "hidden"
      );
    }

    function resolveOpaqueBackground(el: Element): RgbaColor {
      const layers: RgbaColor[] = [];
      let current: Element | null = el;
      while (current) {
        const parsed = parseRgba(window.getComputedStyle(current).backgroundColor);
        if (parsed && parsed.a > 0) {
          layers.push(parsed);
          if (parsed.a >= 0.999) {
            break;
          }
        }
        current = current.parentElement;
      }
      let accumulated: RgbaColor = { r: 246, g: 248, b: 249, a: 1 };
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layer = layers[i];
        if (layer) {
          accumulated = compositeOver(layer, accumulated);
        }
      }
      return accumulated;
    }

    function describeElement(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const role = el.getAttribute("role");
      const rolePart = role ? `[role="${role}"]` : "";
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${tag}${id}${rolePart}${text ? `("${text}")` : ""}`;
    }

    function hasAccessibleName(el: Element): boolean {
      const ariaLabel = el.getAttribute("aria-label")?.trim();
      if (ariaLabel) {
        return true;
      }
      const labelledBy = el.getAttribute("aria-labelledby")?.trim();
      if (labelledBy) {
        const resolved = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (resolved.length > 0) {
          return true;
        }
      }
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        if (el.id) {
          const explicitLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (explicitLabel && (explicitLabel.textContent ?? "").trim().length > 0) {
            return true;
          }
        }
        const wrappedLabel = el.closest("label");
        if (wrappedLabel && (wrappedLabel.textContent ?? "").trim().length > 0) {
          return true;
        }
        if (
          el instanceof HTMLInputElement &&
          (el.type === "submit" || el.type === "button") &&
          el.value.trim().length > 0
        ) {
          return true;
        }
        return false;
      }
      const visibleText = (el.textContent ?? "").trim();
      if (visibleText.length > 0) {
        return true;
      }
      const titleAttr = el.getAttribute("title")?.trim();
      if (titleAttr) {
        return true;
      }
      const namedChildImg = el.querySelector("img[alt]");
      if (namedChildImg && (namedChildImg.getAttribute("alt") ?? "").trim().length > 0) {
        return true;
      }
      return false;
    }

    const htmlLang = document.documentElement.lang.trim();
    const hasMainLandmark = Boolean(document.querySelector('main, [role="main"]'));
    const visibleH1Count = Array.from(document.querySelectorAll("h1")).filter((h) =>
      isElementVisible(h),
    ).length;

    const unlabeledControls: string[] = [];
    const interactiveSelector =
      'input:not([type="hidden"]), textarea, select, button, a[href], [role="button"], [role="combobox"], [role="tab"]';
    for (const control of document.querySelectorAll(interactiveSelector)) {
      if (!isElementVisible(control) || isVisuallyHiddenSrOnly(control)) {
        continue;
      }
      if (
        (control instanceof HTMLButtonElement ||
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement) &&
        control.disabled
      ) {
        continue;
      }
      // MUI InputBase places tabindex/aria-controls on hidden native input inside Select
      if (
        control instanceof HTMLInputElement &&
        control.classList.contains("MuiSelect-nativeInput")
      ) {
        continue;
      }
      if (!hasAccessibleName(control)) {
        unlabeledControls.push(describeElement(control));
      }
    }

    const missingImageAlts: string[] = [];
    for (const img of document.querySelectorAll("img")) {
      if (!isElementVisible(img)) {
        continue;
      }
      if (!img.hasAttribute("alt")) {
        missingImageAlts.push(describeElement(img));
      }
    }

    const contrastViolations: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const checkedElements = new Set<Element>();
    let currentNode = walker.nextNode();
    while (currentNode) {
      const parentEl = currentNode.parentElement;
      const textContent = (currentNode.textContent ?? "").trim();
      if (
        parentEl &&
        textContent.length > 0 &&
        !checkedElements.has(parentEl) &&
        isElementVisible(parentEl) &&
        !isVisuallyHiddenSrOnly(parentEl)
      ) {
        checkedElements.add(parentEl);
        const disabledAncestor = parentEl.closest(
          '[disabled], [aria-disabled="true"], .Mui-disabled',
        );
        if (!disabledAncestor) {
          const style = window.getComputedStyle(parentEl);
          const fgParsed = parseRgba(style.color);
          const bgResolved = resolveOpaqueBackground(parentEl);
          if (fgParsed) {
            const fgResolved = fgParsed.a < 0.999 ? compositeOver(fgParsed, bgResolved) : fgParsed;
            const ratio = contrastRatio(fgResolved, bgResolved);
            const fontSizePx = Number.parseFloat(style.fontSize) || 14;
            const fontWeightNum = Number.parseInt(style.fontWeight, 10) || 400;
            const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeightNum >= 700);
            const requiredRatio = isLargeText ? 3.0 : 4.5;
            if (ratio < requiredRatio) {
              contrastViolations.push(
                `${describeElement(parentEl)}: ratio=${ratio.toFixed(2)} (min ${requiredRatio}) fg=${style.color} bg=rgb(${Math.round(bgResolved.r)},${Math.round(bgResolved.g)},${Math.round(bgResolved.b)})`,
              );
            }
          }
        }
      }
      currentNode = walker.nextNode();
    }

    const hasVisibleDialogHeading = Array.from(document.querySelectorAll('[role="dialog"]')).some(
      (dialogEl) => isElementVisible(dialogEl) && hasAccessibleName(dialogEl),
    );

    return {
      htmlLang,
      hasMainLandmark,
      visibleH1Count,
      hasVisibleDialogHeading,
      unlabeledControls,
      missingImageAlts,
      contrastViolations,
    };
  });

  expect(report.htmlLang, `[${viewLabel}] <html> lang attribute`).toMatch(/^pt(-BR)?$/i);
  if (options.isModalDialog) {
    expect(
      report.hasVisibleDialogHeading,
      `[${viewLabel}] modal dialog missing visible accessible title`,
    ).toBe(true);
  } else {
    expect(report.hasMainLandmark, `[${viewLabel}] <main> landmark missing`).toBe(true);
    expect(
      report.visibleH1Count,
      `[${viewLabel}] visible <h1> heading missing`,
    ).toBeGreaterThanOrEqual(1);
  }
  expect(report.unlabeledControls, `[${viewLabel}] unlabeled interactive controls`).toEqual([]);
  expect(report.missingImageAlts, `[${viewLabel}] images missing alt attribute`).toEqual([]);
  expect(report.contrastViolations, `[${viewLabel}] WCAG AA contrast violations`).toEqual([]);
}

async function assertKeyboardFocusVisible(
  page: Page,
  target: Locator,
  label: string,
): Promise<void> {
  const alreadyFocused = await target.evaluate((el) => document.activeElement === el);
  if (!alreadyFocused) {
    await target.focus();
    const isInput = await target.evaluate((el) => Boolean(el.closest(".MuiOutlinedInput-root")));
    if (!isInput) {
      // Move focus off and back via real Tab navigation so :focus-visible / .Mui-focusVisible fire
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    }
  }
  await expect(target, `[${label}] element did not receive keyboard focus`).toBeFocused();
  const focusVisual = await target.evaluate((el) => {
    const style = window.getComputedStyle(el);
    const outlinedRoot = el.closest(".MuiOutlinedInput-root");
    const notchedOutline = outlinedRoot?.querySelector(".MuiOutlinedInput-notchedOutline");
    const notchedStyle = notchedOutline ? window.getComputedStyle(notchedOutline) : null;
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
      isMuiFocusedInput: Boolean(outlinedRoot?.classList.contains("Mui-focused")),
      notchedBorderWidth: notchedStyle?.borderWidth ?? "",
      notchedBorderColor: notchedStyle?.borderColor ?? "",
    };
  });
  const hasVisibleOutline =
    focusVisual.outlineStyle !== "none" &&
    focusVisual.outlineWidth !== "0px" &&
    focusVisual.outlineWidth !== "";
  const hasVisibleShadow = focusVisual.boxShadow !== "none" && focusVisual.boxShadow !== "";
  const hasFocusedInputRing =
    focusVisual.isMuiFocusedInput && Number.parseFloat(focusVisual.notchedBorderWidth) >= 2;
  expect(
    hasVisibleOutline || hasVisibleShadow || hasFocusedInputRing,
    `[${label}] focused control lacks visible focus indicator (${JSON.stringify(focusVisual)})`,
  ).toBe(true);
}

test.describe("Acessibilidade WCAG 2.2 AA dos fluxos críticos", () => {
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

  test("valida login, lista, upload, detalhe, tarefa e administração por teclado, labels e contraste", async ({
    page,
    browser,
  }) => {
    const documentTitle = "Contrato Acessibilidade 2026";
    const pdfBuffer = createSamplePdfBuffer("papyrus WCAG 2.2 AA Verification");

    // 1. Fluxo de Login: auditoria de labels/contraste + navegação e submissão integralmente via teclado
    await page.goto(env.baseUrl);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "papyrus" })).toBeVisible();
    await auditViewAccessibility(page, "Login");

    const emailInput = page.getByLabel(/E-mail corporativo/i);
    const passwordInput = page.getByLabel(/^Senha/i);
    const loginButton = page.getByRole("button", { name: "Entrar" });

    await assertKeyboardFocusVisible(page, emailInput, "Login E-mail");
    await emailInput.fill(env.credentials.email);
    await page.keyboard.press("Tab");
    await expect(passwordInput).toBeFocused();
    await passwordInput.fill(env.credentials.password);

    // Tab para alternar visibilidade da senha -> Esqueci minha senha -> Botão Entrar
    await page.keyboard.press("Tab");
    const togglePasswordButton = page.getByRole("button", {
      name: /Mostrar senha|Ocultar senha/i,
    });
    await expect(togglePasswordButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Esqueci minha senha" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(loginButton).toBeFocused();
    await assertKeyboardFocusVisible(page, loginButton, "Botão Entrar");
    await page.keyboard.press("Enter");

    await expect(page).not.toHaveURL(/\/login$/);

    // 2. Fluxo de Lista de documentos: labels, contraste, foco no campo de busca e navegação para /documents
    await page.getByRole("link", { name: "Documentos" }).first().click();
    await expect(page).toHaveURL(/\/documents$/);
    await expect(page.getByRole("heading", { name: "Documentos" })).toBeVisible();
    await auditViewAccessibility(page, "Lista de documentos");

    const searchField = page.getByLabel("Pesquisar documento");
    await assertKeyboardFocusVisible(page, searchField, "Filtro Pesquisar documento");

    // 3. Fluxo de Upload: abrir diálogo via teclado, verificar foco dentro do dialog, Escape fecha e envio real funciona
    const uploadOpenButton = page.getByRole("button", { name: "Enviar documentos" }).first();
    await assertKeyboardFocusVisible(page, uploadOpenButton, "Botão Enviar documentos");
    await page.keyboard.press("Enter");

    const uploadDialog = page.getByRole("dialog", { name: "Enviar documentos" });
    await expect(uploadDialog).toBeVisible();
    await expect(uploadDialog).toHaveCSS("opacity", "1");
    await auditViewAccessibility(page, "Diálogo de Upload", { isModalDialog: true });

    // Verificar fechamento acessível via teclado (Escape) e reabertura limpa
    await page.keyboard.press("Escape");
    await expect(uploadDialog).not.toBeVisible();

    await uploadOpenButton.click();
    await expect(uploadDialog).toBeVisible();
    await uploadDialog.getByLabel("Título do documento").fill(documentTitle);
    await uploadDialog.getByLabel(/Categoria/i).click();
    await page.getByRole("option", { name: env.categoryName }).click();
    await uploadDialog.getByLabel("Pasta de destino").click();
    await page.getByRole("option", { name: env.folderName }).click();
    await uploadDialog.getByLabel("Observação da versão").fill("Envio acessível");
    await uploadDialog.getByLabel("Selecionar arquivos para envio").setInputFiles({
      name: "contrato-a11y.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });
    await uploadDialog.getByRole("button", { name: "Iniciar envio (1)" }).click();
    await expect(uploadDialog.getByText(/Em análise|Disponível/)).toBeVisible();
    await uploadDialog.getByRole("button", { name: "Fechar", exact: true }).click();

    // 4. Fluxo de Detalhe do documento: abrir via lista, conferir labels/contraste e iniciar aprovação
    await searchField.fill(documentTitle);
    const openDocButton = page.getByRole("button", { name: `Abrir ${documentTitle}` });
    await assertKeyboardFocusVisible(page, openDocButton, "Abrir documento");
    await openDocButton.click();

    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: documentTitle })).toBeVisible();
    await expect(page.getByText("Disponível").first()).toBeVisible();
    await auditViewAccessibility(page, "Detalhe do documento");

    const sendForApprovalBtn = page.getByRole("button", { name: "Enviar para aprovação" });
    await assertKeyboardFocusVisible(page, sendForApprovalBtn, "Botão Enviar para aprovação");
    await sendForApprovalBtn.click();
    const startWorkflowDialog = page.getByRole("dialog", {
      name: "Enviar para revisão e aprovação",
    });
    await expect(startWorkflowDialog).toBeVisible();
    await startWorkflowDialog.getByRole("button", { name: "Confirmar envio" }).click();
    await expect(page.getByText("Em revisão")).toBeVisible();

    // 5. Fluxo de Tarefas: login do revisor, fila de tarefas (/tasks) e tela de revisão (/tasks/:id)
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
    await expect(reviewerPage.getByRole("heading", { name: "Minhas tarefas" })).toBeVisible();
    await auditViewAccessibility(reviewerPage, "Lista de tarefas");

    const taskRow = reviewerPage.locator("tr", { hasText: documentTitle });
    await expect(taskRow).toBeVisible();
    const reviewTaskButton = taskRow.getByRole("button", { name: /Revisar/i });
    await assertKeyboardFocusVisible(reviewerPage, reviewTaskButton, "Botão Revisar tarefa");
    await reviewTaskButton.click();

    await expect(reviewerPage).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
    await expect(reviewerPage.getByLabel("Comentário da revisão")).toBeVisible();
    await auditViewAccessibility(reviewerPage, "Detalhe da tarefa");

    const commentBox = reviewerPage.getByLabel("Comentário da revisão");
    await assertKeyboardFocusVisible(reviewerPage, commentBox, "Comentário da revisão");
    await commentBox.fill("Acessibilidade e fluxo conferidos.");
    await reviewerPage.getByRole("button", { name: "Aprovar" }).click();
    await expect(reviewerPage.getByText(/Aprovação registrada/i)).toBeVisible();
    await reviewerContext.close();

    // 6. Fluxo de Administração: usuários (/admin/users), armazenamento (/admin/storage) e categorias (/categories)
    await page.getByRole("link", { name: "Usuários e grupos" }).first().click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("heading", { name: /Usuários/i })).toBeVisible();
    await expect(page.getByText(env.credentials.email)).toBeVisible();
    await auditViewAccessibility(page, "Administração - Usuários");

    await page.getByRole("link", { name: "Armazenamento" }).first().click();
    await expect(page).toHaveURL(/\/admin\/storage$/);
    await expect(page.getByRole("heading", { name: /Armazenamento/i })).toBeVisible();
    await expect(page.getByText("Local E2E")).toBeVisible();
    await auditViewAccessibility(page, "Administração - Armazenamento");

    const storageTabs = page.getByRole("tab");
    if ((await storageTabs.count()) > 0) {
      await assertKeyboardFocusVisible(page, storageTabs.first(), "Aba Armazenamento");
    }

    await page.getByRole("link", { name: "Categorias e campos" }).first().click();
    await expect(page).toHaveURL(/\/categories$/);
    await expect(page.getByRole("heading", { name: /Categorias/i })).toBeVisible();
    await expect(page.getByText(env.categoryName)).toBeVisible();
    await auditViewAccessibility(page, "Administração - Categorias");
  });
});
