export interface ToolDetailContext {
  category: string;
  categoryLabel: string;
}

export function getToolDetailContext(routeId: string): ToolDetailContext | undefined {
  const normalized = routeId.replace(/\.mdx$/, '').replace(/^\/+|\/+$/g, '');
  const match = /^tools\/([^/]+)\/([^/]+)$/.exec(normalized);
  if (!match) return undefined;

  const category = match[1];
  if (!category) return undefined;

  return {
    category,
    categoryLabel: category.charAt(0).toUpperCase() + category.slice(1).replaceAll('_', ' '),
  };
}
