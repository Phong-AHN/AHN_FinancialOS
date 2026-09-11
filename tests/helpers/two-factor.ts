import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { totp } from './totp';

/**
 * A fully signed-in session — password AND authenticator — for a TEST account.
 *
 * WHY EVERY PERMISSION TEST NEEDS THIS. Since migration 0040 the database
 * refuses every table to a one-factor session. A permission suite that signs in
 * with a password alone would see every table empty — and every assertion of
 * the form "a viewer cannot read X" would pass without testing anything. That
 * is the most dangerous kind of green: a security test that proves nothing and
 * looks like it proves everything.
 *
 * ONLY FOR ACCOUNTS THE TEST OWNS. It deletes the account's existing factors
 * first — their secrets died with the run that created them — and enrols a new
 * one. Pointed at a real person's account it would remove their authenticator,
 * which is why it takes the admin client as an explicit argument rather than
 * finding one for itself.
 */
export async function twoFactorSession(
  admin: SupabaseClient,
  email: string,
  password: string,
): Promise<Session> {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });

  const { data: first, error: signError } = await client.auth.signInWithPassword({ email, password });
  if (signError || !first.user) throw new Error(`sign-in failed for ${email}: ${signError?.message}`);

  const { data: existing } = await admin.auth.admin.mfa.listFactors({ userId: first.user.id });
  for (const factor of existing?.factors ?? []) {
    await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: first.user.id });
  }
  if ((existing?.factors ?? []).length > 0) {
    // Deleting a factor can end sessions that depended on it. Start clean.
    await client.auth.signInWithPassword({ email, password });
  }

  const { data: factor, error: enrollError } = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `test ${Date.now()}`,
  });
  if (enrollError) throw new Error(`enrol failed for ${email}: ${enrollError.message}`);

  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: totp(factor.totp.secret),
  });
  if (verifyError) throw new Error(`verify failed for ${email}: ${verifyError.message}`);

  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error(`no session for ${email} after two-factor sign-in`);

  // Asserted, not assumed: a session that is not aal2 would read nothing and
  // make every denial in the calling suite pass vacuously.
  const aal = JSON.parse(Buffer.from(data.session.access_token.split('.')[1]!, 'base64url').toString()).aal;
  if (aal !== 'aal2') throw new Error(`${email} ended at ${aal}, not aal2`);

  return data.session;
}
