import type { HttpMethod, MethodMismatch, RouteDefinition, RouteMatch, Segment } from './types.js';

interface TreeNode {
  staticChildren: Map<string, TreeNode>;
  paramChild?: { name: string; node: TreeNode };
  catchallChild?: { name: string; node: TreeNode };
  /** Routes terminating at this node, keyed by HTTP method. */
  methods: Map<HttpMethod, RouteDefinition>;
}

function createNode(): TreeNode {
  return { staticChildren: new Map(), methods: new Map() };
}

/**
 * Radix-style route tree. Precedence at every level: static > param > catch-all,
 * with backtracking so `/a/[b]/c` still matches when `/a/x` exists as a static
 * sibling. Precedence is structural — insertion order never matters.
 */
export class Router {
  #root = createNode();

  constructor(routes: RouteDefinition[]) {
    for (const route of routes) this.#insert(route);
  }

  #insert(route: RouteDefinition): void {
    let node = this.#root;
    for (const segment of route.segments) {
      node = childFor(node, segment);
    }
    const existing = node.methods.get(route.method);
    if (existing) {
      throw new Error(
        `Duplicate route: ${route.method} ${route.pattern} defined in both ${existing.file ?? '<unknown>'} and ${route.file ?? '<unknown>'}`,
      );
    }
    node.methods.set(route.method, route);
  }

  /**
   * Match a method+path. Returns the route match, a MethodMismatch (path exists,
   * method doesn't → caller sends 405 with Allow), or null (404).
   * HEAD falls back to a GET route when no explicit head handler exists.
   */
  match(method: string, pathname: string): RouteMatch | MethodMismatch | null {
    const parts = splitPath(pathname);
    if (parts === null) return null;

    const found = matchNode(this.#root, parts, 0, {});
    if (!found) return null;

    const upper = method.toUpperCase() as HttpMethod;
    let route = found.node.methods.get(upper);
    if (!route && upper === 'HEAD') route = found.node.methods.get('GET');
    if (route) return { route, params: found.params };

    return { allowed: allowedMethods(found.node) };
  }
}

export function allowedMethods(node: { methods: Map<HttpMethod, RouteDefinition> }): HttpMethod[] {
  const allowed = new Set<HttpMethod>(node.methods.keys());
  if (allowed.has('GET')) allowed.add('HEAD');
  allowed.add('OPTIONS');
  return [...allowed].sort();
}

function childFor(node: TreeNode, segment: Segment): TreeNode {
  switch (segment.type) {
    case 'static': {
      let child = node.staticChildren.get(segment.value);
      if (!child) {
        child = createNode();
        node.staticChildren.set(segment.value, child);
      }
      return child;
    }
    case 'param': {
      if (!node.paramChild) {
        node.paramChild = { name: segment.name, node: createNode() };
      } else if (node.paramChild.name !== segment.name) {
        throw new Error(
          `Conflicting dynamic segments at the same position: [${node.paramChild.name}] vs [${segment.name}]`,
        );
      }
      return node.paramChild.node;
    }
    case 'catchall': {
      if (!node.catchallChild) {
        node.catchallChild = { name: segment.name, node: createNode() };
      } else if (node.catchallChild.name !== segment.name) {
        throw new Error(
          `Conflicting catch-all segments at the same position: [...${node.catchallChild.name}] vs [...${segment.name}]`,
        );
      }
      return node.catchallChild.node;
    }
  }
}

interface NodeMatch {
  node: TreeNode;
  params: Record<string, string>;
}

function matchNode(
  node: TreeNode,
  parts: string[],
  index: number,
  params: Record<string, string>,
): NodeMatch | null {
  if (index === parts.length) {
    return node.methods.size > 0 ? { node, params } : null;
  }

  const part = parts[index]!;

  const staticChild = node.staticChildren.get(part);
  if (staticChild) {
    const result = matchNode(staticChild, parts, index + 1, params);
    if (result) return result;
  }

  if (node.paramChild) {
    const result = matchNode(node.paramChild.node, parts, index + 1, {
      ...params,
      [node.paramChild.name]: part,
    });
    if (result) return result;
  }

  if (node.catchallChild && node.catchallChild.node.methods.size > 0) {
    return {
      node: node.catchallChild.node,
      params: { ...params, [node.catchallChild.name]: parts.slice(index).join('/') },
    };
  }

  return null;
}

/**
 * Split a pathname into decoded segments. Trailing slashes are ignored
 * (except root). Returns null for undecodable paths (→ 404 rather than 500).
 */
function splitPath(pathname: string): string[] | null {
  let path = pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  if (path === '' || path === '/') return [];
  const raw = path.startsWith('/') ? path.slice(1) : path;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '') continue;
    try {
      parts.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return parts;
}
