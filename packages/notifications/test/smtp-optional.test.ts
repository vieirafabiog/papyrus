import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  type EmailDeliveryLogPort,
  type EmailOutboxEnqueueInput,
  type EmailOutboxPort,
  type SmtpAdminConfigRecord,
  type SmtpConfigRepositoryPort,
  createOptionalSmtpEmailService,
  createSmtpSecretVault,
  isValidSmtpSecretEnvelope,
  sanitizeSmtpErrorMessage,
} from "../src/index.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const NOTIF_ID = "33333333-3333-4333-8333-333333333333";

function createMemorySmtpInfra() {
  const configs = new Map<string, SmtpAdminConfigRecord>();
  const outboxJobs: EmailOutboxEnqueueInput[] = [];
  const deliveredKeys = new Set<string>();

  const configRepo: SmtpConfigRepositoryPort = {
    async findByOrganizationId(orgId) {
      return configs.get(orgId) ?? null;
    },
    async upsert(record) {
      configs.set(record.organizationId, record);
      return record;
    },
  };

  const outbox: EmailOutboxPort = {
    async enqueue(job) {
      outboxJobs.push(job);
    },
  };

  const deliveryLog: EmailDeliveryLogPort = {
    async hasDelivered(orgId, idempotencyKey) {
      return deliveredKeys.has(`${orgId}:${idempotencyKey}`);
    },
    async markDelivered(input) {
      deliveredKeys.add(`${input.organizationId}:${input.idempotencyKey}`);
    },
  };

  return { configs, configRepo, outboxJobs, outbox, deliveredKeys, deliveryLog };
}

interface MockSmtpCapturedEmail {
  readonly authHeader: string | null;
  readonly mailFrom: string;
  readonly rcptTo: string;
  readonly data: string;
}

