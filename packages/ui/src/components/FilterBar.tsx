import ClearOutlinedIcon from "@mui/icons-material/ClearOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import {
  Box,
  Button,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
} from "@mui/material";
import type { ReactNode } from "react";
import { DOCUFLOW_COLOR_TOKENS } from "../theme/tokens.js";

export interface FilterBarOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterBarSelect {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly FilterBarOption[];
  readonly allOptionLabel?: string;
  readonly onChange: (value: string) => void;
}

export interface FilterBarProps {
  readonly searchValue: string;
  readonly onSearchChange: (value: string) => void;
  readonly searchLabel?: string;
  readonly searchPlaceholder?: string;
  readonly filters?: readonly FilterBarSelect[];
  readonly onClearFilters?: () => void;
  readonly hasActiveFilters?: boolean;
  readonly actions?: ReactNode;
}

export function FilterBar({
  searchValue,
  onSearchChange,
  searchLabel = "Buscar",
  searchPlaceholder = "Digite para pesquisar...",
  filters = [],
  onClearFilters,
  hasActiveFilters = false,
  actions,
}: FilterBarProps) {
  return (
    <Paper
      sx={{
        p: 2,
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={1.5}
        alignItems={{ xs: "stretch", md: "center" }}
        justifyContent="space-between"
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          alignItems={{ xs: "stretch", sm: "center" }}
          flexWrap="wrap"
          sx={{ flex: 1 }}
        >
          <TextField
            label={searchLabel}
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            sx={{ minWidth: { xs: "100%", sm: 260 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchOutlinedIcon fontSize="small" color="action" />
                  </InputAdornment>
                ),
                endAdornment:
                  searchValue.length > 0 ? (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        aria-label="Limpar busca"
                        onClick={() => onSearchChange("")}
                      >
                        <ClearOutlinedIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : undefined,
              },
            }}
          />

          {filters.map((filter) => {
            const labelId = `filter-label-${filter.id}`;
            return (
              <FormControl key={filter.id} size="small" sx={{ minWidth: 180 }}>
                <InputLabel id={labelId}>{filter.label}</InputLabel>
                <Select
                  labelId={labelId}
                  id={`filter-select-${filter.id}`}
                  value={filter.value}
                  label={filter.label}
                  onChange={(event) => filter.onChange(String(event.target.value))}
                >
                  <MenuItem value="">{filter.allOptionLabel ?? "Todos"}</MenuItem>
                  {filter.options.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            );
          })}

          {onClearFilters && hasActiveFilters ? (
            <Button variant="text" onClick={onClearFilters}>
              Limpar filtros
            </Button>
          ) : null}
        </Stack>

        {actions ? <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>{actions}</Box> : null}
      </Stack>
    </Paper>
  );
}
