import { Callout } from '@/components/ui';

/**
 * Shown when the app boots without Supabase credentials - i.e. someone cloned
 * the repo and ran `npm run dev` before doing MVP Plan Day 0. Better a
 * checklist than a runtime error on a blank screen.
 */
export function SetupRequired() {
  const steps: Array<{ title: string; body: string; code?: string }> = [
    {
      title: 'Create the Supabase project',
      body: 'Then copy the project URL, anon key and service-role key from Project Settings → API.',
    },
    {
      title: 'Fill in the environment file',
      body: 'Copy the example file and set at minimum the four values below.',
      code: `cp .env.example .env.local

NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")`,
    },
    {
      title: 'Create the schema',
      body: 'Run the migrations against the project, then optionally load demo data to see the dashboard populated.',
      code: `npm run db:push        # 11 tables + RLS + default alert rules
npm run db:seed        # optional: 6 months of realistic demo transactions`,
    },
    {
      title: 'Create the first owner',
      body: 'Invite yourself through Supabase Auth, then insert the matching users row with role = owner.',
      code: `insert into users (email, full_name, role)
values ('you@asianhustlenetwork.com', 'Your Name', 'owner');`,
    },
  ];

  return (
    <div className="mx-auto max-w-[720px] px-8 py-16">
      <h1 className="text-[22px] font-semibold tracking-tight">AHN Financial OS — setup</h1>
      <p className="muted mt-2 text-[13.5px] leading-relaxed">
        The app is running but has no database connection yet. Four steps to a working dashboard.
      </p>

      <div className="mt-8 space-y-5">
        {steps.map((step, i) => (
          <div key={step.title} className="card p-5">
            <div className="flex items-baseline gap-3">
              <span
                className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
                style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}
              >
                {i + 1}
              </span>
              <div className="flex-1">
                <p className="text-[14px] font-semibold">{step.title}</p>
                <p className="muted mt-1 text-[13px] leading-relaxed">{step.body}</p>
                {step.code && (
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--surface-sunk)] p-3 text-[11.5px] leading-relaxed">
                    <code>{step.code}</code>
                  </pre>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <Callout tone="brand" title="Integrations come after this">
          QuickBooks, Plaid and Stripe credentials are optional to boot. Add them on the
          Integrations page once you can sign in — the dashboard works on CSV imports and demo
          data without them.
        </Callout>
      </div>
    </div>
  );
}
