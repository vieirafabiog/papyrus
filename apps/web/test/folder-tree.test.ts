import { describe, expect, it } from "vitest";
import { buildFolderTreeOptions } from "../src/features/folders/folderTree.js";

describe("buildFolderTreeOptions", () => {
  it("orders folders depth-first under their parent with nesting depth and full path", () => {
    const result = buildFolderTreeOptions([
      { id: "sub-2", name: "Subpasta Z", parentId: "root-a" },
      { id: "root-b", name: "Financeiro", parentId: null },
      { id: "sub-1", name: "Teste de Subpasta", parentId: "root-a" },
      { id: "grandchild", name: "2026", parentId: "sub-1" },
      { id: "root-a", name: "Arquivos pessoais", parentId: null },
    ]);

    expect(
      result.map((item) => ({
        id: item.id,
        depth: item.depth,
        fullPath: item.fullPath,
      })),
    ).toEqual([
      { id: "root-a", depth: 0, fullPath: "Arquivos pessoais" },
      { id: "sub-2", depth: 1, fullPath: "Arquivos pessoais / Subpasta Z" },
      { id: "sub-1", depth: 1, fullPath: "Arquivos pessoais / Teste de Subpasta" },
      { id: "grandchild", depth: 2, fullPath: "Arquivos pessoais / Teste de Subpasta / 2026" },
      { id: "root-b", depth: 0, fullPath: "Financeiro" },
    ]);
  });

  it("handles inaccessible parent folders and cycles without dropping any folder", () => {
    const result = buildFolderTreeOptions([
      { id: "orphan", name: "Pasta Restrita Filha", parentId: "missing-parent" },
      { id: "cyc-a", name: "Ciclo A", parentId: "cyc-b" },
      { id: "cyc-b", name: "Ciclo B", parentId: "cyc-a" },
    ]);

    expect(result.map((item) => item.id)).toEqual(["orphan", "cyc-a", "cyc-b"]);
    expect(result[0]?.depth).toBe(0);
  });
});
