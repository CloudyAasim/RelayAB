import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Nav } from "@/components/layouts/Nav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { listUsers } from "@/lib/db/users";
import { listAllApiKeys } from "@/lib/db/keys";
import { listProviders } from "@/lib/db/providers";
import { aggregateByDay } from "@/lib/quota/calculator";
import { listUsageByKey } from "@/lib/db/usage";
import { formatCredits, formatNumber } from "@/lib/utils";

export default async function AdminOverview() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const [users, keys, providers] = await Promise.all([
    listUsers({ limit: 200 }),
    listAllApiKeys(),
    listProviders(),
  ]);

  // Aggregate recent usage.
  const recentLogs = (
    await Promise.all(keys.map((k) => listUsageByKey(k.id, { limit: 200 })))
  ).flat();
  const dayBuckets = aggregateByDay(recentLogs, 0);
  const totals = recentLogs.reduce(
    (acc, l) => {
      if (l.status !== "success") return acc;
      acc.tokens += l.totalTokens;
      acc.credits += l.creditsUsed;
      acc.requests += 1;
      return acc;
    },
    { tokens: 0, credits: 0, requests: 0 },
  );

  return (
    <>
      <Nav username={user.username} role={user.role} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Overview</h1>

        <div className="grid gap-4 sm:grid-cols-4 mb-6">
          <Stat label="Users" value={formatNumber(users.users.length)} />
          <Stat label="API Keys" value={formatNumber(keys.length)} />
          <Stat label="Providers" value={formatNumber(providers.length)} />
          <Stat label="Requests" value={formatNumber(totals.requests)} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Daily Usage (Last 7 Days)" />
            {dayBuckets.length === 0 ? (
              <p className="text-sm text-slate-500">No activity yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Requests</TH>
                    <TH>Tokens</TH>
                    <TH>积分</TH>
                  </TR>
                </THead>
                <TBody>
                  {dayBuckets.slice(-7).map((d) => (
                    <TR key={d.day}>
                      <TD>{d.day}</TD>
                      <TD>{formatNumber(d.requests)}</TD>
                      <TD>{formatNumber(d.promptTokens + d.completionTokens)}</TD>
                      <TD>{formatCredits(d.creditsUsed)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Providers" />
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Kind</TH>
                  <TH>Models</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {providers.length === 0 ? (
                  <TR>
                    <TD colSpan={4} className="text-center text-slate-500">
                      No providers configured
                    </TD>
                  </TR>
                ) : (
                  providers.map((p) => (
                    <TR key={p.id}>
                      <TD>{p.name}</TD>
                      <TD><Badge tone="slate">{p.kind}</Badge></TD>
                      <TD>{formatNumber(Object.keys(p.modelMapping).length)}</TD>
                      <TD>
                        {p.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="red">disabled</Badge>}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </Card>
        </div>
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}
