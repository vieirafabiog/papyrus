import {
  CONTRACTS_API_PREFIX,
  type StartDocumentWorkflowRequest,
  type StartDocumentWorkflowResult,
  type WorkflowDefinitionSummary,
  apiErrorResponseSchema,
  startDocumentWorkflowResponseSchema,
  workflowDefinitionListResponseSchema,
} from "@docuflow/contracts";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { TASK_INBOX_COUNTS_QUERY_KEY } from "../tasks/useTaskInbox.js";
import { documentWorkflowTimelineQueryKey } from "./DocumentWorkflowTimeline.js";
import { documentDetailsQueryKey } from "./useDocumentDetails.js";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return null;
}

async function resolveCsrfToken(): Promise<string> {
  const fromCookie = readCookieValue(CSRF_COOKIE_NAME);
  if (fromCookie) {
    return fromCookie;
  }
  const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return "";
  }
  const json = (await response.json()) as { data?: { csrfToken?: string } };
  return json.data?.csrfToken ?? "";
}

async function fetchWorkflowDefinitions(): Promise<readonly WorkflowDefinitionSummary[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/workflows/definitions`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    let message = `Não foi possível listar fluxos de aprovação (${response.status}).`;
    try {
      const parsed = apiErrorResponseSchema.safeParse(await response.json());
      if (parsed.success) {
        message = parsed.data.error.message;
      }
    } catch {
      // Fallback para mensagem padrão.
    }
    throw new Error(message);
  }
  const parsed = workflowDefinitionListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Resposta inválida recebida ao listar definições de fluxo.");
  }
  return parsed.data.data;
}

export interface StartWorkflowDialogProps {
  readonly open: boolean;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly documentVersionNumber?: number | undefined;
  readonly currentVersionId?: string | null | undefined;
  readonly expectedDocumentVersion: number;
  readonly onClose: () => void;
  readonly onStarted?: ((message: string) => void) | undefined;
}

/**
 * Accessible dialog that submits the current verified document version to an active
 * sequential review and approval workflow.
 */
export function StartWorkflowDialog({
  open,
  documentId,
  documentTitle,
  documentVersionNumber,
  currentVersionId,
  expectedDocumentVersion,
  onClose,
  onStarted,
}: StartWorkflowDialogProps) {
  const titleId = useId();
  const descId = useId();
  const queryClient = useQueryClient();

  const [selectedDefinitionId, setSelectedDefinitionId] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const definitionsQuery = useQuery({
    queryKey: ["workflows", "definitions", "active"],
    queryFn: fetchWorkflowDefinitions,
    enabled: open,
    retry: false,
  });

  const definitions = definitionsQuery.data ?? [];

  useEffect(() => {
    if (open && definitions.length > 0 && selectedDefinitionId.length === 0) {
      const firstDef = definitions[0];
      if (firstDef) {
        setSelectedDefinitionId(firstDef.id);
      }
    }
  }, [open, definitions, selectedDefinitionId]);

  const startMutation = useMutation<StartDocumentWorkflowResult, Error, string>({
    mutationFn: async (workflowDefinitionId: string) => {
      const csrfToken = await resolveCsrfToken();
      const requestBody: StartDocumentWorkflowRequest = {
        workflowDefinitionId,
        ...(currentVersionId ? { documentVersionId: currentVersionId } : {}),
        expectedDocumentVersion,
      };
      const response = await fetch(
        `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/workflows`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
          },
          body: JSON.stringify(requestBody),
        },
      );
      if (!response.ok) {
        let message = `Não foi possível iniciar o fluxo de aprovação (${response.status}).`;
        try {
          const parsedErr = apiErrorResponseSchema.safeParse(await response.json());
          if (parsedErr.success) {
            message = parsedErr.data.error.message;
          }
        } catch {
          // Mantém mensagem padrão.
        }
        throw new Error(message);
      }
      const parsed = startDocumentWorkflowResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("Resposta inválida recebida ao iniciar o fluxo de aprovação.");
      }
      return parsed.data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(documentId) }),
        queryClient.invalidateQueries({ queryKey: documentWorkflowTimelineQueryKey(documentId) }),
        queryClient.invalidateQueries({ queryKey: ["tasks", "inbox"] }),
        queryClient.invalidateQueries({ queryKey: TASK_INBOX_COUNTS_QUERY_KEY }),
      ]);
    },
  });

  const handleClose = (): void => {
    if (startMutation.isPending) {
      return;
    }
    setSubmitError(null);
    onClose();
  };

  const handleConfirm = async (): Promise<void> => {
    if (!selectedDefinitionId) {
      setSubmitError("Selecione um fluxo de aprovação antes de confirmar.");
      return;
    }
    setSubmitError(null);
    try {
      await startMutation.mutateAsync(selectedDefinitionId);
      onStarted?.("Documento enviado para revisão e aprovação.");
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Não foi possível iniciar o fluxo de aprovação.",
      );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      aria-labelledby={titleId}
      aria-describedby={descId}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id={titleId}>Enviar para revisão e aprovação</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <DialogContentText id={descId}>
            O documento "{documentTitle}"
            {documentVersionNumber !== undefined ? ` (versão v${documentVersionNumber})` : ""} será
            bloqueado em revisão até a conclusão das etapas do fluxo selecionado.
          </DialogContentText>

          {definitionsQuery.isLoading ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <span>Carregando fluxos disponíveis...</span>
            </Stack>
          ) : null}

          {definitionsQuery.isError ? (
            <Alert severity="error" role="alert">
              {definitionsQuery.error.message}
            </Alert>
          ) : null}

          {submitError ? (
            <Alert severity="error" role="alert">
              {submitError}
            </Alert>
          ) : null}

          <TextField
            select
            label="Fluxo de aprovação"
            value={selectedDefinitionId}
            onChange={(event) => setSelectedDefinitionId(event.target.value)}
            disabled={
              definitionsQuery.isLoading || startMutation.isPending || definitions.length === 0
            }
            fullWidth
            helperText={
              !definitionsQuery.isLoading && definitions.length === 0
                ? "Nenhum fluxo ativo configurado para esta organização."
                : undefined
            }
          >
            {definitions.map((definition) => (
              <MenuItem key={definition.id} value={definition.id}>
                {definition.name}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={startMutation.isPending}>
          Cancelar
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleConfirm()}
          disabled={
            startMutation.isPending ||
            definitionsQuery.isLoading ||
            selectedDefinitionId.length === 0
          }
        >
          {startMutation.isPending ? "Enviando..." : "Confirmar envio"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
