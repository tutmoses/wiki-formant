import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** `h1` when the state is the whole page: a 404, an error, a sign-in wall. */
  as?: 'p' | 'h1';
  className?: string;
}

/**
 * The one rendering of "there is nothing here": a 404, a route error, an empty
 * table, a filtered-out grid. `.empty-state` > the title, `.empty-state-desc`,
 * `.empty-state-action`; `base.css` lays it out and a site gives it its type and
 * colour. A module of its own, with no hooks, so a Server Component and
 * `RouteError` render the same markup.
 */
export function EmptyState({ title, description, action, as = 'p', className }: EmptyStateProps) {
  return (
    <div className={className ? `empty-state ${className}` : 'empty-state'}>
      {as === 'h1' ? <h1>{title}</h1> : <p className="empty-state-title">{title}</p>}
      {description && <div className="empty-state-desc">{description}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
