import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Nav } from "@/components/layouts/Nav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { listUsers } from "@/lib/db/users";
import { formatDate } from "@/lib/utils";
import { CreateUserButton } from "./CreateUserButton";
import { UserActions } from "./UserActions";

export default async function AdminUsersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const { users } = await listUsers({ limit: 200 });

  return (
    <>
      <Nav username={me.username} role={me.role} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader
            title="Users"
            description={`${users.length} user${users.length === 1 ? "" : "s"}`}
            action={<CreateUserButton />}
          />
          {users.length === 0 ? (
            <p className="text-sm text-slate-500">No users yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Username</TH>
                  <TH>Role</TH>
                  <TH>Display Name</TH>
                  <TH>Created</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {users.map((u) => (
                  <TR key={u.id}>
                    <TD><code className="text-xs">{u.username}</code></TD>
                    <TD>
                      <Badge tone={u.role === "admin" ? "purple" : "slate"}>{u.role}</Badge>
                    </TD>
                    <TD>{u.displayName}</TD>
                    <TD>{formatDate(u.createdAt)}</TD>
                    <TD>
                      {u.disabled ? <Badge tone="red">disabled</Badge> : <Badge tone="green">active</Badge>}
                    </TD>
                    <TD>
                      <UserActions userId={u.id} isSelf={u.id === me.id} disabled={u.disabled} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </main>
    </>
  );
}
