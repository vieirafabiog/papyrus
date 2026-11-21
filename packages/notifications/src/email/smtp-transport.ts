import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { sanitizeSmtpErrorMessage } from "./smtp-vault.js";
import type { SmtpSendRequest, SmtpSendResult, SmtpTransportPort } from "./types.js";

const CRLF_PATTERN = /[\r\n\0]/;

export class SmtpTransportError extends Error {
  public readonly code: "INVALID_INPUT" | "CONNECTION_FAILED" | "AUTH_FAILED" | "SEND_FAILED";

  public constructor(
    code: "INVALID_INPUT" | "CONNECTION_FAILED" | "AUTH_FAILED" | "SEND_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SmtpTransportError";
    this.code = code;
  }
}

function assertNoHeaderInjection(value: string, label: string): string {
  if (CRLF_PATTERN.test(value)) {
    throw new SmtpTransportError(
      "INVALID_INPUT",
      `Campo SMTP '${label}' contém quebra de linha ou caractere inválido.`,
    );
  }
  return value.trim();
}

function formatFromHeader(fromAddress: string, fromName: string | null): string {
  const cleanAddress = assertNoHeaderInjection(fromAddress, "fromAddress");
  if (!fromName || fromName.trim().length === 0) {
    return `<${cleanAddress}>`;
  }
  const cleanName = assertNoHeaderInjection(fromName, "fromName").replaceAll('"', '\\"');
  return `"${cleanName}" <${cleanAddress}>`;
}

function normalizeAndDotStuffBody(rawBody: string): string {
  const crlf = rawBody.replace(/\r?\n/g, "\r\n");
  return crlf
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function buildMimePayload(request: SmtpSendRequest, messageId: string): string {
  const cleanTo = assertNoHeaderInjection(request.toAddress, "toAddress");
  const cleanSubject = assertNoHeaderInjection(request.subject, "subject");
  const cleanFrom = formatFromHeader(request.fromAddress, request.fromName);
  const dateHeader = new Date().toUTCString();

  const headers: string[] = [
    `Date: ${dateHeader}`,
    `From: ${cleanFrom}`,
    `To: <${cleanTo}>`,
    `Subject: ${cleanSubject}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];

  if (request.htmlBody && request.htmlBody.trim().length > 0) {
    const boundary = `df-alt-${randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      request.textBody,
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      request.htmlBody,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return normalizeAndDotStuffBody(`${headers.join("\r\n")}\r\n\r\n${parts}`);
  }

  headers.push('Content-Type: text/plain; charset="utf-8"');
  headers.push("Content-Transfer-Encoding: 8bit");
  return normalizeAndDotStuffBody(`${headers.join("\r\n")}\r\n\r\n${request.textBody}`);
}

interface SmtpResponse {
  readonly code: number;
  readonly lines: readonly string[];
}

class SmtpLineReader {
  private buffer = "";
  private socket: net.Socket | tls.TLSSocket;
  private readonly pendingLines: string[] = [];
  private waiter: ((line: string) => void) | null = null;
  private errorWaiter: ((err: Error) => void) | null = null;
  private closedError: Error | null = null;

  public constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.attachSocket(socket);
  }

  public replaceSocket(nextSocket: tls.TLSSocket): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket.removeAllListeners("timeout");
    this.buffer = "";
    this.pendingLines.length = 0;
    this.socket = nextSocket;
    this.attachSocket(nextSocket);
  }

  private attachSocket(target: net.Socket | tls.TLSSocket): void {
    target.setEncoding("utf8");
    target.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        if (this.waiter) {
          const resolve = this.waiter;
          this.waiter = null;
          this.errorWaiter = null;
          resolve(line);
        } else {
          this.pendingLines.push(line);
        }
        idx = this.buffer.indexOf("\n");
      }
    });

    const fail = (err: Error) => {
      this.closedError = err;
      if (this.errorWaiter) {
        const reject = this.errorWaiter;
        this.waiter = null;
        this.errorWaiter = null;
        reject(err);
      }
    };

    target.on("error", fail);
    target.on("timeout", () => fail(new Error("Tempo limite excedido na conexão SMTP.")));
    target.on("close", () => fail(new Error("Conexão SMTP encerrada inesperadamente.")));
  }

  private nextLine(): Promise<string> {
    const queued = this.pendingLines.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.errorWaiter = reject;
    });
  }

  public async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      lines.push(line);
      if (line.length < 4 || line[3] !== "-") {
        const code = Number.parseInt(line.slice(0, 3), 10);
        return {
          code: Number.isNaN(code) ? 0 : code,
          lines,
        };
      }
    }
  }
}