async function startLocalMockSmtpServer(options?: { readonly failAuth?: boolean }): Promise<{
  readonly port: number;
  readonly captured: MockSmtpCapturedEmail[];
  close(): Promise<void>;
}> {
  const captured: MockSmtpCapturedEmail[] = [];

  const server = net.createServer((socket) => {
    let buffer = "";
    let inDataMode = false;
    let authHeader: string | null = null;
    let mailFrom = "";
    let rcptTo = "";
    let dataLines: string[] = [];

    socket.setEncoding("utf8");
    socket.write("220 mock-smtp.local ESMTP DocuFlow\r\n");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);

        if (inDataMode) {
          if (line === ".") {
            inDataMode = false;
            captured.push({
              authHeader,
              mailFrom,
              rcptTo,
              data: dataLines.join("\r\n"),
            });
            dataLines = [];
            socket.write("250 2.0.0 OK queued\r\n");
          } else {
            dataLines.push(line.startsWith("..") ? line.slice(1) : line);
          }
        } else {
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
            socket.write("250-mock-smtp.local\r\n250 AUTH PLAIN LOGIN\r\n");
          } else if (upper.startsWith("AUTH PLAIN")) {
            authHeader = line;
            if (options?.failAuth) {
              socket.write("535 5.7.8 Authentication credentials invalid\r\n");
            } else {
              socket.write("235 2.7.0 Authentication successful\r\n");
            }
          } else if (upper.startsWith("MAIL FROM:")) {
            mailFrom = line.slice("MAIL FROM:".length).trim();
            socket.write("250 2.1.0 Ok\r\n");
          } else if (upper.startsWith("RCPT TO:")) {
            rcptTo = line.slice("RCPT TO:".length).trim();
            socket.write("250 2.1.5 Ok\r\n");
          } else if (upper === "DATA") {
            inDataMode = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (upper === "QUIT") {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
          } else {
            socket.write("500 Unrecognized command\r\n");
          }
        }

        idx = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Unexpected mock SMTP server address");
  }

  return {
    port: addr.port,
    captured,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("Optional SMTP email service & secret protection", () => {
  it("skips queueing gracefully when SMTP is unconfigured or disabled", async () => {
    const infra = createMemorySmtpInfra();
    const vault = createSmtpSecretVault({
      masterKey: "a".repeat(64),
      activeKeyId: "k1",
    });

    const service = createOptionalSmtpEmailService({
      configs: infra.configRepo,
      outbox: infra.outbox,
      deliveryLog: infra.deliveryLog,
      vault,
    });

    const unconfiguredOutcome = await service.enqueueNotificationEmail({
      organizationId: ORG_ID,
      recipientEmail: "revisor@empresa.local",
      subject: "Nova tarefa",
      textBody: "Você possui uma tarefa pendente.",
      notificationId: NOTIF_ID,
      idempotencyKey: "notif-1",
    });
    expect(unconfiguredOutcome).toEqual({ status: "SKIPPED_DISABLED", enqueued: false });
    expect(infra.outboxJobs).toHaveLength(0);

    const testUnconfigured = await service.testOrganizationSmtpConnection(ORG_ID);
    expect(testUnconfigured.configured).toBe(false);
    expect(testUnconfigured.healthy).toBe(false);
  });

  it("encrypts SMTP credentials, protects secrets in views/outbox/errors, and sends asynchronously via custom SMTP server", async () => {
    const server = await startLocalMockSmtpServer();
    try {
      const infra = createMemorySmtpInfra();
      const oldVault = createSmtpSecretVault({
        masterKey: "1".repeat(64),
        activeKeyId: "k1",
      });
      const rotatedVault = createSmtpSecretVault({
        masterKey: "2".repeat(64),
        activeKeyId: "k2",
        previousKeys: { k1: "1".repeat(64) },
      });

      const secretPassword = "SmtpTopSecretPassword!987";

      // Verify encryption + rotation
      const encryptedWithOldKey = oldVault.encryptCredentials({
        username: "smtp-user@empresa.local",
        password: secretPassword,
      });
      expect(isValidSmtpSecretEnvelope(encryptedWithOldKey)).toBe(true);
      expect(encryptedWithOldKey).not.toContain(secretPassword);
      const rotated = rotatedVault.rotateCredentials(encryptedWithOldKey);
      expect(rotated.startsWith("dfsmtp:v1:k2:")).toBe(true);
      expect(rotatedVault.decryptCredentials(rotated).password).toBe(secretPassword);

      let seq = 0;
      const service = createOptionalSmtpEmailService({
        configs: infra.configRepo,
        outbox: infra.outbox,
        deliveryLog: infra.deliveryLog,
        vault: rotatedVault,
        generateId: () => `job-${++seq}`,
        now: () => new Date("2026-11-21T18:00:00.000Z"),
      });

      const safeView = await service.saveOrganizationSmtpConfig({
        organizationId: ORG_ID,
        actorUserId: ADMIN_ID,
        enabled: true,
        host: "127.0.0.1",
        port: server.port,
        securityMode: "NONE",
        fromAddress: "noreply@empresa.local",
        fromName: "DocuFlow Corporativo",
        credentials: {
          username: "smtp-user@empresa.local",
          password: secretPassword,
        },
      });

      expect(safeView.authConfigured).toBe(true);
      expect(JSON.stringify(safeView)).not.toContain(secretPassword);
      expect(JSON.stringify(safeView)).not.toContain("dfsmtp:v1");

      const connCheck = await service.testOrganizationSmtpConnection(ORG_ID);
      expect(connCheck.healthy).toBe(true);

      // Asynchronous enqueue: returns immediately and never embeds credentials into outbox payload
      const enqueueOutcome = await service.enqueueNotificationEmail({
        organizationId: ORG_ID,
        recipientEmail: "aprovador@empresa.local",
        subject: "Tarefa atribuída: Contrato Sigma",
        textBody: "Acesse Minhas tarefas para revisar.\n.Linha com ponto inicial.",
        htmlBody: "<p>Acesse Minhas tarefas para revisar.</p>",
        notificationId: NOTIF_ID,
        idempotencyKey: "task-assigned:123",
      });

      expect(enqueueOutcome).toEqual({
        status: "QUEUED",
        enqueued: true,
        jobId: "job-1",
      });
      expect(infra.outboxJobs).toHaveLength(1);
      const queuedJob = infra.outboxJobs[0];
      expect(queuedJob).toBeDefined();
      expect(JSON.stringify(queuedJob)).not.toContain(secretPassword);
      expect(JSON.stringify(queuedJob)).not.toContain("dfsmtp:v1");
      // Not sent synchronously on enqueue!
      expect(server.captured).toHaveLength(0);

      // Worker executes queued job asynchronously over real TCP SMTP wire protocol
      if (!queuedJob) {
        throw new Error("Expected queued job");
      }
      const sendOutcome = await service.processQueuedEmailJob(queuedJob.payload);
      expect(sendOutcome.status).toBe("SENT");
      expect(server.captured).toHaveLength(1);
      expect(server.captured[0]?.mailFrom).toBe("<noreply@empresa.local>");
      expect(server.captured[0]?.rcptTo).toBe("<aprovador@empresa.local>");
      expect(server.captured[0]?.data).toContain("Subject: Tarefa atribuída: Contrato Sigma");
      expect(server.captured[0]?.data).toContain(".Linha com ponto inicial.");

      // Retry of same queued job is deduplicated idempotently without double-sending
      const duplicateOutcome = await service.processQueuedEmailJob(queuedJob.payload);
      expect(duplicateOutcome).toEqual({ status: "DEDUPLICATED" });
      expect(server.captured).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("redacts SMTP password and vault blobs on authentication errors", async () => {
    const server = await startLocalMockSmtpServer({ failAuth: true });
    try {
      const infra = createMemorySmtpInfra();
      const vault = createSmtpSecretVault({
        masterKey: "3".repeat(64),
        activeKeyId: "k1",
      });
      const service = createOptionalSmtpEmailService({
        configs: infra.configRepo,
        outbox: infra.outbox,
        deliveryLog: infra.deliveryLog,
        vault,
      });

      const secretPassword = "SecretSmtpFailPass!456";
      await service.saveOrganizationSmtpConfig({
        organizationId: ORG_ID,
        actorUserId: ADMIN_ID,
        enabled: true,
        host: "127.0.0.1",
        port: server.port,
        securityMode: "NONE",
        fromAddress: "noreply@empresa.local",
        credentials: {
          username: "wrong-user@empresa.local",
          password: secretPassword,
        },
      });

      const enqueued = await service.enqueueNotificationEmail({
        organizationId: ORG_ID,
        recipientEmail: "destino@empresa.local",
        subject: "Aviso de vencimento",
        textBody: "Documento próximo ao vencimento.",
        idempotencyKey: "exp-1",
      });
      expect(enqueued.enqueued).toBe(true);

      const job = infra.outboxJobs[0];
      if (!job) {
        throw new Error("Expected queued job");
      }

      await expect(service.processQueuedEmailJob(job.payload)).rejects.toThrow(/AUTH/);

      const sanitized = sanitizeSmtpErrorMessage(
        `AUTH PLAIN ZHVtbXk= password=${secretPassword} dfsmtp:v1:k1:iv:tag:cipher`,
        [secretPassword],
      );
      expect(sanitized).not.toContain(secretPassword);
      expect(sanitized).not.toContain("ZHVtbXk=");
      expect(sanitized).not.toContain("dfsmtp:v1");
    } finally {
      await server.close();
    }
  });
});
