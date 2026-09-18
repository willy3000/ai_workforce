'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { motion } from 'motion/react';
import { api } from '@/lib/api';
import { allAgentIdentities } from '@/lib/agent-visuals';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { Button, Field, TextInput } from '@/components/ui';

/**
 * The console sign-in.
 *
 * The gateway will not attach the platform's API key without a session, so this
 * is the door to a system that can write to repositories and open pull requests.
 * It is deliberately plain about that, because an operator who does not know
 * what the credential protects will not treat it carefully.
 *
 * The agents are shown asleep: the same standby state the empty workspace uses,
 * so the visual language is consistent from the first screen.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/';

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.signIn(password);
      // `replace` rather than `push`: the sign-in page should not be a back-button
      // destination once the operator is through it.
      router.replace(nextPath.startsWith('/') ? nextPath : '/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setPassword('');
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="ops-field flex min-h-screen items-center justify-center p-5">
      <div className="w-full max-w-md">
        <div className="standby mb-7 flex items-end justify-center gap-3">
          {allAgentIdentities().map((identity, index) => (
            <motion.span
              key={identity.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.06, duration: 0.4 }}
            >
              <AgentAvatar agentKey={identity.key} state="idle" size={40} showMonogram={false} />
            </motion.span>
          ))}
        </div>

        <form onSubmit={submit} className="panel panel-raised p-6">
          <h1 className="text-[16px] font-semibold tracking-tight">AI Engineering Company</h1>
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            This console can read and write your connected repositories and open pull requests on
            your behalf. Sign in to continue.
          </p>

          <div className="mt-5">
            <Field label="Operator password">
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'signin-error' : undefined}
              />
            </Field>
          </div>

          {error && (
            <p
              id="signin-error"
              role="alert"
              className="mt-2 text-[11.5px]"
              style={{ color: 'var(--status-critical)' }}
            >
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" disabled={pending || !password} className="mt-4 w-full">
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="mt-4 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Set <code className="hud">OPERATOR_PASSWORD</code> in the frontend environment to enable
            this. Without it, the console refuses to run in production rather than defaulting open.
          </p>
        </form>
      </div>
    </main>
  );
}
