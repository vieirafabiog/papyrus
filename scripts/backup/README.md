# Scripts de Backup do DocuFlow

Este diretório reúne os scripts operacionais de backup de banco e armazenamento local.

## Scripts disponíveis

- `backup-database.sh`: gera dump custom do PostgreSQL (`docuflow-db-<db>-<timestamp>.dump`) com `.sha256`, validação via `pg_restore --list`, política de retenção e logs sem segredos.
- `backup-files.sh`: gera snapshot compactado (`docuflow-files-<timestamp>.tar.gz`) de `STORAGE_LOCAL_ROOT` ou volume Docker `STORAGE_DOCKER_VOLUME`, acompanhado de `.tar.gz.sha256` e manifesto por arquivo `.manifest.sha256`.

## Consistência entre banco e arquivos locais

Para evitar referências no PostgreSQL apontando para objetos inexistentes após restauração:

1. Em instalações com volume local ativo, pause o job/container `worker` de purga física (ou execute na janela fora do agendamento de exclusão definitiva).
2. Execute **primeiro** `./scripts/backup/backup-database.sh`.
3. Execute **imediatamente em seguida** `./scripts/backup/backup-files.sh`.

Justificativa arquitetural: novas versões e uploads finais gravam o objeto binário antes da confirmação final e são append-only; exclusões definitivas só acontecem de forma assíncrona após `DELETE_PENDING`. Capturando o banco antes dos arquivos, toda referência registrada no dump já existia (ou permanece protegida durante a cópia) no volume local.
