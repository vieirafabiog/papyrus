import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { useId } from "react";
import { useUiLocale } from "../locale.js";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  readonly confirmColor?: "primary" | "error" | "warning" | undefined;
  readonly loading?: boolean | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmColor = "primary",
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { messages } = useUiLocale();
  const resolvedConfirmLabel = confirmLabel ?? messages.confirmDialog.confirm;
  const resolvedCancelLabel = cancelLabel ?? messages.confirmDialog.cancel;
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Dialog
      open={open}
      onClose={loading ? undefined : onCancel}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId}>{description}</DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onCancel} disabled={loading} variant="text">
          {resolvedCancelLabel}
        </Button>
        <Button onClick={onConfirm} disabled={loading} color={confirmColor} variant="contained">
          {loading ? messages.confirmDialog.processing : resolvedConfirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
