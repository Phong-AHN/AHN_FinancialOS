import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { crossOriginRefusal } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
