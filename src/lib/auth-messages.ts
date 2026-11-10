/**
 * What a person reads when signing in goes wrong.
 *
 * Supabase answers in its own words — "Invalid login credentials", "Token has
 * expired or is invalid", "For security purposes, you can only request this
 * after 47 seconds" — and those were being printed straight onto the sign-in
 * page. They are accurate and nearly useless: none of them says what to do
 * next, and one of them is a countdown with no clock.
 *
 * Two rules shape every message below.
 *
 * SAY WHAT TO DO NEXT. "That email and password do not match" is a fact;
 * adding "check the capitals, then use a sign-in link if you are unsure" is
 * the sentence that ends the problem.
 *
 * NEVER CONFIRM WHETHER AN ADDRESS HAS AN ACCOUNT. A message that says "no
 * account for that email" turns the sign-in form into a tool for finding out
 * who works here, one address at a time. A wrong password and an unknown
 * address therefore read the same, and a magic link requested for an address
 * with no account reports that it was sent.
 *
 * Pure functions over strings: no network, no DOM, and the same answer on the
 * server rendering `?error=` as in the browser catching a rejected promise.
 */

export interface SignInMessage {
  text: string;
  /**
   * True when the person can fix it by trying again now — a typo, a stale
   * link. False when they must wait or ask an administrator.
   */
  retryable: boolean;
}

const WRONG_CREDENTIALS: SignInMessage = {
  // Deliberately covers both "wrong password" and "no such account".
  text: 'That email and password do not match. Check the capitals, or use a sign-in link instead.',
  retryable: true,
};

const LINK_SPENT: SignInMessage = {
  text: 'That sign-in link has expired or has already been used. Ask for a new one below.',
  retryable: true,
};

/**
 * How long until they may ask again, from Supabase's own countdown.
 *
 * It phrases the wait as "after 47 seconds", which reads as an instruction
 * rather than a wait and leaves the reader to guess when it started.
 */
function cooldown(raw: string): SignInMessage | null {
  const seconds = Number(/after (\d+) seconds?/i.exec(raw)?.[1]);
  if (!Number.isFinite(seconds)) return null;
  return {
    text:
      seconds <= 60
        ? `A link was just sent. You can ask for another in ${seconds} second${seconds === 1 ? '' : 's'}.`
        : `A link was just sent. You can ask for another in about ${Math.ceil(seconds / 60)} minutes.`,
    retryable: false,
  };
}

/**
 * Turn whatever the auth service said into something worth reading.
 *
 * Unknown messages are passed through rather than replaced with a generic
 * apology: a message nobody has seen before is more useful verbatim than
 * flattened into "something went wrong", and it is the only clue a support
 * conversation will have.
 */
export function signInMessage(raw: string | null | undefined): SignInMessage | null {
  const message = raw?.trim();
  if (!message) return null;

  const lower = message.toLowerCase();

  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return WRONG_CREDENTIALS;
  }

  // Supabase says this when an email has no account and sign-ups are off,
  // which is every address that is not a colleague's.
  if (lower.includes('signups not allowed') || lower.includes('user not found')) {
    return WRONG_CREDENTIALS;
  }

  if (lower.includes('email not confirmed')) {
    return {
      text: 'This account has not been activated yet. Ask an administrator to confirm it.',
      retryable: false,
    };
  }

  if (lower.includes('token has expired') || lower.includes('otp_expired') || lower.includes('invalid or has expired')) {
    return LINK_SPENT;
  }

  // A link opened in a different browser from the one that asked for it: the
  // code is real, but the verifier that goes with it lives in the other
  // browser's storage. Worth naming, because the person is holding a link
  // that plainly exists and is being told it is invalid.
  if (lower.includes('code verifier') || lower.includes('pkce')) {
    return {
      text: 'Open the link in the same browser you asked for it from, or ask for a new one here.',
      retryable: true,
    };
  }

  const wait = cooldown(message);
  if (wait) return wait;

  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return {
      text: 'Too many attempts. Wait a few minutes before trying again.',
      retryable: false,
    };
  }

  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network request failed')) {
    return { text: 'Could not reach the sign-in service. Check your connection and try again.', retryable: true };
  }

  if (lower.includes('captcha')) {
    return { text: 'The sign-in check failed. Reload the page and try again.', retryable: true };
  }

  return { text: message, retryable: true };
}

/**
 * What to say once a link has been sent.
 *
 * Said the same way whether or not the address has an account — see the second
 * rule at the top of this file — and specific about the two things people ask
 * next: where it went, and how long they have.
 */
export function magicLinkSent(email: string): string {
  const address = email.trim();
  return `If ${address} has an account, a sign-in link is on its way. It opens once, expires after an hour, and may be in spam.`;
}
