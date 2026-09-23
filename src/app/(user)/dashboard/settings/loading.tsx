import { Skeleton } from "@/components/ui/Table";
import { Card, CardHeader } from "@/components/ui/Card";

/**
 * Skeleton loading state for the settings page.
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      {/* Profile section */}
      <Card>
        <CardHeader
          title={<Skeleton className="h-5 w-24" />}
          description={<Skeleton className="h-4 w-48 mt-1" />}
        />
        <div className="space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-10 w-full max-w-md" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-10 w-full max-w-md" />
          </div>
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-20" />
          </div>
        </div>
      </Card>

      {/* Password section */}
      <Card>
        <CardHeader
          title={<Skeleton className="h-5 w-24" />}
          description={<Skeleton className="h-4 w-36 mt-1" />}
        />
        <div className="space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-full max-w-md" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-10 w-full max-w-md" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full max-w-md" />
          </div>
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-9 w-20" />
          </div>
        </div>
      </Card>
    </div>
  );
}
