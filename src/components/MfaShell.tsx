import type { ReactNode } from 'react';

/** The frame around both two-factor pages — the sign-in page's layout, so the step reads as part of signing in. */
export function MfaShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 text-center">
          <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
          <p className="muted mt-1.5 text-[13px]">AHN Financial OS</p>
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}
