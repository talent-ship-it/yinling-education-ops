import type { ReactNode } from "react";

export function AuthStatusScreen({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">吟</div>
        <h1>{title}</h1>
        <p className="login-copy">{detail}</p>
        {children}
      </section>
    </main>
  );
}
