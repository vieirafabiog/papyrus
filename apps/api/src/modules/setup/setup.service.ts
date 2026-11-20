import type { PasswordService } from "@docuflow/auth";
import { z } from "zod";

export const bootstrapAdminInputSchema = z.object({
  organizationName: z.string().trim().min(2).max(160).default("DocuFlow"),
  organizationSlug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug deve conter apenas letras minúsculas, números e hífen.")
    .default("default"),
  email: z.string().trim().email().toLowerCase(),
  fullName: z.string().trim().min(2).max(160),
  password: z.string().min(10).max(256),
});

export type BootstrapAdminInput = z.infer<typeof bootstrapAdminInputSchema>;

export interface BootstrapAdminResult {
  readonly organizationId: string;
  readonly adminUserId: string;
  readonly email: string;
  readonly fullName: string;
}

export class BootstrapAlreadyCompletedError extends Error {
  public constructor() {
    super("O administrador inicial já foi configurado.");
    this.name = "BootstrapAlreadyCompletedError";
  }
}

export interface SetupBootstrapRepositoryPort {
  hasAnyActiveAdmin(): Promise<boolean>;
  createInitialAdmin(input: {
    readonly organizationName: string;
    readonly organizationSlug: string;
    readonly email: string;
    readonly fullName: string;
    readonly passwordHash: string;
    readonly requestId: string;
  }): Promise<BootstrapAdminResult>;
}

export interface SetupService {
  getStatus(): Promise<{ readonly initialized: boolean }>;
  bootstrapFirstAdmin(
    rawInput: unknown,
    requestId: string,
  ): Promise<BootstrapAdminResult>;
}

export function createSetupService(deps: {
  readonly repository: SetupBootstrapRepositoryPort;
  readonly passwordService: PasswordService;
}): SetupService {
  return {
    async getStatus(): Promise<{ readonly initialized: boolean }> {
      const hasAdmin = await deps.repository.hasAnyActiveAdmin();
      return { initialized: hasAdmin };
    },

    async bootstrapFirstAdmin(
      rawInput: unknown,
      requestId: string,
    ): Promise<BootstrapAdminResult> {
      const parsed = bootstrapAdminInputSchema.parse(rawInput);

      const alreadyInitialized = await deps.repository.hasAnyActiveAdmin();
      if (alreadyInitialized) {
        throw new BootstrapAlreadyCompletedError();
      }

      const passwordHash = await deps.passwordService.hashPassword(parsed.password);

      return deps.repository.createInitialAdmin({
        organizationName: parsed.organizationName,
        organizationSlug: parsed.organizationSlug,
        email: parsed.email,
        fullName: parsed.fullName,
        passwordHash,
        requestId,
      });
    },
  };
}
