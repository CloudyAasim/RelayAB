import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "@/components/ui/Table";

/**
 * Public license & open-source notices page.
 *
 * - Linked from the site-wide footer.
 * - Public (no auth required) so prospective users / auditors can read it
 *   before signing in.
 * - The project version is intentionally NOT displayed anywhere on this page.
 */
export const metadata = {
  title: "License · RelayAB",
};

interface Dep {
  name: string;
  version: string;
  license: string;
}

const RUNTIME_DEPS: Dep[] = [
  { name: "@ai-sdk/anthropic", version: "1.2.12", license: "Apache-2.0" },
  { name: "@ai-sdk/openai", version: "1.3.24", license: "Apache-2.0" },
  { name: "@emulators/adapter-next", version: "0.11.2", license: "Apache-2.0" },
  { name: "@emulators/core", version: "0.11.2", license: "Apache-2.0" },
  { name: "@emulators/vercel", version: "0.11.2", license: "Apache-2.0" },
  { name: "@upstash/redis", version: "1.38.4", license: "MIT" },
  { name: "@vercel/sdk", version: "1.28.35", license: "Apache-2.0" },
  { name: "ai", version: "4.3.19", license: "Apache-2.0" },
  { name: "bcryptjs", version: "2.4.3", license: "MIT" },
  { name: "clsx", version: "2.1.1", license: "MIT" },
  { name: "iron-session", version: "8.0.4", license: "MIT" },
  { name: "jose", version: "5.10.0", license: "MIT" },
  { name: "lucide-react", version: "0.460.0", license: "ISC" },
  { name: "next", version: "15.5.25", license: "MIT" },
  { name: "react", version: "19.3.0", license: "MIT" },
  { name: "react-dom", version: "19.3.0", license: "MIT" },
  { name: "tailwind-merge", version: "2.6.1", license: "MIT" },
  { name: "zod", version: "3.25.76", license: "MIT" },
];

const DEV_DEPS: Dep[] = [
  { name: "@playwright/test", version: "1.63.0", license: "Apache-2.0" },
  { name: "@tailwindcss/forms", version: "0.5.11", license: "MIT" },
  { name: "@tailwindcss/typography", version: "0.5.20", license: "MIT" },
  { name: "@types/bcryptjs", version: "2.4.6", license: "MIT" },
  { name: "@types/node", version: "22.20.4", license: "MIT" },
  { name: "@types/react", version: "19.3.0", license: "MIT" },
  { name: "@types/react-dom", version: "19.3.0", license: "MIT" },
  { name: "autoprefixer", version: "10.6.1", license: "MIT" },
  { name: "postcss", version: "8.5.28", license: "MIT" },
  { name: "tailwindcss", version: "3.4.19", license: "MIT" },
  { name: "tsx", version: "4.23.13", license: "MIT" },
  { name: "typescript", version: "5.9.3", license: "Apache-2.0" },
  { name: "vitest", version: "2.1.9", license: "MIT" },
];

function DepRows({ rows }: { rows: Dep[] }) {
  return (
    <>
      {rows.map((d) => (
        <TR key={d.name}>
          <TD><code className="text-xs">{d.name}</code></TD>
          <TD><code className="text-xs text-slate-500">{d.version}</code></TD>
          <TD><span className="font-mono text-xs">{d.license}</span></TD>
        </TR>
      ))}
    </>
  );
}

export default function LicensePage() {
  const repoUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim();
  const year = new Date().getFullYear();
  const mitText =
    "MIT License\n\n" +
    "Copyright (c) " + year + " CloudyAasim\n\n" +
    "Permission is hereby granted, free of charge, to any person obtaining a copy\n" +
    "of this software and associated documentation files (the \"Software\"), to deal\n" +
    "in the Software without restriction, including without limitation the rights\n" +
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n" +
    "copies of the Software, and to permit persons to whom the Software is\n" +
    "furnished to do so, subject to the following conditions:\n\n" +
    "The above copyright notice and this permission notice shall be included in all\n" +
    "copies or substantial portions of the Software.\n\n" +
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n" +
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n" +
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n" +
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n" +
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n" +
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n" +
    "SOFTWARE.";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <Link
          href="/"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          &larr; Back
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">
          License & Open-Source Notices
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          RelayAB is released under the MIT License. The third-party components
          listed below retain their respective licenses. License data is read
          from each package&rsquo;s manifest.
        </p>
        {repoUrl ? (
          <p className="mt-3 text-sm">
            Source code:{" "}
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              {repoUrl} &uarr;
            </a>
          </p>
        ) : null}
      </header>

      <Card className="mb-8">
        <CardHeader
          title="MIT License"
          description="The license under which RelayAB is distributed."
        />
        <pre className="whitespace-pre-wrap rounded-md bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800">
{mitText}
        </pre>
      </Card>

      <Card className="mb-8">
        <CardHeader
          title="Runtime Dependencies"
          description="Bundled and shipped with the application."
        />
        <Table>
          <THead>
            <TR>
              <TH>Package</TH>
              <TH>Version</TH>
              <TH>License</TH>
            </TR>
          </THead>
          <TBody>
            <DepRows rows={RUNTIME_DEPS} />
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader
          title="Development Dependencies"
          description="Used at build / test time only."
        />
        <Table>
          <THead>
            <TR>
              <TH>Package</TH>
              <TH>Version</TH>
              <TH>License</TH>
            </TR>
          </THead>
          <TBody>
            <DepRows rows={DEV_DEPS} />
          </TBody>
        </Table>
        <p className="mt-4 text-xs text-slate-500">
          All listed licenses are compatible with the MIT License.
        </p>
      </Card>
    </div>
  );
}
