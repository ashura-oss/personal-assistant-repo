export type WorkspaceSnapshotSchemaNode =
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'string' | 'number' | 'boolean' | 'never' }
  | { readonly kind: 'union'; readonly alternatives: readonly WorkspaceSnapshotSchemaNode[] }
  | { readonly kind: 'array'; readonly element: WorkspaceSnapshotSchemaNode }
  | { readonly kind: 'dictionary'; readonly value: WorkspaceSnapshotSchemaNode }
  | { readonly kind: 'object'; readonly properties: Readonly<Record<string, WorkspaceSnapshotSchemaNode>>; readonly required: readonly string[] };

export interface WorkspaceSnapshotSchemaGraph {
  readonly root: WorkspaceSnapshotSchemaNode;
  readonly definitions: Readonly<Record<string, WorkspaceSnapshotSchemaNode>>;
}
