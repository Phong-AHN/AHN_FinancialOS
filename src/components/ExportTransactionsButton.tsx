'use client';

import { useSearchParams } from 'next/navigation';
import { buttonClass } from '@/components/ui';

/**
 * Download the transactions behind this page as a spreadsheet.
 *
 * A plain link, not a fetch-and-blob: the browser streams the response straight
 * to disk, so a large export never has to be held in the tab's memory first,
 * and the download survives navigating away.
 *
 * On a filtered page it carries the filters through, so the file matches what
 * the reader is looking at rather than the whole ledger — that is the point of
 * exporting from a filtered view. `useSearchParams` is why this is a client
 * component; on the home screen there are no filters and it exports everything.
 */
export function ExportTransactionsButton({
  filters,
  label = 'Export CSV',
}: {
  /** Carry the current page's query string through. Defaults to the URL's own. */
  filters?: Record<string, string | undefined>;
  label?: string;
}) {
  const searchParams = useSearchParams();

  const query = new URLSearchParams();
  if (filters) {
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  } else {
    // `page` is pagination, not a filter: exporting page 3 of a filtered list
    // should still export the whole list.
    for (const [key, value] of searchParams.entries()) if (key !== 'page' && value) query.set(key, value);
  }

  const href = `/api/transactions/export${query.size ? `?${query.toString()}` : ''}`;

  return (
    <a
      href={href}
      download
      className={buttonClass()}
      title="Opens in Excel, Numbers or Google Sheets. Amounts are signed numbers, so they can be summed."
    >
      {label}
    </a>
  );
}