async function openInitialSocket(params: {
  readonly host: string;
  readonly port: number;
  readonly useDirectTls: boolean;
  readonly timeoutMs: number;
}): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = params.useDirectTls
      ? tls.connect({
          host: params.host,
          port: params.port,
          servername: params.host,
        })
      : net.createConnection({
          host: params.host,
          port: params.port,
        });

    socket.setTimeout(params.timeoutMs);

    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => {
      socket.destroy();
      reject(new Error("Tempo limite excedido ao conectar ao servidor SMTP."));
    };

    socket.once("error", onError);
    socket.once("timeout", onTimeout);

    const readyEvent = params.useDirectTls ? "secureConnect" : "connect";
    socket.once(readyEvent, () => {
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      resolve(socket);
    });
  });
}

async function upgradeToStartTls(
  plainSocket: net.Socket,
  host: string,
  timeoutMs: number,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket: plainSocket,
      servername: host,
    });
    tlsSocket.setTimeout(timeoutMs);

    const onError = (error: Error) => {
      tlsSocket.destroy();
      reject(error);
    };

    tlsSocket.once("error", onError);
    tlsSocket.once("secureConnect", () => {
      tlsSocket.removeListener("error", onError);
      resolve(tlsSocket);
    });
  });
}

async function sendCommand(
  socket: net.Socket | tls.TLSSocket,
  reader: SmtpLineReader,
  command: string,
): Promise<SmtpResponse> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${command}\r\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return reader.readResponse();
}

function assertExpectedCode(
  response: SmtpResponse,
  expectedCodes: readonly number[],
  step: string,
) {
  if (!expectedCodes.includes(response.code)) {
    throw new SmtpTransportError(
      step === "AUTH" ? "AUTH_FAILED" : "SEND_FAILED",
      `Falha SMTP em ${step}: código ${response.code}.`,
    );
  }
}

