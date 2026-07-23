import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '@/components/shell/AppShell';

export const metadata: Metadata = {
  title: 'AI Engineering Company',
  description: 'Operate an autonomous multi-agent engineering organization.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Apply the stored theme before first paint. Without this the page
          renders in the OS theme and then snaps to the user's choice — a flash
          that is especially ugly on a dark-mode dashboard.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('aiec-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`,
          }}
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
