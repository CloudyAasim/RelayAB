/**
 * SectionPageLayout — compound component for individual page layouts.
 *
 * Responsive: title and actions stack on narrow, inline on wider.
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
  scrollContent?: boolean;
}

export function SectionPageLayout({ children, scrollContent = true }: SectionPageLayoutProps) {
  let title: ReactNode = null;
  let actions: ReactNode = null;
  let content: ReactNode = null;
  let breadcrumb: ReactNode = null;
  const dropped: ReactNode[] = [];

  Children.forEach(children, (node) => {
    if (!isValidElement(node)) return;
    const child = node as ReactElement<SlotProps>;
    if (child.type === Title) title = child.props.children;
    else if (child.type === Actions) actions = child.props.children;
    else if (child.type === Content) content = child.props.children;
    else if (child.type === Breadcrumb) breadcrumb = child.props.children;
    else dropped.push(node);
  });

  // A child that is not one of the four slots renders nowhere. That is a
  // silent, total failure: the page shows its title and nothing else, with no
  // error anywhere. It has happened once already, so say something.
  if (dropped.length > 0 && process.env.NODE_ENV !== "production") {
    console.warn(
      `[SectionPageLayout] ${dropped.length} child element(s) are not inside a ` +
        `Title / Actions / Content / Breadcrumb slot and will NOT be rendered. ` +
        `Wrap page content in <SectionPageLayout.Content>.`,
      dropped,
    );
  }

  // A page with no title, breadcrumb or actions renders none of that row. The
  // assistant page does exactly that on purpose - its own top bar carries the
  // name, and a second one above it would be the same screen saying its name
  // twice - but the wrapper and its bottom padding were still being emitted,
  // which measured 16px of dead height on a screen whose whole point is how
  // much of it the conversation gets. (Only the padding: the empty heading has
  // no line box, so it cost nothing on its own.)
  const hasHeader = title != null || breadcrumb != null || actions != null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hasHeader && (
        <div className="pb-3 sm:pb-4">
          {breadcrumb != null && <div className="mb-2">{breadcrumb}</div>}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:gap-x-4">
            <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-lg md:text-xl">
              {title}
            </h2>
            {actions != null && (
              <div className="flex flex-wrap items-center gap-2">
                {actions}
              </div>
            )}
          </div>
        </div>
      )}
      <div className={scrollContent ? "min-h-0 flex-1" : "min-h-0 flex-1 overflow-hidden"}>
        {content}
      </div>
    </div>
  );
}

SectionPageLayout.Title = Title;
SectionPageLayout.Actions = Actions;
SectionPageLayout.Content = Content;
SectionPageLayout.Breadcrumb = Breadcrumb;
