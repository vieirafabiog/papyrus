import type { TagRecord } from "@docuflow/contracts";
import { DataTable, type DataTableColumn, FilterBar } from "@docuflow/ui";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useMemo, useState } from "react";
import { useCreateTagMutation, useTagsQuery } from "./useTagsApi.js";

function formatDatePtBr(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleDateString("pt-BR");
}

/**
 * Organization tags administration and search page wired to the real tags API.
 */
export function TagsPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#00639B");
  const [formError, setFormError] = useState<string | null>(null);

  const tagsQuery = useTagsQuery(search, page, pageSize);
  const createTagMutation = useCreateTagMutation();

  const columns: readonly DataTableColumn<TagRecord>[] = useMemo(
    () => [
      {
        id: "name",
        label: "Etiqueta",
        render: (row) => (
          <Chip
            label={row.name}
            size="small"
            variant="outlined"
            sx={row.color ? { borderColor: row.color } : undefined}
          />
        ),
      },
      {
        id: "normalizedName",
        label: "Identificador normalizado",
        render: (row) => (
          <Typography variant="body2" color="text.secondary">
            {row.normalizedName}
          </Typography>
        ),
      },
      {
        id: "color",
        label: "Cor",
        render: (row) =>
          row.color ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  bgcolor: row.color,
                  border: "1px solid",
                  borderColor: "divider",
                }}
              />
              <Typography variant="body2">{row.color}</Typography>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Padrão
            </Typography>
          ),
      },
      {
        id: "createdAt",
        label: "Criada em",
        render: (row) => <Typography variant="body2">{formatDatePtBr(row.createdAt)}</Typography>,
      },
    ],
    [],
  );

  const handleOpenCreate = () => {
    setFormError(null);
    setTagName("");
    setTagColor("#00639B");
    setCreateOpen(true);
  };

  const handleSubmitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = tagName.trim();
    if (trimmedName.length === 0) {
      setFormError("O nome da etiqueta é obrigatório.");
      return;
    }

    setFormError(null);
    try {
      await createTagMutation.mutateAsync({
        name: trimmedName,
        color: tagColor.trim().length > 0 ? tagColor.trim() : null,
      });
      setCreateOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Não foi possível criar a etiqueta.");
    }
  };

  const rows = tagsQuery.data?.items ?? [];
  const totalItems = tagsQuery.data?.pagination.totalItems ?? 0;

  return (
    <Stack spacing={2.5}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            Etiquetas
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Padronize rótulos transversais para classificar e filtrar documentos da organização.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddOutlinedIcon />} onClick={handleOpenCreate}>
          Nova etiqueta
        </Button>
      </Box>

      <FilterBar
        searchValue={search}
        onSearchChange={(next) => {
          setSearch(next);
          setPage(1);
        }}
        searchLabel="Buscar etiqueta"
        searchPlaceholder="Filtrar por nome..."
        hasActiveFilters={search.trim().length > 0}
        onClearFilters={() => {
          setSearch("");
          setPage(1);
        }}
      />

      <DataTable
        ariaLabel="Tabela de etiquetas da organização"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        page={page}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={setPage}
        onPageSizeChange={(nextSize) => {
          setPageSize(nextSize);
          setPage(1);
        }}
        loading={tagsQuery.isLoading}
        errorMessage={tagsQuery.isError ? tagsQuery.error.message : null}
        onRetry={() => void tagsQuery.refetch()}
        emptyTitle="Nenhuma etiqueta encontrada"
        emptyDescription="Crie uma etiqueta para organizar documentos entre pastas e categorias."
        emptyActionLabel="Nova etiqueta"
        onEmptyAction={handleOpenCreate}
      />

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleSubmitCreate(event)}>
          <DialogTitle>Nova etiqueta</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              {formError ? <Alert severity="error">{formError}</Alert> : null}
              <TextField
                autoFocus
                required
                label="Nome da etiqueta"
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                inputProps={{ maxLength: 64 }}
              />
              <TextField
                label="Cor hexadecimal (opcional)"
                value={tagColor}
                onChange={(event) => setTagColor(event.target.value)}
                helperText="Formato #RRGGBB"
                inputProps={{ maxLength: 7 }}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)} disabled={createTagMutation.isPending}>
              Cancelar
            </Button>
            <Button type="submit" variant="contained" disabled={createTagMutation.isPending}>
              Salvar etiqueta
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