async function openAndAuthenticateSession(config: {
  readonly host: string;
  readonly port: number;
  readonly securityMode: "NONE" | "STARTTLS" | "TLS";
  readonly timeoutMs: number;
  readonly credentials: { readonly username: string; readonly password: string } | null;
}): Promise<{
  readonly socket: net.Socket | tls.TLSSocket;
  readonly reader: SmtpLineReader;
}> {
  const cleanHost = assertNoHeaderInjection(config.host, "host");
  let socket = await openInitialSocket({
    host: cleanHost,
    port: config.port,
    useDirectTls: config.securityMode === "TLS",
    timeoutMs: config.timeoutMs,
  });

  const reader = new SmtpLineReader(socket);
  try {
    const greeting = await reader.readResponse();
    assertExpectedCode(greeting, [220], "GREETING");

    let ehlo = await sendCommand(socket, reader, "EHLO docuflow.local");
    assertExpectedCode(ehlo, [250], "EHLO");

    if (config.securityMode === "STARTTLS") {
      const startTlsResp = await sendCommand(socket, reader, "STARTTLS");
      assertExpectedCode(startTlsResp, [220], "STARTTLS");
      if (socket instanceof net.Socket) {
        const tlsSocket = await upgradeToStartTls(socket, cleanHost, config.timeoutMs);
        socket = tlsSocket;
        reader.replaceSocket(tlsSocket);
      }
      ehlo = await sendCommand(socket, reader, "EHLO docuflow.local");
      assertExpectedCode(ehlo, [250], "EHLO_TLS");
    }

    if (config.credentials) {
      const supportsPlain = ehlo.lines.some((line) => line.toUpperCase().includes("PLAIN"));
      if (supportsPlain) {
        const token = Buffer.from(
          `\0${config.credentials.username}\0${config.credentials.password}`,
          "utf8",
        ).toString("base64");
        const authResp = await sendCommand(socket, reader, `AUTH PLAIN ${token}`);
        assertExpectedCode(authResp, [235], "AUTH");
      } else {
        const loginStart = await sendCommand(socket, reader, "AUTH LOGIN");
        assertExpectedCode(loginStart, [334], "AUTH");
        const userResp = await sendCommand(
          socket,
          reader,
          Buffer.from(config.credentials.username, "utf8").toString("base64"),
        );
        assertExpectedCode(userResp, [334], "AUTH");
        const passResp = await sendCommand(
          socket,
          reader,
          Buffer.from(config.credentials.password, "utf8").toString("base64"),
        );
        assertExpectedCode(passResp, [235], "AUTH");
      }
    }

    return { socket, reader };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * Creates a standards-compliant Node TCP/TLS SMTP transport without external SaaS lock-in.
 */
export function createNodeSmtpTransport(): SmtpTransportPort {
  return {
    async sendMail(request: SmtpSendRequest): Promise<SmtpSendResult> {
      const cleanFrom = assertNoHeaderInjection(request.fromAddress, "fromAddress");
      const cleanTo = assertNoHeaderInjection(request.toAddress, "toAddress");
      const domainPart = cleanFrom.includes("@")
        ? (cleanFrom.split("@")[1] ?? "docuflow.local")
        : "docuflow.local";
      const messageId = `<${randomUUID()}@${domainPart}>`;
      const mimeData = buildMimePayload(request, messageId);

      let socket: net.Socket | tls.TLSSocket | null = null;
      try {
        const session = await openAndAuthenticateSession({
          host: request.host,
          port: request.port,
          securityMode: request.securityMode,
          timeoutMs: request.timeoutMs,
          credentials: request.credentials,
        });
        socket = session.socket;
        const { reader } = session;

        const mailFromResp = await sendCommand(socket, reader, `MAIL FROM:<${cleanFrom}>`);
        assertExpectedCode(mailFromResp, [250], "MAIL_FROM");

        const rcptToResp = await sendCommand(socket, reader, `RCPT TO:<${cleanTo}>`);
        assertExpectedCode(rcptToResp, [250, 251], "RCPT_TO");

        const dataStartResp = await sendCommand(socket, reader, "DATA");
        assertExpectedCode(dataStartResp, [354], "DATA");

        await new Promise<void>((resolve, reject) => {
          session.socket.write(`${mimeData}\r\n.\r\n`, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
        const dataDoneResp = await reader.readResponse();
        assertExpectedCode(dataDoneResp, [250], "DATA_END");

        try {
          await sendCommand(socket, reader, "QUIT");
        } catch {
          // Ignore server disconnect during polite QUIT after accepted DATA.
        }

        return { messageId };
      } catch (error) {
        const message = sanitizeSmtpErrorMessage(
          error instanceof Error ? error.message : String(error),
          [request.credentials?.password],
        );
        if (error instanceof SmtpTransportError) {
          throw new SmtpTransportError(error.code, message);
        }
        throw new SmtpTransportError("CONNECTION_FAILED", message);
      } finally {
        socket?.destroy();
      }
    },

    async verifyConnection(config): Promise<{ readonly ok: boolean; readonly message: string }> {
      let socket: net.Socket | tls.TLSSocket | null = null;
      try {
        const session = await openAndAuthenticateSession(config);
        socket = session.socket;
        try {
          await sendCommand(socket, session.reader, "QUIT");
        } catch {
          // Ignore disconnect on QUIT.
        }
        return {
          ok: true,
          message: "Conexão SMTP validada com sucesso.",
        };
      } catch (error) {
        return {
          ok: false,
          message: sanitizeSmtpErrorMessage(
            error instanceof Error ? error.message : String(error),
            [config.credentials?.password],
          ),
        };
      } finally {
        socket?.destroy();
      }
    },
  };
}
