import type { Metadata } from 'next';
import './globals.css';
import { OpsFrame } from '@/components/shell/OpsFrame';

export const metadata: Metadata = {
  title: 'AI Engineering Company',
  description: 'Operate an autonomous multi-agent engineering organization.',
};

/**
 * The document shell.
 *
 * `overflow-hidden` on the body is deliberate: the workspace is a fixed,
 * viewport-filling world that manages its own panning, and a page-level
 * scrollbar over it would be both wrong and ugly. Routes that are documents
 * rather than worlds get their own scroll container inside `OpsFrame`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Apply the stored theme before first paint. Without this the page
          renders in the OS theme and then snaps to the user's choice — a flash
          that is especially ugly on a dark, full-bleed workspace.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('aiec-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`,
          }}
        />
      </head>
      <body className="overflow-hidden">
        {/* Keyboard users should not have to tab through the dock and the
            instrument cluster to reach the thing they came for. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:border focus:bg-[var(--surface-2)] focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>
        <OpsFrame>{children}</OpsFrame>
      </body>
    </html>
  );
}
