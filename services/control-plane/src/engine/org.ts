/**
 * Pure org-hierarchy logic for departments (sub-orgs). Framework/DB-free and
 * unit-tested. A tenant's departments form a forest (roots have parentId=null).
 * Access scoping: a user assigned to a department can see that department and
 * all of its descendants.
 */
export interface OrgNode {
  id: string;
  parentId: string | null;
}

function childrenMap(units: OrgNode[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const u of units) {
    if (!u.parentId) continue;
    const arr = m.get(u.parentId) ?? [];
    arr.push(u.id);
    m.set(u.parentId, arr);
  }
  return m;
}

/** The set of ids in the subtree rooted at `rootId` (inclusive). */
export function descendantIds(units: OrgNode[], rootId: string): Set<string> {
  const children = childrenMap(units);
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue; // guard against cycles in malformed data
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

/**
 * True if setting `nodeId`'s parent to `newParentId` would create a cycle
 * (i.e. newParentId is nodeId itself or one of its descendants).
 */
export function wouldCreateCycle(units: OrgNode[], nodeId: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  if (newParentId === nodeId) return true;
  return descendantIds(units, nodeId).has(newParentId);
}

export interface OrgTreeNode extends OrgNode {
  name: string;
  children: OrgTreeNode[];
}

/** Build a nested tree (roots first) for display. */
export function buildTree(units: { id: string; parentId: string | null; name: string }[]): OrgTreeNode[] {
  const byId = new Map<string, OrgTreeNode>();
  for (const u of units) byId.set(u.id, { ...u, children: [] });
  const roots: OrgTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
