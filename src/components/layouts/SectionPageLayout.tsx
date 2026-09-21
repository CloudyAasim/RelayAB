/**
 * SectionPageLayout — compound component for individual page layouts.
 *
 * Pattern (borrowed from new-api):
 *   <SectionPageLayout>
 *     <SectionPageLayout.Breadcrumb>…</SectionPageLayout.Breadcrumb>
 *     <SectionPageLayout.Title>我的面板</SectionPageLayout.Title>
 *     <SectionPageLayout.Actions><Button>…</Button></SectionPageLayout.Actions>
 *     <SectionPageLayout.Content>…</SectionPageLayout.Content>
 *   </SectionPageLayout>
 *
 * Splitting the page into named slots keeps every page consistent: a
 * title row at the top, a content row underneath, optional actions
 * aligned right, and optional breadcrumb above the title.
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

type SlotProps = { children?: ReactNode };

function Title(_props: SlotProps): ReactNode { return null; }
Title.displayName = "SectionPageLayout.Title";

function Actions(_props: SlotProps): ReactNode { return null; }
Actions.displayName = "SectionPageLayout.Actions";

function Content(_props: SlotProps): ReactNode { return null; }
Content.displayName = "SectionPageLayout.Content";

function Breadcrumb(_props: SlotProps): ReactNode { return null; }
Breadcrumb.displayName = "SectionPageLayout.Breadcrumb";

export interface SectionPageLayoutProps {
  children: ReactNode;
  /** When true, the content area scrolls independently. Default true. */
  scrollContent?: boolean;
}

export function SectionPageLayout({ children, scrollContent = true }: SectionPageLayoutProps) {
  let title: ReactNode = null;
  let actions: ReactNode = null;
  let content: ReactNode = null;
  let breadcrumb: ReactNode = null;

  Children.forEach(children, (node) => {
    if (!isValidElement(node)) return;
    const child = node as ReactElement<SlotProps>;
    if (child.type === Title) title = child.props.children;
    else if (child.type === Actions) actions = child.props.children;
    else if (child.type === Content) content = child.props.children;
    else if (child.type === Breadcrumb) breadcrumb = child.props.children;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 pb-4">
        {breadcrumb != null && <div className="mb-2">{breadcrumb}</div>}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {actions != null && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      </div>
      <div
        className={
          scrollContent
            ? "min-h-0 flex-1"
            : "min-h-0 flex-1 overflow-hidden"
        }
      >
        {content}
      </div>
    </div>
  );
}

SectionPageLayout.Title = Title;
SectionPageLayout.Actions = Actions;
SectionPageLayout.Content = Content;
SectionPageLayout.Breadcrumb = Breadcrumb;
