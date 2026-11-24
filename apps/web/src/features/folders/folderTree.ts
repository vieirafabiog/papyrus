import { type UiLocale, getCurrentUiLocale } from "../../i18n/index.js";

export interface FolderTreeInput {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string | null | undefined;
}

export interface FolderTreeOption {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly fullPath: string;
  readonly treeLabel: string;
}

function compareByName(a: FolderTreeInput, b: FolderTreeInput, locale: UiLocale): number {
  return a.name.localeCompare(b.name, locale, { sensitivity: "base" });
}

/**
 * Orders a flat list of authorized folders into depth-first hierarchical tree order,
 * preserving sibling alphabetical sorting, computing nesting depth and full path labels,
 * and handling cycles or inaccessible parent folders safely.
 */
export function buildFolderTreeOptions(
  folders: readonly FolderTreeInput[],
  locale: UiLocale = getCurrentUiLocale(),
): readonly FolderTreeOption[] {
  if (folders.length === 0) {
    return [];
  }

  const folderById = new Map<string, FolderTreeInput>();
  for (const folder of folders) {
    folderById.set(folder.id, folder);
  }

  const childrenByParent = new Map<string | null, FolderTreeInput[]>();
  for (const folder of folders) {
    const rawParentId = folder.parentId ?? null;
    const effectiveParentId =
      rawParentId !== null && rawParentId !== folder.id && folderById.has(rawParentId)
        ? rawParentId
        : null;
    const siblings = childrenByParent.get(effectiveParentId) ?? [];
    siblings.push(folder);
    childrenByParent.set(effectiveParentId, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => compareByName(a, b, locale));
  }

  const ordered: FolderTreeOption[] = [];
  const visited = new Set<string>();

  const visit = (node: FolderTreeInput, depth: number, ancestorPath: readonly string[]): void => {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);

    const pathSegments = [...ancestorPath, node.name];
    const fullPath = pathSegments.join(" / ");
    const treeLabel = depth === 0 ? node.name : `${"\u00A0".repeat(depth * 3)}└─ ${node.name}`;

    ordered.push({
      id: node.id,
      name: node.name,
      parentId: node.parentId ?? null,
      depth,
      fullPath,
      treeLabel,
    });

    const children = childrenByParent.get(node.id) ?? [];
    for (const child of children) {
      visit(child, depth + 1, pathSegments);
    }
  };

  const roots = childrenByParent.get(null) ?? [];
  for (const root of roots) {
    visit(root, 0, []);
  }

  // Fallback for any disconnected cycle nodes so no authorized folder is ever dropped.
  const remaining = folders
    .filter((folder) => !visited.has(folder.id))
    .sort((a, b) => compareByName(a, b, locale));
  for (const orphan of remaining) {
    visit(orphan, 0, []);
  }

  return ordered;
}
